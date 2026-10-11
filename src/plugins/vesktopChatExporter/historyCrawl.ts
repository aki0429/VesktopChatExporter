/* SPDX-License-Identifier: GPL-3.0-or-later */
import type { MessageTarget } from "./targets";

export type CrawlMessage = { id: string; };
export type CrawlContainer = { category?: string; id: string; name: string; channels: MessageTarget[]; discover?: boolean; };
export type CatchupProgress = { anchor?: string; before?: string; highWater?: string; };
export type CrawlProgress = {
    before?: string;
    completed?: boolean;
    updatedAt?: string;
    newest?: string;
    catchup?: CatchupProgress;
    [key: string]: unknown;
};
export type CrawlState = Record<string, CrawlProgress>;
export type CrawlReport = { kind: "discovery" | "request" | "storage" | "state" | "cursor"; count: number; status?: number; };
export type CrawlResult = { pages: number; messages: number; errors: number; yielded: boolean; bounded: boolean; busy: boolean; };
export type HistoryCrawlDeps<M extends CrawlMessage = CrawlMessage> = {
    loadState(): Promise<CrawlState>;
    saveState(state: CrawlState): Promise<unknown>;
    getContainers(): CrawlContainer[];
    makeScan(state: CrawlState): (channel: MessageTarget) => boolean;
    discover(container: CrawlContainer, running: () => boolean, scanActive: (channel: MessageTarget) => boolean): Promise<{ channels: MessageTarget[]; issues: unknown[]; }>;
    allowed(container: CrawlContainer, channel: MessageTarget): boolean;
    getPage(channelId: string, cursor: { before?: string; }, allowed: () => boolean): Promise<M[]>;
    savePage(container: CrawlContainer, channel: MessageTarget, messages: M[]): Promise<unknown>;
    running(): boolean;
    manualActive(): boolean;
    report(event: CrawlReport): void;
    wait(ms: number): Promise<unknown>;
    now(): string;
};
export type CrawlLimits = { maxPagesPerRun?: number; maxPagesPerChannel?: number; errorDelayMs?: number; };

const compareIds = (a: string, b: string) => a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0;
const validId = (id: unknown): id is string => typeof id === "string" && /^[1-9]\d{0,19}$/.test(id) && BigInt(id) <= 18446744073709551615n;
const statusOf = (error: unknown): number | undefined => {
    const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown; }; } | undefined;
    const value = e?.status ?? e?.statusCode ?? e?.response?.status;
    return typeof value === "number" && value >= 100 && value <= 599 ? value : undefined;
};

/**
 * Owns checkpoints only: getPage must retain the existing shared pacing/429 queue and
 * invoke its live allowed callback after every queue wait/retry. running includes
 * lifecycle, auth and the history setting; manualActive is deliberately separate.
 * savePage receives at most one ascending page. It must reject failed native writes
 * and tolerate exact-page replay after a state-write failure. pages counts attempts.
 * Legacy before/completed remain the independent older-backfill checkpoint. newest
 * is committed only after catchup { anchor, before, highWater } crosses the anchor.
 * __activeScan is owned by makeScan; __historyScan rotates containers/channels so
 * a bounded cycle never permanently starves targets after its request budget.
 */
