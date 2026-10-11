/*
 * Vesktop Chat Exporter - a Vencord/Vesktop user plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Channel, Guild } from "@vencord/discord-types";
import {
    Constants,
    Forms,
    GuildChannelStore,
    JoinedThreadsStore,
    Menu,
    PermissionStore,
    PermissionsBits,
    RestAPI,
    SelectedChannelStore,
    SelectedGuildStore,
    showToast,
    Toasts,
    FluxDispatcher,
    ChannelStore,
    GuildStore,
    UserStore
} from "@webpack/common";

import { discoverGuildTargets, DiscoveryIssue, MessageTarget } from "./targets";
import { createHistoryCrawler, CrawlResult, nextHistoryDelay } from "./historyCrawl";

const Native = VencordNative.pluginHelpers.VesktopChatExporter as PluginNative<typeof import("./native")>;

const DM_CATEGORY = "DMs";
const DM_CHANNEL_TYPES = [1, 3]; // 1 = DM, 3 = GROUP_DM

const settings = definePluginSettings({
    includeAttachments: {
        description: "添付ファイルと埋め込みのURLを出力する",
        type: OptionType.BOOLEAN,
        default: true
    },
    pageDelay: {
        description: "APIページ取得間隔（ミリ秒）。429回避のため500ms以上を推奨",
        type: OptionType.NUMBER,
        default: 750
    },
    adaptivePacing: {
        description: "取得速度を自動調節する（429・失敗時は自動で減速し、成功が続くと徐々に加速。上の間隔を下限として使います）",
        type: OptionType.BOOLEAN,
        default: true
    },
    autoSave: {
        description: "受信したサーバーメッセージを専用フォルダーへ自動追記する（起動中のみ）",
        type: OptionType.BOOLEAN,
        default: true
    },
    saveDmMessages: {
        description: "受信したDM・グループDMを専用フォルダーへ自動追記する",
        type: OptionType.BOOLEAN,
        default: true
    },
    forceHistoryCrawl: {
        description: "起動中、閲覧可能な全チャンネル・スレッドの履歴を古い順で自動収集する（取得は最新側から低速でページ取得）",
        type: OptionType.BOOLEAN,
        default: true
    },
    crawlDms: {
        description: "履歴の自動収集・一括保存にDM・グループDMを含める",
        type: OptionType.BOOLEAN,
        default: true
    },
    blockedGuildIds: {
        description: "ログ収集を停止するサーバーID（カンマ・改行・空白区切り）",
        type: OptionType.STRING,
        default: ""
    },
    blockedChannelIds: {
        description: "ログ収集を停止するチャンネル／DMのID（カンマ・改行・空白区切り）",
        type: OptionType.STRING,
        default: ""
    },
    blocklist: {
        type: OptionType.COMPONENT,
        component: () => <BlocklistSettings />
    }
});

// Ids are stored as free text so they survive copy/paste from Discord or a browser URL.
function parseIdList(value: unknown): string[] {
    return Array.from(new Set(
        String(value ?? "")
            .split(/[\s,;]+/)
            .map(entry => entry.trim())
            .filter(entry => /^\d{17,20}$/.test(entry))
    ));
}

function isLoggingBlocked(guildId?: string | null, channelId?: string | null) {
    if (guildId && parseIdList(settings.store.blockedGuildIds).includes(guildId)) return true;
    if (channelId && parseIdList(settings.store.blockedChannelIds).includes(channelId)) return true;
    return false;
}

function isTargetBlocked(channel: { id: string; guild_id?: string; parent_id?: string; }) {
    return isLoggingBlocked(channel.guild_id, channel.id)
        || (!!channel.parent_id && isLoggingBlocked(channel.guild_id, channel.parent_id));
}

function toggleBlockedId(key: "blockedGuildIds" | "blockedChannelIds", id: string) {
    const list = parseIdList((settings.store as any)[key]);
    const next = list.includes(id) ? list.filter(entry => entry !== id) : [...list, id];
    (settings.store as any)[key] = next.join("\n");
    return next.includes(id);
}

function isDmChannel(channel?: { type?: number; } | null): boolean {
    return !!channel && DM_CHANNEL_TYPES.includes(channel.type as number);
}

function recipientName(user: any): string {
    return user?.global_name || user?.display_name || user?.username || user?.id || "unknown";
}

// Human readable label for any channel: guild channel name, DM partner, or group DM name.
function channelLabel(channel: any): string {
    if (!isDmChannel(channel)) return channel?.name ?? channel?.id ?? "unknown";
    const recipients = channel.rawRecipients?.length ? channel.rawRecipients
        : (channel.recipients ?? []).map((id: string) => UserStore.getUser(id) ?? { id });
    if (channel.type === 3) {
        if (channel.name) return channel.name;
        const names = recipients.map(recipientName).filter(Boolean);
        return names.length ? names.join(", ") : "Group DM";
    }
    const other = recipients[0];
    return other ? recipientName(other) : "DM";
}

function getDmChannels(): Channel[] {
    const store = ChannelStore as any;
    let list: any[] = [];
    try {
        list = store.getSortedPrivateChannels?.() ?? [];
    } catch { /* store not ready yet */ }
    try {
        list = [...list, ...Object.values(store.getMutablePrivateChannels?.() ?? {})];
    } catch { /* ignore */ }
    const resolved = new Map<string, Channel>();
    for (const entry of list) {
        const channel = typeof entry === "string" ? store.getChannel(entry) : entry?.channel ?? entry;
        if (channel?.id) resolved.set(channel.id, channel);
    }
    return [...resolved.values()]
        .filter((channel: any) => isDmChannel(channel) && !isLoggingBlocked(undefined, channel.id))
        .sort((a: any, b: any) => String(channelLabel(a)).localeCompare(String(channelLabel(b)), "ja"));
}

