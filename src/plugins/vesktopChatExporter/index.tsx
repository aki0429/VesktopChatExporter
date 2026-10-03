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
    GuildStore
} from "@webpack/common";

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
        description: "起動中、全サーバーの閲覧可能な履歴を最新から古い順に低速で自動収集する",
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
    if (channel.type === 3) {
        if (channel.name) return channel.name;
        const names = (channel.rawRecipients ?? []).map(recipientName).filter(Boolean);
        return names.length ? names.join(", ") : "Group DM";
    }
    const other = (channel.rawRecipients ?? [])[0];
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
type Container = { category?: string; id: string; name: string; channels: Channel[]; };

type ExportChannel = { channel: Channel; messages: RawMessage[]; error?: string; };
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

function getExportableChannels(guildId: string): Channel[] {
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
            return [0, 5, 15, 16].includes(channel.type)
                && PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel)
                && !isLoggingBlocked(guildId, channel.id);
        })
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
}

async function fetchAllMessages(channel: Channel, onProgress: (count: number) => void): Promise<RawMessage[]> {
    const result: RawMessage[] = [];
    let before: string | undefined;

    while (!cancelled) {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channel.id),
            query: { limit: 100, ...(before ? { before } : {}) },
            retries: 4
        });
        const page = (response?.body ?? []) as RawMessage[];
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
    if (typeof raw !== "number") return 60_000;
    return Math.max(5_000, raw < 1000 ? raw * 1000 : raw);
}

async function pacedGet(channelId: string, before?: string) {
    // One request per second. After every ten requests, add a five second rest.
    await sleep(adaptiveDelay);
    if (requestCount > 0 && requestCount % 10 === 0) await sleep(5_000);
    try {
        const response = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(channelId),
            query: { limit: 100, ...(before ? { before } : {}) },
            // Handle 429 here so the crawler fully stops before retrying.
            retries: 0
        });
        requestCount++;
        adaptiveDelay = Math.max(1000, adaptiveDelay - 100);
        return (response?.body ?? []) as RawMessage[];
    } catch (error) {
        if (statusOf(error) === 429) {
            const wait = retryAfterMs(error);
            adaptiveDelay = Math.min(10_000, Math.max(adaptiveDelay * 2, 2_000));
            showToast(`429を検出: ${Math.ceil(wait / 1000)}秒完全停止後、${adaptiveDelay / 1000}秒間隔で再開`, Toasts.Type.FAILURE);
            await sleep(wait + 2_000);
            if (crawlStopped) throw error;
            return pacedGet(channelId, before);
        }
        throw error;
    }
}

function toHistoryMessage(message: RawMessage, container: Container, channel: Channel) {
    return {
        guildId: container.id,
        guildName: container.name,
        channelId: channel.id,
        channelName: channelLabel(channel),
        messageId: message.id,
        timestamp: message.timestamp || new Date().toISOString(),
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
        const channels = getExportableChannels(guild.id);
        if (channels.length) containers.push({ id: guild.id, name: guild.name, channels });
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
        for (const container of buildContainers()) {
            for (const channel of container.channels) {
                if (crawlStopped || !settings.store.forceHistoryCrawl) return;
                const key = `${container.id}:${channel.id}`;
                const saved = state[key] ?? {};
                if (saved.completed) continue;
                let before = saved.before;
                while (!crawlStopped && settings.store.forceHistoryCrawl) {
                    // The channel may have been added to the stop list while this loop was running.
                    if (isLoggingBlocked(container.category ? undefined : container.id, channel.id)) break;
                    try {
                        const page = await pacedGet(channel.id, before);
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
                        before = page[page.length - 1].id; // API is newest -> oldest.
                        state[key] = { before, completed: page.length < 100, updatedAt: new Date().toISOString() };
                        await Native.saveCrawlState(state);
                        if (page.length < 100) break;
                    } catch (error) {
                        console.error(`[VesktopChatExporter] crawl failed for ${channel.id}`, error);
                        // Non-429 errors do not spin: pause and continue with the next channel.
                        await sleep(30_000);
                        break;
                    }
                }
            }
        }
    } finally {
        crawlRunning = false;
        if (!crawlStopped && settings.store.forceHistoryCrawl)
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

function makeTxt(title: string, targetId: string, channels: ExportChannel[]) {
    const body = channels.map(({ channel, messages, error }) => {
        const header = `\n\n${"=".repeat(72)}\n# ${channelLabel(channel)} (${channel.id})\n${"=".repeat(72)}`;
        return header + (error ? `\nERROR: ${error}` : `\n${messages.map(messageText).join("\n\n")}`);
    }).join("");
    return `Discord chat export\nTarget: ${title}\nTarget ID: ${targetId}\nExported: ${new Date().toISOString()}\nChannels: ${channels.length}\nMessages: ${channels.reduce((n, c) => n + c.messages.length, 0)}${body}\n`;
}

function makeHtml(title: string, targetId: string, channels: ExportChannel[]) {
    const sections = channels.map(({ channel, messages, error }) => `<section id="c-${channel.id}"><h2># ${escapeHtml(channelLabel(channel))}</h2>${error ? `<p class="error">${escapeHtml(error)}</p>` : messages.map(m => {
        const author = m.author?.global_name || m.author?.username || "Unknown";
        const attachments = settings.store.includeAttachments ? (m.attachments ?? []).map(a => `<a class="attachment" href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(a.filename)}</a>`).join("") : "";
        const embeds = settings.store.includeAttachments ? (m.embeds ?? []).filter(e => e.url).map(e => `<a class="attachment" href="${escapeHtml(e.url)}" target="_blank" rel="noreferrer">🔗 ${escapeHtml(e.title ?? e.url)}</a>`).join("") : "";
        return `<article><div class="meta"><b>${escapeHtml(author)}</b><span>${escapeHtml(m.timestamp)}</span><code>${m.id}</code></div><div class="content">${escapeHtml(richContent(m)).replace(/\n/g, "<br>")}</div>${attachments}${embeds}</article>`;
    }).join("")}</section>`).join("");
    const nav = channels.map(c => `<a href="#c-${c.channel.id}"># ${escapeHtml(channelLabel(c.channel))}</a>`).join("");
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)} Chat Export</title><style>*{box-sizing:border-box}body{margin:0;background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif}.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh}aside{position:sticky;top:0;height:100vh;overflow:auto;background:#2b2d31;padding:20px}aside h1{font-size:18px}aside a{display:block;color:#b5bac1;text-decoration:none;padding:7px;border-radius:5px}aside a:hover{background:#35373c;color:#fff}main{max-width:1000px;padding:28px 40px}section{margin-bottom:55px}h2{border-bottom:1px solid #3f4147;padding-bottom:12px}article{padding:10px 12px;border-radius:5px}article:hover{background:#2b2d31}.meta{display:flex;gap:10px;align-items:baseline}.meta b{color:#fff}.meta span,.meta code{font-size:11px;color:#949ba4}.content{white-space:normal;margin-top:4px;line-height:1.5}.attachment{display:block;color:#00a8fc;margin-top:5px}.error{color:#f23f42}@media(max-width:700px){.layout{display:block}aside{position:relative;height:auto}main{padding:18px}}</style></head><body><div class="layout"><aside><h1>${escapeHtml(title)}</h1><p>${channels.reduce((n,c)=>n+c.messages.length,0)} messages</p>${nav}</aside><main><h1>${escapeHtml(title)} — Chat Export</h1><p>Exported: ${escapeHtml(new Date().toISOString())}</p><p>Target ID: ${escapeHtml(targetId)}</p>${sections}</main></div></body></html>`;
}