export function createHistoryCrawler<M extends CrawlMessage>(deps: HistoryCrawlDeps<M>, limits: CrawlLimits = {}) {
    let active = false;
    const maxRun = Math.max(1, Math.floor(limits.maxPagesPerRun ?? 80));
    const maxChannel = Math.max(2, Math.floor(limits.maxPagesPerChannel ?? 6));
    return {
        async run(): Promise<CrawlResult> {
            const result: CrawlResult = { pages: 0, messages: 0, errors: 0, yielded: false, bounded: false, busy: false };
            if (active) return { ...result, busy: true };
            const running = () => deps.running() && !deps.manualActive();
            if (!running()) { result.yielded = deps.manualActive(); return result; }
            active = true;
            let stage: CrawlReport["kind"] = "state";
            const failure = (error: unknown) => {
                result.errors++;
                const status = statusOf(error);
                deps.report({ kind: stage, count: 1, ...(status === undefined ? {} : { status }) });
            };
            try {
                const state = await deps.loadState();
                if (!running()) { result.yielded = deps.manualActive(); return result; }
                const scanActive = deps.makeScan(state);
                await deps.saveState(state);
                const containers = deps.getContainers();
                const lastContainer = containers.findIndex(c => c.id === state.__historyScan?.before);
                const startContainer = (lastContainer + 1) % Math.max(1, containers.length);
                const orderedContainers = [...containers.slice(startContainer), ...containers.slice(0, startContainer)];
                for (const container of orderedContainers) {
                    if (!running()) break;
                    if (result.pages >= maxRun) { result.bounded = true; break; }
                    stage = "discovery";
                    const discovery = container.discover ? await deps.discover(container, running, scanActive)
                        : { channels: container.channels, issues: [] };
                    if (!running()) break;
                    if (discovery.issues.length) {
                        result.errors += discovery.issues.length;
                        deps.report({ kind: "discovery", count: discovery.issues.length });
                    }
                    const scan = state.__historyScan ?? {};
                    const channelCursors = (scan.channels ?? {}) as Record<string, string>;
                    const lastChannel = discovery.channels.findIndex(c => c.id === channelCursors[container.id]);
                    const startChannel = (lastChannel + 1) % Math.max(1, discovery.channels.length);
                    const channels = [...discovery.channels.slice(startChannel), ...discovery.channels.slice(0, startChannel)];
                    for (const channel of channels) {
                        if (!running()) break;
                        if (result.pages >= maxRun) { result.bounded = true; break; }
                        const allowed = () => running() && deps.allowed(container, channel);
                        if (!allowed()) continue;
                        const key = `${container.id}:${channel.id}`;
                        let progress = state[key] ?? {};
                        const checkpoint = async (next: CrawlProgress, publish = true) => {
                            stage = "state";
                            // Publish only after durable state save succeeds. A failed state save is
                            // retried next cycle; page writers must be idempotent by snowflake range.
                            const previousScan = state.__historyScan ?? {};
                            const historyScan: CrawlProgress = { ...previousScan, before: container.id,
                                channels: { ...(previousScan.channels as Record<string, string> ?? {}), [container.id]: channel.id } };
                            const nextState = publish ? { ...state, [key]: next, __historyScan: historyScan }
                                : { ...state, __historyScan: historyScan };
                            await deps.saveState(nextState);
                            if (publish) state[key] = next;
                            state.__historyScan = historyScan;
                            progress = next;
                        };
                        try {
                            await checkpoint(progress.catchup ? progress
                                : { ...progress, catchup: { anchor: progress.newest ?? progress.before } }, !!state[key]);
                            let channelPages = 0;
                            // Leave a backfill slot even when an offline head gap spans many runs.
                            const headBudget = !progress.completed && progress.before && progress.catchup?.anchor
                                ? Math.ceil(maxChannel / 2) : maxChannel;
                            while (allowed() && result.pages < maxRun && channelPages < headBudget) {
                                const head = progress.catchup;
                                const before = head?.before;
                                stage = "request";
                                result.pages++; channelPages++;
                                const page = await deps.getPage(channel.id, { before }, allowed);
                                if (!allowed()) break;
                                stage = "cursor";
                                if (!Array.isArray(page) || page.some(m => !validId(m?.id))) throw new Error("Invalid message page");
                                const ordered = [...page].sort((a, b) => compareIds(a.id, b.id));
                                const oldest = ordered[0]?.id;
                                if (before && ordered.some(m => compareIds(m.id, before) >= 0)) throw new Error("History cursor did not advance");
                                const selected = head?.anchor ? ordered.filter(m => compareIds(m.id, head.anchor!) > 0) : ordered;
                                if (!allowed()) break;
                                if (selected.length) {
                                    stage = "storage";
                                    await deps.savePage(container, channel, selected);
                                    result.messages += selected.length;
                                }
                                const highWater = head?.highWater ?? ordered.at(-1)?.id;
                                const done = page.length < 100 || !!(head?.anchor && oldest && compareIds(oldest, head.anchor) <= 0);
                                const next: CrawlProgress = { ...progress, updatedAt: deps.now() };
                                if (done) {
                                    if (highWater && (!progress.newest || compareIds(highWater, progress.newest) > 0)) next.newest = highWater;
                                    delete next.catchup;
                                } else next.catchup = { ...head, before: oldest, highWater };
                                // A fresh archive's head walk is also its initial backfill. Resumed
                                // archives keep their pre-existing older cursor completely separate.
                                if (!head?.anchor && !progress.completed) {
                                    next.before = oldest ?? progress.before;
                                    next.completed = done;
                                }
                                await checkpoint(next);
                                if (done) break;
                            }
                            // Unanchored catchup is itself a fresh archive's backfill. Never
                            // walk that same cursor independently while its head is unfinished.
                            while (!progress.completed && progress.before && (!progress.catchup || !!progress.catchup.anchor)
                                && allowed() && result.pages < maxRun && channelPages < maxChannel) {
                                const before = progress.before;
                                stage = "request";
                                result.pages++; channelPages++;
                                const page = await deps.getPage(channel.id, { before }, allowed);
                                if (!allowed()) break;
                                stage = "cursor";
                                if (!Array.isArray(page) || page.some(m => !validId(m?.id))) throw new Error("Invalid message page");
                                const ordered = [...page].sort((a, b) => compareIds(a.id, b.id));
                                const oldest = ordered[0]?.id;
                                if (ordered.some(m => compareIds(m.id, before) >= 0)) throw new Error("History cursor did not advance");
                                if (!allowed()) break;
                                if (ordered.length) {
                                    stage = "storage";
                                    await deps.savePage(container, channel, ordered);
                                    result.messages += ordered.length;
                                }
                                await checkpoint({ ...progress, before: oldest ?? before,
                                    completed: page.length < 100, updatedAt: deps.now() });
                            }
                            if (progress.catchup || result.pages >= maxRun || channelPages >= maxChannel) result.bounded = true;
                        } catch (error) {
                            if (!running()) break;
                            if (!deps.allowed(container, channel)) continue;
                            failure(error);
                            await deps.wait(limits.errorDelayMs ?? 30_000);
                        }
                    }
                }
            } catch (error) {
                if (running()) failure(error);
            } finally {
                result.yielded = deps.manualActive();
                active = false;
            }
            return result;
        }
    };
}