function BlocklistSettings() {
    const s = settings.use(["blockedGuildIds", "blockedChannelIds"]);
    const guilds = parseIdList(s.blockedGuildIds);
    const channels = parseIdList(s.blockedChannelIds);
    const selectedGuild = SelectedGuildStore?.getGuildId?.();
    const selectedChannel = SelectedChannelStore?.getChannelId?.();
    const toggle = (key: "blockedGuildIds" | "blockedChannelIds", id?: string | null) => {
        if (!id) return;
        const blocked = toggleBlockedId(key, id);
        showToast(blocked ? "ログ収集を停止しました" : "ログ収集を再開しました", blocked ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS);
    };
    return <div style={{ display: "grid", gap: "10px", marginTop: "6px" }}>
        <Forms.FormText>
            ここに追加したサーバー／チャンネル／DMでは、自動保存・履歴収集・一括保存・通話録画を行いません（Vesktop Consent Recorder と共通）。
        </Forms.FormText>
        <div style={{ display: "grid", gap: "4px" }}>
            <b>停止するサーバーID（{guilds.length}件）</b>
            <textarea
                value={s.blockedGuildIds ?? ""}
                onChange={e => { (settings.store as any).blockedGuildIds = e.target.value; }}
                rows={3}
                spellCheck={false}
                placeholder={"123456789012345678\n987654321098765432"}
                style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
            />
            <button type="button" disabled={!selectedGuild} onClick={() => toggle("blockedGuildIds", selectedGuild)}>
                {selectedGuild && guilds.includes(selectedGuild) ? "現在のサーバーのログ収集を再開" : "現在のサーバーのログ収集を停止"}
            </button>
        </div>
        <div style={{ display: "grid", gap: "4px" }}>
            <b>停止するチャンネル／DMのID（{channels.length}件）</b>
            <textarea
                value={s.blockedChannelIds ?? ""}
                onChange={e => { (settings.store as any).blockedChannelIds = e.target.value; }}
                rows={3}
                spellCheck={false}
                placeholder={"123456789012345678"}
                style={{ width: "100%", resize: "vertical", fontFamily: "monospace" }}
            />
            <button type="button" disabled={!selectedChannel} onClick={() => toggle("blockedChannelIds", selectedChannel)}>
                {selectedChannel && channels.includes(selectedChannel) ? "現在のチャンネル／DMのログ収集を再開" : "現在のチャンネル／DMのログ収集を停止"}
            </button>
        </div>
    </div>;
}

type RawMessage = {
    id: string;
    timestamp: string;
    edited_timestamp?: string | null;
    content?: string;
    author?: { id: string; username: string; global_name?: string | null; discriminator?: string; bot?: boolean; };
    attachments?: Array<{ filename: string; url: string; size?: number; content_type?: string; }>;
    embeds?: Array<{ title?: string; description?: string; url?: string; fields?: Array<{ name?: string; value?: string; }>; footer?: { text?: string; }; author?: { name?: string; }; }>;
    sticker_items?: Array<{ name?: string; id?: string; }>;
    components?: any[];
    poll?: any;
    referenced_message?: RawMessage | null;
};

// A crawl/export target: either a guild (all viewable text channels) or a single DM.
type Container = { category?: string; id: string; name: string; channels: MessageTarget[]; discover?: boolean; };

type ExportChannel = { channel: MessageTarget; messages: RawMessage[]; error?: string; };
let exporting = false;
let cancelled = false;
let subscribed = false;
let crawlRunning = false;
let crawlStopped = false;
let crawlTimer: ReturnType<typeof setTimeout> | undefined;
let crawlGeneration = 0;
let activeCrawlGeneration = 0;
let requestCount = 0;
let adaptiveDelay = 1000;
const savedLiveIds = new Set<string>();
const liveInFlight = new Set<string>();
// Adaptive pacing: the configured interval is the floor. The controller slows down on 429s and
// request failures, then speeds back up after a run of successes so a full history crawl finds a
// rate the account can sustain instead of hammering Discord at a fixed speed.
const DELAY_FLOOR = 500;
const DELAY_CEILING = 10_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function baseDelay() {
    return Math.max(DELAY_FLOOR, settings.store.pageDelay || 1000);
}

// Pure pacing decision so it can be unit tested. Never returns less than the floor.
export function nextDelay(current: number, event: "ok" | "throttled" | "error", floor = DELAY_FLOOR, ceiling = DELAY_CEILING) {
    if (event === "throttled") return Math.min(ceiling, Math.max(current * 2, 2_000));
    if (event === "error") return Math.min(ceiling, Math.max(current * 1.5, floor));
    return Math.max(floor, current - Math.max(50, Math.round(current * 0.1)));
}

function pacedDelay() {
    if (!settings.store.adaptivePacing) return baseDelay();
    adaptiveDelay = Math.min(DELAY_CEILING, Math.max(baseDelay(), adaptiveDelay));
    return adaptiveDelay;
}
const safeName = (value: string) => value.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "server";
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function getGuildParents(guildId: string): Channel[] {
    const groups = GuildChannelStore.getChannels(guildId);
    if (!groups) return [];

    const seen = new Set<string>();
    return Object.values(groups)
        .flatMap((group: any) => Array.isArray(group) ? group : [])
        .map((entry: any) => entry.channel ?? entry)
        .filter((channel: Channel & { type: number; }) => {
            if (!channel?.id || seen.has(channel.id)) return false;
            seen.add(channel.id);
            // Text, announcement, forum/media and voice/stage text channels. Voice and stage
            // channels carry their own text chat and belong to "全チャンネルのログを保存".
            // Inclusion stays VIEW_CHANNEL based (like the previous release): a channel the account
            // can view is always attempted, and a history-permission failure is reported instead of
            // silently hiding the channel from the export.
            return [0, 2, 5, 13, 15, 16].includes(channel.type)
                && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)
                && !isLoggingBlocked(guildId, channel.id);
        })
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
}

// Active threads that are neither joined nor archived are only enumerable per channel:
// the guild-level route is bot-only, so every parent is scanned via the channel search
// route instead. Forums and media parents are scanned every cycle; text and announcement
// parents rotate through a bounded window so one discovery cycle cannot starve crawling.
const ACTIVE_SCAN_WINDOW = 80;

function buildActiveScan(state: Record<string, { before?: string; }>): (parent: MessageTarget) => boolean {
    const rotatable: string[] = [];
    const scanned = new Set<string>();
    for (const guild of Object.values(GuildStore.getGuilds()) as Guild[]) {
        if (isLoggingBlocked(guild.id)) continue;
        for (const parent of getGuildParents(guild.id)) {
            if (parent.type === 15 || parent.type === 16) scanned.add(parent.id);
            else rotatable.push(parent.id);
        }
    }
    const length = rotatable.length;
    const parsed = Number(state.__activeScan?.before ?? "0");
    const cursor = length && Number.isInteger(parsed) && parsed >= 0 ? parsed % length : 0;
    for (let i = 0; i < length && i < ACTIVE_SCAN_WINDOW; i++) scanned.add(rotatable[(cursor + i) % length]);
    const next = length ? (cursor + Math.min(length, ACTIVE_SCAN_WINDOW)) % length : 0;
    state.__activeScan = { before: String(next) };
    return parent => scanned.has(parent.id);
}