async function exportChannels(container: Container, label: string) {
    if (exporting) return showToast("既にエクスポート中です", Toasts.Type.MESSAGE);
    exporting = true; cancelled = false;
    const channels = container.channels;
    const output: ExportChannel[] = [];
    try {
        if (!channels.length) {
            showToast(isLoggingBlocked(container.id) ? `${label}: この対象は停止リストに含まれています` : `${label}: 取得できるチャンネルがありません`, Toasts.Type.FAILURE);
            return;
        }
        showToast(`${label}: ${channels.length}件の取得を開始`, Toasts.Type.MESSAGE);
        for (let i = 0; i < channels.length && !cancelled; i++) {
            const channel = channels[i];
            const name = channelLabel(channel);
            showToast(`[${i + 1}/${channels.length}] ${name} を取得中`, Toasts.Type.MESSAGE);
            try {
                const messages = await fetchAllMessages(channel, count => {
                    if (count % 500 === 0) showToast(`${name}: ${count}件取得`, Toasts.Type.MESSAGE);
                });
                output.push({ channel, messages });
            } catch (error) {
                output.push({ channel, messages: [], error: String(error) });
            }
        }
        if (cancelled) return showToast("エクスポートを中止しました", Toasts.Type.FAILURE);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const base = `${safeName(label)}_${container.id}_${stamp}`;
        const saved = await Native.saveLogs(container.category, base, makeTxt(label, container.id, output), makeHtml(label, container.id, output));
        showToast(`完了: ${output.reduce((n, c) => n + c.messages.length, 0)}件 / ${saved.directory}`, Toasts.Type.SUCCESS);
    } finally {
        exporting = false;
    }
}

function exportGuild(guild: Guild) {
    return exportChannels({ id: guild.id, name: guild.name, channels: getExportableChannels(guild.id) }, guild.name);
}

function exportDm(channel: Channel) {
    return exportChannels({ category: DM_CATEGORY, id: channel.id, name: channelLabel(channel), channels: [channel] }, channelLabel(channel));
}

async function saveLiveMessage(event: { message?: RawMessage & { channel_id?: string; guild_id?: string; }; }) {
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
        if (isLoggingBlocked(guild.id, channel.id)) return; // Blocked servers/channels stay untouched.
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
            timestamp: message.timestamp || new Date().toISOString(),
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

const dmMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!isDmChannel(channel)) return;
    const dm = channel!;
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
    description: "閲覧権限のあるサーバー内テキストチャンネルとDMをTXTとHTMLへエクスポートします",
    authors: [{ name: "aki_0", id: 0n }],
    settings,
    contextMenus: {
        "guild-context": guildMenu,
        "guild-header-popout": guildMenu,
        "channel-context": channelMenu,
        "user-context": dmMenu,
        "gdm-context": dmMenu
    },
    start() {
        if (subscribed) return;
        FluxDispatcher.subscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = true;
        Native.openLogFolder().catch(() => {});
        // Give Discord stores time to populate before starting the low-rate crawl.
        crawlTimer = setTimeout(crawlAllHistory, 10_000);
    },
    stop() {
        crawlStopped = true;
        if (crawlTimer) clearTimeout(crawlTimer);
        if (!subscribed) return;
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", saveLiveMessage);
        subscribed = false;
    }
});