export type HistoryScheduleState = { canSchedule: boolean; enabled: boolean; manualActive: boolean; yielded?: boolean; bounded?: boolean; };
export type HistoryScheduleIntervals = { checkMs?: number; cycleMs?: number; };

/** OFF pauses all I/O, not the readiness heartbeat. Only lifecycle/auth stops it. */
export function nextHistoryDelay(state: HistoryScheduleState, intervals: HistoryScheduleIntervals = {}): number | undefined {
    if (!state.canSchedule) return;
    return !state.enabled || state.manualActive || state.yielded || state.bounded
        ? intervals.checkMs ?? 10_000 : intervals.cycleMs ?? 300_000;
}

export type HistorySchedulerDeps<T> = {
    canSchedule(): boolean;
    enabled(): boolean;
    manualActive(): boolean;
    run(): Promise<unknown>;
    setTimer(fn: () => Promise<void>, ms: number): T;
    clearTimer(handle: T): void;
};

export function createHistoryScheduler<T>(deps: HistorySchedulerDeps<T>, intervals: HistoryScheduleIntervals = {}) {
    let timer: T | undefined;
    let started = false;
    let ticking = false;
    const clear = () => {
        if (timer !== undefined) deps.clearTimer(timer);
        timer = undefined;
    };
    const schedule = (delay: number | undefined) => {
        clear();
        if (started && deps.canSchedule() && delay !== undefined) timer = deps.setTimer(tick, delay);
    };
    async function tick() {
        clear();
        if (!started || !deps.canSchedule() || ticking) return;
        ticking = true;
        let result: { yielded?: boolean; bounded?: boolean; } | undefined;
        try {
            if (deps.enabled() && !deps.manualActive()) result = await deps.run() as typeof result;
        } finally {
            ticking = false;
            schedule(nextHistoryDelay({ canSchedule: deps.canSchedule(), enabled: deps.enabled(),
                manualActive: deps.manualActive(), yielded: result?.yielded, bounded: result?.bounded }, intervals));
        }
    }
    return {
        start(delay = intervals.checkMs ?? 10_000) { started = true; if (!ticking) schedule(delay); },
        stop() { started = false; clear(); },
        tick
    };
}