function canReadTarget(target: MessageTarget): boolean {
    if (isDmChannel(target)) return true;
    const isThread = [10, 11, 12].includes(target.type);
    const parent = isThread && target.parent_id ? ChannelStore.getChannel(target.parent_id) : undefined;
    if (isThread && !parent) return false;
    const channel = ChannelStore.getChannel(target.id) ?? parent;
    const readable = (c: Channel | undefined) => !!c
        && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, c);
    if (!readable(channel) || (parent && !readable(parent))) return false;
    // Parent visibility (or a prior successful GET) does not grant private membership.
    // Re-read live state at every request/save check; unknown membership fails closed.
    return target.type !== 12 || !!parent && (
        PermissionStore.can(PermissionsBits.MANAGE_THREADS, parent)
        || JoinedThreadsStore?.hasJoined?.(target.id) === true
    );
}

async function collectGuildTargets(guildId: string, running: () => boolean, scanActive: (parent: MessageTarget) => boolean) {
    const parents = getGuildParents(guildId);
    return discoverGuildTargets({
        guildId, parents,
        cachedThreads: ChannelStore.getAllThreadsForGuild?.(guildId) ?? [],
        scanActive,
        canRead: canReadTarget,
        isBlocked: target => isLoggingBlocked(guildId) || isTargetBlocked(target),
        canManage: parent => {
            const channel = ChannelStore.getChannel(parent.id);
            return !!channel && PermissionStore.can(PermissionsBits.MANAGE_THREADS, channel);
        },
        isStopped: () => !running() || pluginStopped || authFailed || isLoggingBlocked(guildId),
        get: (url, query) => queuedGet(url, query, () => {
            if (!running() || isLoggingBlocked(guildId)) return false;
            const parentId = /^\/channels\/(\d+)\//.exec(url)?.[1];
            const parent = parentId ? ChannelStore.getChannel(parentId) : undefined;
            if (parentId && (!parent || isTargetBlocked(parent) || !canReadTarget(parent))) return false;
            if (parent && url.endsWith("/threads/archived/private") && !url.includes("/users/@me/")
                && !PermissionStore.can(PermissionsBits.MANAGE_THREADS, parent)) return false;
            return parentId ? true : parents.some(p => !isTargetBlocked(p) && canReadTarget(p));
        })
    });
}

function issueText(issues: DiscoveryIssue[]) {
    // Request scopes contain channel IDs. They are diagnostic-only and never belong in an
    // archive whose permission checks may have removed that channel after discovery.
    return issues.map(issue => `Thread discovery: ${issue.message}${issue.status ? ` (HTTP ${issue.status})` : ""}`).join("\n");
}

