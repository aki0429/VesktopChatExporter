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
    if (!list.length) {
        try {
            list = Object.values(store.getMutablePrivateChannels?.() ?? {});
        } catch { /* ignore */ }
    }
    return list
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
let requestCount = 0;
let adaptiveDelay = 1000;
const savedLiveIds = new Set<string>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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
            // Text, announcement and forum/media channels. Voice categories are excluded.
            // Inclusion stays VIEW_CHANNEL based (like the previous release): a channel the account
            // can view is always attempted, and a history-permission failure is reported instead of
            // silently hiding the channel from the export.
            return [0, 5, 15, 16].includes(channel.type)
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
    return issues.map(issue => `${issue.scope}: ${issue.message}${issue.status ? ` (HTTP ${issue.status})` : ""}`).join("\n");
}

async function fetchAllMessages(channel: MessageTarget, onProgress: (count: number) => void): Promise<RawMessage[]> {
    const result: RawMessage[] = [];
    let before: string | undefined;

    while (!cancelled) {
        const page = await getMessagePage(channel.id, before, () => !cancelled && !isTargetBlocked(channel) && canReadTarget(channel));
        if (!page.length) break;
        result.push(...page);
        onProgress(result.length);
        if (page.length < 100) break;
        before = page[page.length - 1].id;
        await sleep(Math.max(500, settings.store.pageDelay));
    }
    return result.reverse();
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
        for (;;) {
            check();
            await sleep(Math.max(adaptiveDelay, settings.store.pageDelay || 1000));
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
                adaptiveDelay = Math.max(1000, adaptiveDelay - 100);
                return response?.body;
            } catch (error) {
                if (statusOf(error) === 401) {
                    authFailed = true;
                    showToast("認証エラー: ログ取得を停止しました。再ログイン後にプラグインを再起動してください", Toasts.Type.FAILURE);
                }
                if (statusOf(error) !== 429) throw error;
                const wait = retryAfterMs(error);
                adaptiveDelay = Math.min(10_000, Math.max(adaptiveDelay * 2, 2_000));
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

async function getMessagePage(channelId: string, before: string | undefined, allowed: () => boolean): Promise<RawMessage[]> {
    const body = await queuedGet(Constants.Endpoints.MESSAGES(channelId), { limit: 100, ...(before ? { before } : {}) }, allowed);
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

async function crawlAllHistory() {
    if (crawlRunning || !settings.store.forceHistoryCrawl) return;
    crawlRunning = true;
    crawlStopped = false;
    try {
        const state = await Native.loadCrawlState();
        const running = () => !crawlStopped && !pluginStopped && !authFailed && settings.store.forceHistoryCrawl;
        // Advance the rotation cursor for this cycle before any request can abort the run.
        const scanActive = buildActiveScan(state);
        await Native.saveCrawlState(state);
        for (const container of buildContainers()) {
            if (!running()) return;
            const discovery = container.discover ? await collectGuildTargets(container.id, running, scanActive) : { channels: container.channels, issues: [] };
            if (discovery.issues.length) {
                console.warn("[VesktopChatExporter] incomplete discovery", issueText(discovery.issues));
                showToast(`${container.name}: スレッド一覧の一部を取得できませんでした`, Toasts.Type.FAILURE);
            }
            for (const channel of discovery.channels) {
                if (!running()) return;
                const allowed = () => running() && (!container.category || settings.store.crawlDms)
                    && !isTargetBlocked(channel) && canReadTarget(channel);
                if (!allowed()) continue;
                const key = `${container.id}:${channel.id}`;
                const saved = state[key] ?? {};
                if (saved.completed) continue;
                let before = saved.before;
                while (!crawlStopped && settings.store.forceHistoryCrawl) {
                    // The channel may have been added to the stop list while this loop was running.
                    if (!allowed()) break;
                    try {
                        const page = await getMessagePage(channel.id, before, allowed);
                        if (!allowed()) break;
                        if (!page.length) {
                            state[key] = { before, completed: true, updatedAt: new Date().toISOString() };
                            await Native.saveCrawlState(state);
                            break;
                        }
                        await Native.saveHistoryPage(
                            container.category,
                            container.id,
                            container.name,
                            channel.id,
                            channelLabel(channel),
                            page.map(message => toHistoryMessage(message, container, channel))
                        );
                        if (before && BigInt(page[page.length - 1].id) >= BigInt(before)) throw new Error("履歴カーソルが進みません");
                        before = page[page.length - 1].id; // API is newest -> oldest.
                        state[key] = { before, completed: page.length < 100, updatedAt: new Date().toISOString() };
                        await Native.saveCrawlState(state);
                        if (page.length < 100) break;
                    } catch (error) {
                        console.error(`[VesktopChatExporter] crawl failed for ${channel.id}`, statusOf(error) ?? "request/save failed");
                        if (!running()) return;
                        // Non-429 errors do not spin: pause and continue with the next channel.
                        await sleep(30_000);
                        break;
                    }
                }
            }
        }
    } catch (error) {
        console.error("[VesktopChatExporter] history interrupted", statusOf(error) ?? "request/save failed");
    } finally {
        crawlRunning = false;
        if (!crawlStopped && !pluginStopped && !authFailed && settings.store.forceHistoryCrawl)
            crawlTimer = setTimeout(crawlAllHistory, 5 * 60_000);
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

function messageText(message: RawMessage): string {
    const author = message.author?.global_name || message.author?.username || "Unknown";
    const lines = [`[${message.timestamp}] ${author} (${message.author?.id ?? "?"})${message.author?.bot ? " [BOT]" : ""}`, richContent(message)];
    if (settings.store.includeAttachments) {
        for (const file of message.attachments ?? []) lines.push(`[添付] ${file.filename}: ${file.url}`);
    }
    if (message.edited_timestamp) lines.push(`[編集: ${message.edited_timestamp}]`);
    return lines.join("\n");
}

function makeTxt(title: string, targetId: string, channels: ExportChannel[], notice = "") {
    const body = channels.map(({ channel, messages, error }) => {
        const header = `\n\n${"=".repeat(72)}\n# ${channelLabel(channel)} (${channel.id})\n${"=".repeat(72)}`;
        return header + (error ? `\nERROR: ${error}` : `\n${messages.map(messageText).join("\n\n")}`);
    }).join("");
    return `Discord chat export${notice ? `\nINCOMPLETE: ${notice}` : ""}\nTarget: ${title}\nTarget ID: ${targetId}\nExported: ${new Date().toISOString()}\nChannels: ${channels.length}\nMessages: ${channels.reduce((n, c) => n + c.messages.length, 0)}${body}\n`;
}

function makeHtml(title: string, targetId: string, channels: ExportChannel[], notice = "") {
    const sections = channels.map(({ channel, messages, error }) => `<section id="c-${channel.id}"><h2># ${escapeHtml(channelLabel(channel))}</h2>${error ? `<p class="error">${escapeHtml(error)}</p>` : messages.map(m => {
        const author = m.author?.global_name || m.author?.username || "Unknown";
        const attachments = settings.store.includeAttachments ? (m.attachments ?? []).map(a => `<a class="attachment" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(a.filename)}</a>`).join("") : "";
        const embeds = settings.store.includeAttachments ? (m.embeds ?? []).filter(e => e.url).map(e => `<a class="attachment" href="${escapeHtml(e.url)}" target="_blank" rel="noreferrer">🔗 ${escapeHtml(e.title ?? e.url)}</a>`).join("") : "";
        return `<article><div class="meta"><b>${escapeHtml(author)}</b><span>${escapeHtml(m.timestamp)}</span><code>${m.id}</code></div><div class="content">${escapeHtml(richContent(m)).replace(/\n/g, "<br>")}</div>${attachments}${embeds}</article>`;
    }).join("")}</section>`).join("");
    const nav = channels.map(c => `<a href="#c-${c.channel.id}"># ${escapeHtml(channelLabel(c.channel))}</a>`).join("");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} Chat Export</title><style>*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif}.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}aside{position:sticky;top:0;height:100vh;overflow:auto;background:#2b2d31;padding:20px}aside h1{font-size:18px}aside a{display:block;color:#b5bac1;text-decoration:none;padding:7px;border-radius:5px}aside a:hover{background:#35373c;color:#fff}main{max-width:1000px;padding:28px 40px}section{margin-bottom:55px}h2{border-bottom:1px solid #3f4147;padding-bottom:12px}article{padding:10px 12px;border-radius:5px}article:hover{background:#2b2d31}.meta{display:flex;gap:10px;align-items:baseline}.meta b{color:#fff}.meta span,.meta code{font-size:11px;color:#949ba4}.content{white-space:normal;margin-top:4px;line-height:1.5}.attachment{display:block;color:#00a8fc;margin-top:5px}.error{color:#f23f42}@media(max-width:700px){.layout{display:block}aside{position:relative;height:auto}main{padding:18px}}</style></head><body><div class="layout"><aside><h1>${escapeHtml(title)}</h1><p>${channels.reduce((n,c)=>n+c.messages.length,0)} messages</p>${nav}</aside><main><h1>${escapeHtml(title)} — Chat Export</h1><p>Exported: ${escapeHtml(new Date().toISOString())}</p><p>Target ID: ${escapeHtml(targetId)}</p>${notice ? `<p class="error">INCOMPLETE: ${escapeHtml(notice)}</p>` : ""}${sections}</main></div></body></html>`;
}

async function exportChannels(container: Container, label: string) {
    if (exporting) return showToast("既にエクスポート中です", Toasts.Type.MESSAGE);
    exporting = true; cancelled = false;
    const output: ExportChannel[] = [];
    try {
        const discovery = container.discover ? await collectGuildTargets(container.id, () => !cancelled, () => true)
            : { channels: container.channels, issues: [] };
        const { channels, issues } = discovery;
        if (cancelled || pluginStopped || authFailed) return;
        if (!channels.length) {
            if (issues.length) showToast(`${label}: スレッド一覧を取得できず不完全です`, Toasts.Type.FAILURE);
            showToast(isLoggingBlocked(container.id) ? `${label}: この対象は停止リストに含まれています` : `${label}: 取得できるチャンネルがありません`, Toasts.Type.FAILURE);
            return;
        }
        showToast(`${label}: ${channels.length}件の取得を開始`, Toasts.Type.MESSAGE);
        for (let i = 0; i < channels.length && !cancelled; i++) {
            const channel = channels[i];
            if (isTargetBlocked(channel) || !canReadTarget(channel)) continue;
            const name = channelLabel(channel);
            showToast(`[${i + 1}/${channels.length}] ${name} を取得中`, Toasts.Type.MESSAGE);
            try {
                const messages = await fetchAllMessages(channel, count => {
                    if (count % 500 === 0) showToast(`${name}: ${count}件取得`, Toasts.Type.MESSAGE);
                });
                output.push({ channel, messages });
            } catch (error) {
                output.push({ channel, messages: [], error: `取得失敗 (HTTP ${statusOf(error) ?? "unknown"})` });
            }
        }
        if (cancelled || pluginStopped || authFailed) return showToast("エクスポートを中止しました", Toasts.Type.FAILURE);
        // Re-check after awaits: a menu opened before blocking must not bypass it.
        const allowedOutput = output.filter(item => !isTargetBlocked(item.channel) && canReadTarget(item.channel));
        if (!allowedOutput.length) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const base = `${safeName(label)}_${container.id}_${stamp}`;
        const saved = await Native.saveLogs(container.category, base, makeTxt(label, container.id, allowedOutput, issueText(issues)), makeHtml(label, container.id, allowedOutput, issueText(issues)));
        const incomplete = issues.length > 0 || allowedOutput.some(item => item.error) || allowedOutput.length !== channels.length;
        showToast(`${incomplete ? "一部のみ保存（不完全）" : "完了"}: ${allowedOutput.reduce((n, c) => n + c.messages.length, 0)}件 / ${saved.directory}`, incomplete ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS);
    } catch (error) {
        showToast(`ログ保存に失敗 (HTTP ${statusOf(error) ?? "unknown"})`, Toasts.Type.FAILURE);
    } finally {
        exporting = false;
    }
}

function exportGuild(guild: Guild) {
    return exportChannels({ id: guild.id, name: guild.name, channels: getGuildParents(guild.id), discover: true }, guild.name);
}

function exportDm(channel: Channel) {
    if (isLoggingBlocked(undefined, channel.id)) {
        showToast("このDMは停止リストに含まれています", Toasts.Type.FAILURE);
        return;
    }
    return exportChannels({ category: DM_CATEGORY, id: channel.id, name: channelLabel(channel), channels: [channel] }, channelLabel(channel));
}

async function saveLiveMessage(event: { message?: RawMessage & { channel_id?: string; guild_id?: string; }; optimistic?: boolean; }) {
    // Own sends are dispatched twice: an optimistic local echo (client-side snowflake id) and then
    // the confirmed gateway message (server snowflake id). They carry different ids, so saving both
    // writes every own message twice; only the confirmed message is authoritative.
    if (event.optimistic) return;
    const message = event.message;
    if (!message?.id || savedLiveIds.has(message.id)) return;
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

    savedLiveIds.add(message.id);
    if (savedLiveIds.size > 5000) savedLiveIds.delete(savedLiveIds.values().next().value!);
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
    } catch (error) {
        console.error("[VesktopChatExporter] automatic save failed", error);
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
        pluginStopped = false;
        authFailed = false;
        FluxDispatcher.subscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = true;
        Native.openLogFolder().catch(() => {});
        // Give Discord stores time to populate before starting the low-rate crawl.
        crawlTimer = setTimeout(crawlAllHistory, 10_000);
    },
    stop() {
        pluginStopped = true;
        cancelled = true;
        crawlStopped = true;
        if (crawlTimer) clearTimeout(crawlTimer);
        if (!subscribed) return;
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = false;
    }
});