// Snowflake ids order messages by time; compare them as numbers instead of trusting the API order.
function compareIds(left: string, right: string) {
    const numeric = /^\d{17,20}$/;
    if (numeric.test(left) && numeric.test(right) && left.length !== right.length)
        return left.length < right.length ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

// Walks a channel's history page by page, newest -> oldest, handing each page to the caller while it
// is the only page in memory: a channel with hundreds of thousands of messages never has to fit in
// RAM and every page is on disk before the next request goes out. The cursor must move back every
// round; a page that does not move it stops the loop instead of spinning.
async function walkChannelHistory(channel: MessageTarget, allowed: () => boolean, onPage: (page: RawMessage[]) => Promise<void>, initialBefore?: string) {
    let before = initialBefore;
    for (;;) {
        if (cancelled || pluginStopped || authFailed) return false;
        const page = await getMessagePage(channel.id, { before }, () => !cancelled && allowed());
        if (!page.length) return true;
        // Re-check after the response: a channel whose access was revoked while the request was in
        // flight must never reach storage.
        if (!allowed()) throw new Error("閲覧権限が取り消されたため中止しました");
        const ordered = [...page].sort((left, right) => compareIds(left.id, right.id));
        const oldest = ordered[0].id;
        if (new Set(ordered.map(message => message.id)).size !== ordered.length
            || before && compareIds(ordered[ordered.length - 1].id, before) >= 0) throw new Error("履歴カーソルが進みません");
        await onPage(ordered);
        before = oldest;
        if (page.length < 100) return true;
    }
}

function statusOf(error: any) {
    return error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.body?.code;
}

function retryAfterMs(error: any) {
    const raw = error?.body?.retry_after ?? error?.response?.body?.retry_after ?? error?.retry_after;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 60_000;
    return Math.max(5_000, Math.ceil(raw * 1000));
}

// The channel thread-search endpoint answers 202 with a not-indexed notice
// (code 110000 and retry_after in seconds) until the channel is indexed.
function indexPendingFor(body: unknown): number | undefined {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const candidate = body as { threads?: unknown; code?: unknown; retry_after?: unknown; };
    if (Array.isArray(candidate.threads) || candidate.code !== 110000) return;
    const retryAfter = candidate.retry_after;
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
}

// Discovery, manual export and background history share a single request queue.
// Keeping the 429 sleep inside this queue also respects global rate limits.
let requestQueue: Promise<unknown> = Promise.resolve();
let authFailed = false;
let pluginStopped = false;

function queuedGet(url: string, query: Record<string, string | number | boolean> | undefined, allowed: () => boolean): Promise<unknown> {
    const run = async () => {
        const check = () => {
            if (pluginStopped || authFailed || !allowed()) throw new Error("収集を中止しました");
        };
        let indexRetried = false;
        let transientRetries = 0;
        for (;;) {
            check();
            await sleep(pacedDelay());
            if (requestCount > 0 && requestCount % 10 === 0) await sleep(5_000);
            check();
            requestCount++;
            try {
                const response = await RestAPI.get({ url, query, retries: 0 });
                check();
                const pending = indexRetried || !url.endsWith("/threads/search") ? undefined : indexPendingFor(response?.body);
                if (pending !== undefined) {
                    // One retry within this queue slot keeps global pacing and cancellation intact.
                    indexRetried = true;
                    await sleep(Math.min(15_000, Math.max(1_000, Math.ceil(pending * 1000))));
                    continue;
                }
                adaptiveDelay = nextDelay(adaptiveDelay, "ok", baseDelay());
                return response?.body;
            } catch (error) {
                if (statusOf(error) === 401) {
                    authFailed = true;
                    showToast("認証エラー: ログ取得を停止しました。再ログイン後にプラグインを再起動してください", Toasts.Type.FAILURE);
                }
                if (statusOf(error) !== 429) {
                    // Any other failure slows the pace too, exactly as the setting promises.
                    adaptiveDelay = nextDelay(adaptiveDelay, "error", baseDelay());
                    const status = statusOf(error);
                    if (typeof status === "number" && status >= 500 && status <= 599 && transientRetries < 2) {
                        check();
                        transientRetries++;
                        await sleep(Math.min(DELAY_CEILING, 2_000 * transientRetries));
                        continue;
                    }
                    throw error;
                }
                const wait = retryAfterMs(error);
                adaptiveDelay = nextDelay(adaptiveDelay, "throttled", baseDelay());
                showToast(`429: ${Math.ceil(wait / 1000)}秒以上、すべてのログ取得を待機`, Toasts.Type.FAILURE);
                // Slice very long waits to avoid setTimeout's signed-32-bit limit.
                let remaining = wait + 2_000;
                while (remaining > 0) {
                    const interval = Math.min(remaining, 60_000);
                    await sleep(interval);
                    remaining -= interval;
                    // A cancelled caller must not release other jobs before cooldown.
                }
            }
        }
    };
    const result = requestQueue.then(run);
    requestQueue = result.catch(() => {});
    return result;
}

async function getMessagePage(channelId: string, cursor: { before?: string; after?: string; }, allowed: () => boolean): Promise<RawMessage[]> {
    const query = { limit: 100, ...(cursor.before ? { before: cursor.before } : {}), ...(cursor.after ? { after: cursor.after } : {}) };
    const body = await queuedGet(Constants.Endpoints.MESSAGES(channelId), query, allowed);
    if (!Array.isArray(body) || body.some(m => !m || !/^\d{17,20}$/.test(m.id)))
        throw new Error("不正なメッセージ応答");
    return body;
}

// A gateway message normally carries an ISO timestamp. When it is missing, derive the time from
// the snowflake instead of recording the save time, which would mislabel the message.
function messageTimestamp(message: { id?: string; timestamp?: string; }) {
    if (message.timestamp) return message.timestamp;
    if (message.id && /^\d{17,20}$/.test(message.id)) {
        try { return new Date(Number((BigInt(message.id) >> 22n) + 1420070400000n)).toISOString(); }
        catch { /* fall through to the save time */ }
    }
    return new Date().toISOString();
}

function toHistoryMessage(message: RawMessage, container: Container, channel: MessageTarget) {
    return {
        guildId: container.id,
        guildName: container.name,
        channelId: channel.id,
        channelName: channelLabel(channel),
        messageId: message.id,
        timestamp: messageTimestamp(message),
        author: message.author?.global_name || message.author?.username || "Unknown",
        authorId: message.author?.id || "unknown",
        content: richContent(message),
        attachments: (message.attachments ?? []).map(a => ({ filename: a.filename, url: a.url }))
    };
}

function buildContainers(): Container[] {
    const containers: Container[] = [];

    for (const guild of Object.values(GuildStore.getGuilds()) as Guild[]) {
        if (isLoggingBlocked(guild.id)) continue;
        const channels = getGuildParents(guild.id);
        if (channels.length) containers.push({ id: guild.id, name: guild.name, channels, discover: true });
    }

    if (settings.store.crawlDms) {
        for (const channel of getDmChannels()) {
            containers.push({ category: DM_CATEGORY, id: channel.id, name: channelLabel(channel), channels: [channel] });
        }
    }

    return containers;
}

const historyCrawler = createHistoryCrawler<RawMessage>({
    loadState: () => Native.loadCrawlState(),
    saveState: state => Native.saveCrawlState(state),
    getContainers: buildContainers,
    makeScan: buildActiveScan,
    discover: (container, running, scan) => collectGuildTargets(container.id, running, scan),
    allowed: (container, channel) => (!container.category || settings.store.crawlDms)
        && !isTargetBlocked(channel) && canReadTarget(channel),
    getPage: getMessagePage,
    savePage: async (container, channel, messages) => {
        const saved = await Native.saveHistoryPage(container.category, container.id, container.name, channel.id,
            channelLabel(channel), messages.map(message => toHistoryMessage(message, container, channel)));
        if (!saved || saved.count !== messages.length) throw new Error("History storage did not confirm the page");
    },
    running: () => activeCrawlGeneration === crawlGeneration && !crawlStopped && !pluginStopped && !authFailed && settings.store.forceHistoryCrawl,
    manualActive: () => exporting,
    report: event => {
        console.warn("[VesktopChatExporter] history incomplete", event.kind, event.count, event.status ?? "unknown");
        showToast(`自動履歴収集: ${event.count}件を取得できず不完全です`, Toasts.Type.FAILURE);
    },
    wait: sleep,
    now: () => new Date().toISOString()
});

async function crawlAllHistory() {
    if (crawlRunning) {
        if (!pluginStopped && !authFailed && activeCrawlGeneration !== crawlGeneration) {
            if (crawlTimer) clearTimeout(crawlTimer);
            crawlTimer = setTimeout(crawlAllHistory, 10_000);
        }
        return;
    }
    if (crawlTimer) clearTimeout(crawlTimer);
    crawlTimer = undefined;
    crawlRunning = true;
    const generation = crawlGeneration;
    activeCrawlGeneration = generation;
    let result: CrawlResult | undefined;
    try {
        if (!pluginStopped && !authFailed) result = await historyCrawler.run();
    } finally {
        crawlRunning = false;
        if (generation !== crawlGeneration) return;
        const delay = nextHistoryDelay({ canSchedule: !crawlStopped && !pluginStopped && !authFailed,
            enabled: settings.store.forceHistoryCrawl, manualActive: exporting, yielded: result?.yielded, bounded: result?.bounded });
        if (delay !== undefined) crawlTimer = setTimeout(crawlAllHistory, delay);
    }
}

function componentText(components: any[] = []): string[] {
    const result: string[] = [];
    for (const component of components) {
        if (component?.label) result.push(`[ボタン] ${component.label}`);
        if (component?.placeholder) result.push(`[選択欄] ${component.placeholder}`);
        if (component?.value) result.push(String(component.value));
        if (component?.components) result.push(...componentText(component.components));
    }
    return result;
}

function richContent(message: RawMessage): string {
    const lines: string[] = [];
    if (message.content) lines.push(message.content);
    for (const embed of message.embeds ?? []) {
        if (embed.author?.name) lines.push(`[埋め込み投稿者] ${embed.author.name}`);
        if (embed.title) lines.push(`[埋め込みタイトル] ${embed.title}`);
        if (embed.description) lines.push(embed.description);
        for (const field of embed.fields ?? []) lines.push(`${field.name ?? "項目"}: ${field.value ?? ""}`);
        if (embed.footer?.text) lines.push(`[フッター] ${embed.footer.text}`);
        if (embed.url) lines.push(`[埋め込みURL] ${embed.url}`);
    }
    for (const sticker of message.sticker_items ?? []) lines.push(`[スタンプ] ${sticker.name ?? sticker.id ?? "unknown"}`);
    lines.push(...componentText(message.components));
    if (message.poll?.question?.text) {
        lines.push(`[投票] ${message.poll.question.text}`);
        for (const answer of message.poll.answers ?? []) lines.push(`- ${answer.poll_media?.text ?? "選択肢"}`);
    }
    if (!lines.length) lines.push("[本文なし：Discordのシステムメッセージまたは取得非対応形式]");
    return lines.join("\n");
}

// Streaming export helpers. The aggregate files are opened up front and then filled page by page
// from the per-page JSON files on disk, so memory stays flat no matter how large the server is and
// a crash keeps every page already written. The per-page .jsonl files are the canonical,
// re-parseable record and the .manifest.json file describes the run.
const EXPORT_CSS = `*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif}.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}aside{position:sticky;top:0;height:100vh;overflow:auto;background:#2b2d31;padding:20px}aside h1{font-size:18px}aside a{display:block;color:#b5bac1;text-decoration:none;padding:7px;border-radius:5px}aside a:hover{background:#35373c;color:#fff}main{max-width:1000px;padding:28px 40px}section{margin-bottom:55px}h2{border-bottom:1px solid #3f4147;padding-bottom:12px}article{padding:10px 12px;border-radius:5px}article:hover{background:#2b2d31}.meta{display:flex;gap:10px;align-items:baseline}.meta b{color:#fff}.meta span,.meta code{font-size:11px;color:#949ba4}.content{white-space:normal;margin-top:4px;line-height:1.5}.attachment{display:block;color:#00a8fc;margin-top:5px}.error{color:#f23f42}@media(max-width:700px){.layout{display:block}aside{position:relative;height:auto}main{padding:18px}}`;

function exportTxtHeader(title: string, targetId: string, channels: MessageTarget[]) {
    return `Discord chat export\nTarget: ${title}\nTarget ID: ${targetId}\nExported: ${new Date().toISOString()}\nChannels: ${channels.length}\n`;
}

function exportTxtFooter(total: number, savedChannels: number, notice: string) {
    return `${notice ? `INCOMPLETE: ${notice}\n` : ""}Messages: ${total}\nSaved channels: ${savedChannels}\n`;
}

function channelTxtHeader(channel: MessageTarget) {
    return `\n\n${"=".repeat(72)}\n# ${channelLabel(channel)} (${channel.id})\n${"=".repeat(72)}\n`;
}

// The aggregate is assembled from the records that were actually written to disk, so what a run
// reports is exactly what it stored. Each record carries the rendered content (embeds, stickers,
// polls and components included) plus attachment names and URLs.
type StoredMessage = {
    messageId: string;
    timestamp: string;
    author: string;
    authorId: string;
    content: string;
    attachments?: { filename: string; url: string; }[];
};

function storedMessageText(message: StoredMessage) {
    const lines = [`[${message.timestamp}] ${message.author} (${message.authorId})`, message.content];
    if (settings.store.includeAttachments)
        for (const file of message.attachments ?? []) lines.push(`[添付] ${file.filename}: ${file.url}`);
    return lines.join("\n");
}

function messagesTxtFragment(messages: StoredMessage[]) {
    return `${messages.map(storedMessageText).join("\n\n")}\n`;
}

function storedArticleHtml(message: StoredMessage) {
    const attachments = settings.store.includeAttachments ? (message.attachments ?? []).map(a => `<a class="attachment" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(a.filename)}</a>`).join("") : "";
    return `<article><div class="meta"><b>${escapeHtml(message.author)}</b><span>${escapeHtml(message.timestamp)}</span><code>${message.messageId}</code></div><div class="content">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>${attachments}</article>`;
}

function exportHtmlHeader(title: string, targetId: string, channels: MessageTarget[]) {
    const nav = channels.map(channel => `<a href="#c-${channel.id}"># ${escapeHtml(channelLabel(channel))}</a>`).join("");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} Chat Export</title><style>${EXPORT_CSS}</style></head><body><div class="layout"><aside><h1>${escapeHtml(title)}</h1>${nav}</aside><main><h1>${escapeHtml(title)} — Chat Export</h1><p>Exported: ${escapeHtml(new Date().toISOString())}</p><p>Target ID: ${escapeHtml(targetId)}</p>\n`;
}

function channelHtmlHeader(channel: MessageTarget) {
    return `<section id="c-${channel.id}"><h2># ${escapeHtml(channelLabel(channel))}</h2>`;
}

function messagesHtmlFragment(messages: StoredMessage[]) {
    return messages.map(storedArticleHtml).join("\n");
}

function exportHtmlFooter(total: number, savedChannels: number, notice: string) {
    return `${notice ? `<p class="error">INCOMPLETE: ${escapeHtml(notice)}</p>` : ""}<p>Messages: ${total} / Channels: ${savedChannels}</p></main></div></body></html>`;
}

async function exportChannels(container: Container, label: string) {
    if (exporting) return showToast("既にエクスポート中です", Toasts.Type.MESSAGE);
    exporting = true; cancelled = false;
    let total = 0, savedChannels = 0;
    type Progress = { channel: MessageTarget; pages: string[]; before?: string; completed?: boolean; messages: number; };
    let base = "";
    let progress: Progress[] = [];
    const pendingPurges = new Set<string>();
    let manifest: { tool: string; version: number; started: string; target: string; targetId: string; discovered: number; };
    let fetched = 0, revoked = 0;
    const checkpoint = async (phase: string, outcome = "running") => {
        if (base) await Native.checkpointExport(container.category, base, JSON.stringify({ ...manifest, phase, outcome, fetched, revoked, progress }));
    };
    const scrubProgress = async () => {
        const removed = progress.filter(entry => isTargetBlocked(entry.channel) || !canReadTarget(entry.channel));
        progress = progress.filter(entry => !removed.includes(entry));
        revoked += removed.length;
        for (const entry of removed) pendingPurges.add(entry.channel.id);
        if (!pendingPurges.size) return;
        // Invalidate publication before any fallible deletion. Drain both operations independently,
        // and retain failed purge work even after its identity has been removed from the manifest.
        const invalidation = await Promise.allSettled([checkpoint("scrubbed", "incomplete"), Native.abortExportFiles(container.category, base)]);
        const ids = [...pendingPurges];
        const results = await Promise.allSettled(ids.map(id => Native.purgeChannelPages(container.category, base, id)));
        results.forEach((result, index) => { if (result.status === "fulfilled") pendingPurges.delete(ids[index]); });
        if ([...invalidation, ...results].some(result => result.status === "rejected")) throw new Error("Revoked page cleanup failed");
    };
    try {
        const pending = await Native.loadPendingExport(container.category, container.id);
        if (pending) {
            base = pending.base;
            // Only counts and the target identity are run metadata. A prior incomplete summary
            // may contain a now-revoked channel list or notice; never spread that into a checkpoint.
            manifest = { tool: "VesktopChatExporter", version: 2, started: pending.manifest.started,
                target: label, targetId: container.id, discovered: pending.manifest.discovered };
            progress = pending.manifest.progress;
            revoked = pending.manifest.revoked ?? 0;
            fetched = pending.manifest.fetched ?? 0;
            // Failed deletions and crash-before-checkpoint pages are not in progress. Scan only
            // this pending run's directory names, never their bodies, and remove those orphans
            // before discovery can return early or assembly can publish again.
            const storedIds = await Native.listExportChannelIds(container.category, base);
            for (const id of storedIds) if (!progress.some(entry => entry.channel.id === id)) pendingPurges.add(id);
            await scrubProgress();
        }
        const discovery = container.discover ? await collectGuildTargets(container.id, () => !cancelled, () => true)
            : { channels: container.channels.filter(channel => !isTargetBlocked(channel) && canReadTarget(channel)), issues: [] };
        const { channels, issues } = discovery;
        if (cancelled || pluginStopped || authFailed) return;
        if (!channels.length) {
            if (pending && !progress.length) await Native.discardExport(container.category, base);
            if (issues.length) showToast(`${label}: スレッド一覧を取得できず不完全です`, Toasts.Type.FAILURE);
            showToast(isLoggingBlocked(container.id) ? `${label}: この対象は停止リストに含まれています` : `${label}: 取得できるチャンネルがありません`, Toasts.Type.FAILURE);
            return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        base = pending?.base ?? `${safeName(label)}_${container.id}_${stamp}`;
        // The run is opened with counts only. The manifest channel list and the html navigation are
        // written after the phase-2 re-check (startExportFiles), from the channels the run really
        // saved, so a channel revoked mid-run can never survive in the output as a name or a link.
        manifest = {
            tool: "VesktopChatExporter",
            version: 2,
            started: pending?.manifest.started ?? new Date().toISOString(),
            target: label,
            targetId: container.id,
            discovered: channels.length
        };
        const prior = [...progress];
        const validated: Progress[] = [];
        for (const entry of prior) {
            if (!channels.some(channel => channel.id === entry.channel.id) || isTargetBlocked(entry.channel) || !canReadTarget(entry.channel)) {
                await Native.discardHistoryPages(container.category, base, entry.channel.id, channelLabel(entry.channel), entry.pages);
                await Native.purgeChannelPages(container.category, base, entry.channel.id);
                revoked++;
            } else {
                const ordered = [...entry.pages].sort((a, b) => compareIds(a.split("_")[0], b.split("_")[0]));
                if (new Set(ordered).size !== ordered.length
                    || ordered.length && entry.before !== ordered[0].split("_")[0]
                    || !ordered.length && (entry.before || entry.messages)) throw new Error("再開cursorが保存ページと一致しません");
                let count = 0;
                let previousNewest: string | undefined;
                let oldestCount = 0;
                for (const page of ordered) {
                    const stored = await Native.readHistoryPage(container.category, base, entry.channel.id, channelLabel(entry.channel), page);
                    if (isTargetBlocked(entry.channel) || !canReadTarget(entry.channel)) {
                        await Native.purgeChannelPages(container.category, base, entry.channel.id);
                        revoked++;
                        count = -1;
                        break;
                    }
                    if (!stored.length || previousNewest && compareIds(stored[0].messageId, previousNewest) <= 0)
                        throw new Error("再開ページが重複しています");
                    if (!count) oldestCount = stored.length;
                    count += stored.length;
                    previousNewest = stored[stored.length - 1].messageId;
                }
                if (count < 0) continue;
                if (count !== entry.messages) throw new Error("再開ページの件数が一致しません");
                // A full oldest page cannot prove EOF: re-check below its boundary on resume.
                if (entry.completed && oldestCount === 100) entry.completed = false;
                validated.push(entry);
            }
        }
        progress = validated;
        if (pending) await Native.abortExportFiles(container.category, base);
        fetched = progress.reduce((sum, entry) => sum + entry.messages, 0);
        const opened = await Native.beginExport(container.category, base, JSON.stringify({ ...manifest, phase: "fetching", outcome: "running", fetched, revoked, progress }));
        await checkpoint("fetching");
        showToast(`${label}: ${channels.length}件の取得${pending ? "を途中から再開" : "を開始"}（逐次保存）`, Toasts.Type.MESSAGE);
        // Phase 1: walk every channel and serialise each page to storage as it arrives. No page is
        // ever kept in memory after it has been written, so the run is bounded by the largest page
        // rather than by the size of the server, and a crash keeps everything already fetched.
        const walked: Progress[] = [];
        const failures: { channel: MessageTarget; status: string | number; }[] = [];
        // A channel the account may not read is only ever counted: the run must leave no trace of it,
        // so it is never named in the manifest, the aggregate or the notices.
        for (let i = 0; i < channels.length && !cancelled; i++) {
            const channel = { ...channels[i] };
            const name = channelLabel(channel);
            const allowed = () => !isTargetBlocked(channel) && canReadTarget(channel);
            if (!allowed()) {
                revoked++;
                progress = progress.filter(record => record.channel.id !== channel.id);
                await Native.purgeChannelPages(container.category, base, channel.id);
                await checkpoint("fetching");
                continue;
            }
            let entry = progress.find(record => record.channel.id === channel.id);
            if (!entry) { entry = { channel, pages: [], messages: 0 }; progress.push(entry); }
            const pages = entry.pages;
            if (entry.completed) { walked.push(entry); continue; }
            showToast(`[${i + 1}/${channels.length}] ${name} を取得中`, Toasts.Type.MESSAGE);
            try {
                entry.completed = await walkChannelHistory(channel, allowed, async page => {
                    const stored = await Native.writeHistoryPageJson(container.category, base, channel.id, name, page.map(message => toHistoryMessage(message, container, channel)));
                    if (!stored || stored.count !== page.length) throw new Error("保存ページの件数が一致しません");
                    if (!pages.includes(stored.base)) { pages.push(stored.base); entry.messages += stored.count; }
                    entry.before = page[0].id;
                    entry.completed = page.length < 100;
                    fetched += page.length;
                    await checkpoint("fetching");
                    if (fetched % 500 === 0) showToast(`${name}: 累計${fetched}件保存`, Toasts.Type.MESSAGE);
                }, entry.before);
                await checkpoint("fetching");
            } catch (error) {
                // Access revoked while this channel was being walked: discard this run's pages for it
                // instead of reporting a named failure.
                if (!allowed()) {
                    revoked++;
                    await Native.discardHistoryPages(container.category, base, channel.id, name, pages);
                    await Native.purgeChannelPages(container.category, base, channel.id);
                    progress = progress.filter(record => record !== entry);
                    await checkpoint("fetching");
                    continue;
                }
                failures.push({ channel, status: statusOf(error) ?? "unknown" });
            }
            walked.push(entry);
        }
        if (pluginStopped || authFailed) {
            if (!fetched) { await Native.discardExport(container.category, base); return; }
            await Native.abortExportFiles(container.category, base);
            await checkpoint("fetching", "paused");
            return;
        }
        // Phase 2: re-check every channel after all the waits (a menu opened before blocking, or
        // access revoked while the run was under way, must not slip through), then open the aggregate
        // files from the surviving channels only and fill them from the pages already on disk,
        // oldest -> newest.
        const surviving = [...walked];
        const dropRevoked = async () => {
            let changed = false;
            for (let i = surviving.length - 1; i >= 0; i--) {
                const entry = surviving[i];
                if (!isTargetBlocked(entry.channel) && canReadTarget(entry.channel)) continue;
                surviving.splice(i, 1);
                progress = progress.filter(record => record !== entry);
                revoked++;
                changed = true;
                pendingPurges.add(entry.channel.id);
            }
            await scrubProgress();
            return changed;
        };
        await dropRevoked();
        await checkpoint("assembling");
        // IPC file operations yield to Discord just like HTTP requests. Re-check the entire saved
        // set after each await. If a channel was revoked after its header/body was appended, truncate
        // and rebuild both aggregates from the remaining pages; a one-time snapshot cannot protect
        // either the content or the sidebar. Each retry permanently drops at least one channel.
        // Each permission retry removes a channel; cancellation adds at most one further retry.
        assembly: for (let attempt = 0; attempt <= walked.length + 1; attempt++) {
            total = 0; savedChannels = 0;
            if (attempt) await checkpoint("assembling");
            if (await dropRevoked()) continue;
            const savedList = surviving.map(entry => entry.channel);
            await Native.startExportFiles(
                container.category,
                base,
                exportTxtHeader(label, container.id, savedList),
                exportHtmlHeader(label, container.id, savedList)
            );
            if (await dropRevoked()) continue;
            for (const entry of surviving) {
                const { channel, pages } = entry;
                const name = channelLabel(channel);
                await Native.appendExport(container.category, base, { txt: channelTxtHeader(channel), html: channelHtmlHeader(channel) });
                if (await dropRevoked()) continue assembly;
                // Pages arrived newest-first; the native listing sorts them oldest-first.
                const available = await Native.listHistoryPages(container.category, base, channel.id, name);
                if (await dropRevoked()) continue assembly;
                if (pages.some(page => !available.includes(page))) throw new Error("保存済みページが不足しています");
                const ordered = available.filter(page => pages.includes(page));
                let assembled = 0;
                for (const page of ordered) {
                    const stored = await Native.readHistoryPage(container.category, base, channel.id, name, page) as StoredMessage[];
                    if (await dropRevoked()) continue assembly;
                    if (!stored.length || stored.length > 100 || `${stored[0].messageId}_${stored[stored.length - 1].messageId}` !== page)
                        throw new Error("保存済みページが破損しています");
                    await Native.appendExport(container.category, base, { txt: messagesTxtFragment(stored), html: messagesHtmlFragment(stored) });
                    if (await dropRevoked()) continue assembly;
                    total += stored.length;
                    assembled += stored.length;
                }
                if (assembled !== entry.messages) throw new Error("保存済み件数が一致しません");
                await Native.appendExport(container.category, base, { html: "</section>" });
                if (await dropRevoked()) continue assembly;
                savedChannels++;
            }
            const notice = [
                issueText(issues),
                ...failures.filter(failure => savedList.some(channel => channel.id === failure.channel.id))
                    .map(failure => `# ${channelLabel(failure.channel)} (${failure.channel.id}): 取得失敗 (HTTP ${failure.status})`),
                revoked ? `閲覧権限が取り消されたチャンネル: ${revoked}件（この実行の出力からは除外し、名前やIDも記録していません）` : ""
            ].filter(Boolean).join("\n");
            const summary = (outcome: string) => JSON.stringify({
                finished: new Date().toISOString(),
                outcome,
                target: label,
                targetId: container.id,
                discovered: channels.length,
                savedChannels,
                revoked,
                messages: total,
                channels: savedList.map(channel => ({ id: channel.id, name: channelLabel(channel), type: channel.type })),
                notice: notice || undefined
            }, null, 2);
            if (!total) {
                await Native.discardExport(container.category, base);
                return showToast(cancelled ? "エクスポートを中止しました（保存されたメッセージはありません）"
                    : `${label}: 保存できるメッセージがありませんでした`, cancelled || notice ? Toasts.Type.FAILURE : Toasts.Type.MESSAGE);
            }
            const incomplete = notice.length > 0 || savedChannels !== channels.length;
            const finalCancelled = cancelled;
            const saved = await Native.finishExport(
                container.category,
                base,
                summary(finalCancelled ? "cancelled" : incomplete ? "incomplete" : "complete"),
                exportTxtFooter(total, savedChannels, finalCancelled ? "CANCELLED" : notice),
                exportHtmlFooter(total, savedChannels, finalCancelled ? "CANCELLED" : notice)
            );
            if (await dropRevoked()) continue;
            if (cancelled !== finalCancelled) {
                await checkpoint("assembling", "cancelled");
                await Native.abortExportFiles(container.category, base);
                continue;
            }
            await Native.publishExport(container.category, base);
            if (await dropRevoked()) continue;
            if (cancelled !== finalCancelled) {
                await checkpoint("assembling", "cancelled");
                await Native.abortExportFiles(container.category, base);
                continue;
            }
            if (cancelled)
                return showToast(`エクスポートを中止しました（保存済み: ${total}件 / ${opened.directory}）`, Toasts.Type.FAILURE);
            return showToast(`${incomplete ? "一部のみ保存（不完全）" : "完了"}: ${total}件 / ${saved.directory}`, incomplete ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
        }
        // Exhausting the monotone retry guard must never leave a stale authorized-looking output.
        await Native.discardExport(container.category, base);
        throw new Error("保存中に閲覧権限が変わり続けたため中止しました");
    } catch (error) {
        if (base) {
            try { await scrubProgress(); } catch { /* Still attempt both independent cleanup and checkpoint writes. */ }
            try { await Native.abortExportFiles(container.category, base); } catch { /* Failed cleanup is not a complete export. */ }
            try { await checkpoint("failed", "failed"); } catch { /* Preserve the last durable record when storage is unavailable. */ }
        }
        showToast(`ログ保存に失敗 (HTTP ${statusOf(error) ?? "unknown"})`, Toasts.Type.FAILURE);
    } finally {
        exporting = false;
    }
}


function exportGuild(guild: Guild) {
    return exportChannels({ id: guild.id, name: guild.name, channels: getGuildParents(guild.id), discover: true }, guild.name);
}

function exportDm(channel: Channel) {
    return exportChannels({ category: DM_CATEGORY, id: channel.id, name: channelLabel(channel), channels: [channel] }, channelLabel(channel));
}

async function saveLiveMessage(event: { message?: RawMessage & { channel_id?: string; guild_id?: string; }; optimistic?: boolean; }) {
    // Own sends are dispatched twice: an optimistic local echo (client-side snowflake id) and then
    // the confirmed gateway message (server snowflake id). They carry different ids, so saving both
    // writes every own message twice; only the confirmed message is authoritative.
    if (event.optimistic) return;
    const message = event.message;
    if (!message?.id || savedLiveIds.has(message.id) || liveInFlight.has(message.id)) return;
    const channel = ChannelStore.getChannel(message.channel_id!);
    if (!channel) return;
    const guildId = message.guild_id || (channel as any).guild_id;
    const guild = guildId && GuildStore.getGuild(guildId);

    let category: string | undefined;
    let containerId: string;
    let containerName: string;

    if (guild) {
        if (!settings.store.autoSave) return;
        if (isLoggingBlocked(guild.id) || isTargetBlocked(channel)) return; // Parent blocks apply to threads too.
        if (channel.type === 12 && !canReadTarget(channel)) return;
        containerId = guild.id;
        containerName = guild.name;
    } else if (isDmChannel(channel)) {
        if (!settings.store.saveDmMessages) return;
        if (isLoggingBlocked(undefined, channel.id)) return;
        category = DM_CATEGORY;
        containerId = channel.id;
        containerName = channelLabel(channel);
    } else {
        return; // Other private/system channels are not logged.
    }

    liveInFlight.add(message.id);
    try {
        await Native.appendLiveMessage({
            category,
            guildId: containerId,
            guildName: containerName,
            channelId: channel.id,
            channelName: channelLabel(channel),
            messageId: message.id,
            timestamp: messageTimestamp(message),
            author: message.author?.global_name || message.author?.username || "Unknown",
            authorId: message.author?.id || "unknown",
            content: richContent(message),
            attachments: (message.attachments ?? []).map(a => ({ filename: a.filename, url: a.url }))
        });
        savedLiveIds.add(message.id);
        if (savedLiveIds.size > 5000) savedLiveIds.delete(savedLiveIds.values().next().value!);
    } catch (error) {
        console.error("[VesktopChatExporter] automatic save failed", statusOf(error) ?? "storage failed");
    } finally {
        liveInFlight.delete(message.id);
    }
}

const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;
    const blocked = parseIdList(settings.store.blockedGuildIds).includes(guild.id);
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="vc-export-guild-chat" label="全チャンネルのログを保存（TXT + HTML）" action={() => exportGuild(guild)} disabled={exporting} />,
        <Menu.MenuItem id="vc-toggle-guild-log" label={blocked ? "このサーバーのログ収集を再開" : "このサーバーのログ収集を停止"} color={blocked ? undefined : "danger"} action={() => {
            const nowBlocked = toggleBlockedId("blockedGuildIds", guild.id);
            showToast(nowBlocked ? `${guild.name}: ログ収集を停止しました` : `${guild.name}: ログ収集を再開しました`, nowBlocked ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS);
        }} />,
        <Menu.MenuItem id="vc-open-chat-log-folder" label="ログ保存フォルダーを開く" action={() => Native.openLogFolder()} />,
        exporting ? <Menu.MenuItem id="vc-cancel-guild-export" label="ログ保存を中止" color="danger" action={() => { cancelled = true; }} /> : null
    );
};

const channelMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel & { guild_id?: string; }; }) => {
    if (!channel?.id || !channel.guild_id) return; // Guild channels only; DMs are handled below.
    const blocked = parseIdList(settings.store.blockedChannelIds).includes(channel.id);
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="vc-toggle-channel-log" label={blocked ? "このチャンネルのログ収集を再開" : "このチャンネルのログ収集を停止"} color={blocked ? undefined : "danger"} action={() => {
            const nowBlocked = toggleBlockedId("blockedChannelIds", channel.id);
            showToast(`${nowBlocked ? "停止" : "再開"}: #${channel.name ?? channel.id}`, nowBlocked ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS);
        }} />
    );
};

const dmMenu: NavContextMenuPatchCallback = (children, { channel, user }: { channel?: Channel; user?: { id: string; }; }) => {
    // User menus do not always carry a channel. Resolve an existing DM only;
    // inspecting a menu must never create a conversation or select another DM.
    const dmId = !channel && user && ChannelStore.getDMFromUserId(user.id);
    const dm = channel ?? (dmId ? ChannelStore.getChannel(dmId) : undefined);
    if (!dm || !isDmChannel(dm)) return;
    const label = channelLabel(dm);
    const blocked = parseIdList(settings.store.blockedChannelIds).includes(dm.id);
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuItem id="vc-export-dm-chat" label={`「${label}」のログを保存（TXT + HTML）`} action={() => exportDm(dm)} disabled={exporting} />,
        <Menu.MenuItem id="vc-toggle-dm-log" label={blocked ? "このDMのログ収集を再開" : "このDMのログ収集を停止"} color={blocked ? undefined : "danger"} action={() => {
            const nowBlocked = toggleBlockedId("blockedChannelIds", dm.id);
            showToast(`${nowBlocked ? "停止" : "再開"}: ${label}`, nowBlocked ? Toasts.Type.MESSAGE : Toasts.Type.SUCCESS);
        }} />,
        <Menu.MenuItem id="vc-open-chat-log-folder-dm" label="ログ保存フォルダーを開く" action={() => Native.openLogFolder()} />,
        exporting ? <Menu.MenuItem id="vc-cancel-dm-export" label="ログ保存を中止" color="danger" action={() => { cancelled = true; }} /> : null
    );
};

export default definePlugin({
    name: "VesktopChatExporter",
    description: "閲覧可能なサーバー・DM・スレッド・フォーラム投稿をTXTとHTMLへ保存します",
    authors: [{ name: "aki_0", id: 0n }],
    settings,
    contextMenus: {
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu,
        "channel-context": channelMenu,
        "thread-context": channelMenu,
        "user-context": dmMenu,
        "gdm-context": dmMenu
    },
    start() {
        if (subscribed) return;
        crawlGeneration++;
        pluginStopped = false;
        crawlStopped = false;
        authFailed = false;
        FluxDispatcher.subscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = true;
        Native.openLogFolder().catch(() => {});
        // Give Discord stores time to populate before starting the low-rate crawl.
        if (crawlTimer) clearTimeout(crawlTimer);
        crawlTimer = setTimeout(crawlAllHistory, 10_000);
    },
    stop() {
        crawlGeneration++;
        pluginStopped = true;
        cancelled = true;
        crawlStopped = true;
        if (crawlTimer) clearTimeout(crawlTimer);
        crawlTimer = undefined;
        if (!subscribed) return;
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = false;
    }
});
