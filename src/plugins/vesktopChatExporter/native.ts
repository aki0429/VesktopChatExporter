/*
 * Vesktop Chat Exporter - native file writer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent, shell } from "electron";
import { appendFile, mkdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";

const LOG_FOLDER = "VesktopChatLogs";

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "chat-export";
}

// Records for guilds go directly under the log folder; DMs live in a "DMs" subfolder.
function rootDir(category?: string) {
    const root = join(app.getPath("documents"), LOG_FOLDER);
    return category ? join(root, safeFileName(category)) : root;
}

export async function saveLogs(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    txt: string,
    html: string
) {
    const directory = rootDir(category);
    await mkdir(directory, { recursive: true });

    const safeBase = safeFileName(baseName);
    const txtPath = join(directory, `${safeBase}.txt`);
    const htmlPath = join(directory, `${safeBase}.html`);
    await Promise.all([
        writeFile(txtPath, txt, "utf8"),
        writeFile(htmlPath, html, "utf8")
    ]);

    return { directory, txtPath, htmlPath };
}

type LiveMessage = {
    category?: string;
    guildId: string;
    guildName: string;
    channelId: string;
    channelName: string;
    messageId: string;
    timestamp: string;
    author: string;
    authorId: string;
    content: string;
    attachments: Array<{ filename: string; url: string; }>;
};

function escapeHtml(value: unknown) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function appendLiveMessage(_: IpcMainInvokeEvent, message: LiveMessage) {
    if (!/^\d{17,20}$/.test(message.guildId) || !/^\d{17,20}$/.test(message.channelId)) throw new Error("Invalid Discord ID");

    const day = new Date(message.timestamp).toISOString().slice(0, 10);
    const containerFolder = `${safeFileName(message.guildName)}_${message.guildId}`;
    const directory = join(rootDir(message.category), containerFolder);
    await mkdir(directory, { recursive: true });
    const base = `${day}_${safeFileName(message.channelName)}_${message.channelId}`;
    const txtPath = join(directory, `${base}.txt`);
    const htmlPath = join(directory, `${base}.html`);
    const links = message.attachments.map(a => `[添付] ${a.filename}: ${a.url}`).join("\n");
    const txt = `[${message.timestamp}] ${message.author} (${message.authorId})\n${message.content}${links ? `\n${links}` : ""}\n\n`;

    let newHtml = false;
    try { await stat(htmlPath); } catch { newHtml = true; }
    const article = `<article><div class="meta"><b>${escapeHtml(message.author)}</b> <span>${escapeHtml(message.timestamp)}</span> <code>${message.messageId}</code></div><div class="content">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>${message.attachments.map(a => `<a href="${escapeHtml(a.url)}">📎 ${escapeHtml(a.filename)}</a>`).join("")}</article>\n`;
    const header = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(message.guildName)} #${escapeHtml(message.channelName)}</title><style>body{max-width:1000px;margin:auto;padding:24px;background:#1e1f22;color:#dbdee1;font:14px system-ui}article{padding:10px;border-bottom:1px solid #34363b}.meta span,.meta code{color:#949ba4;font-size:11px}.content{margin:5px 0;line-height:1.5}a{display:block;color:#00a8fc;margin-top:4px}</style></head><body><h1>${escapeHtml(message.guildName)} / #${escapeHtml(message.channelName)}</h1>\n`;
    await Promise.all([
        appendFile(txtPath, txt, "utf8"),
        appendFile(htmlPath, (newHtml ? header : "") + article, "utf8")
    ]);
    return { directory, txtPath, htmlPath };
}

type HistoryMessage = LiveMessage;
type CrawlState = Record<string, { before?: string; completed?: boolean; updatedAt?: string; }>;

function statePath() {
    return join(app.getPath("userData"), "vesktop-chat-exporter-crawl-state.json");
}

export async function loadCrawlState(_: IpcMainInvokeEvent): Promise<CrawlState> {
    try {
        return JSON.parse(await readFile(statePath(), "utf8"));
    } catch {
        return {};
    }
}

export async function saveCrawlState(_: IpcMainInvokeEvent, state: CrawlState) {
    await writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

export async function saveHistoryPage(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    guildId: string,
    guildName: string,
    channelId: string,
    channelName: string,
    messages: HistoryMessage[]
) {
    if (!/^\d{17,20}$/.test(guildId) || !/^\d{17,20}$/.test(channelId) || !messages.length) return null;
    const directory = join(rootDir(category), `${safeFileName(guildName)}_${guildId}`, "History", `${safeFileName(channelName)}_${channelId}`);
    await mkdir(directory, { recursive: true });

    // A page is named by its newest/oldest snowflakes. Re-fetching the same page
    // overwrites the same files instead of duplicating the archive.
    const newest = messages[0].messageId;
    const oldest = messages[messages.length - 1].messageId;
    const base = `${newest}_${oldest}`;
    const txt = messages.map(message => {
        const links = message.attachments.map(a => `[添付] ${a.filename}: ${a.url}`).join("\n");
        return `[${message.timestamp}] ${message.author} (${message.authorId}) [${message.messageId}]\n${message.content}${links ? `\n${links}` : ""}`;
    }).join("\n\n") + "\n";
    const articles = messages.map(message => `<article><div class="meta"><b>${escapeHtml(message.author)}</b> <span>${escapeHtml(message.timestamp)}</span> <code>${message.messageId}</code></div><div class="content">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>${message.attachments.map(a => `<a href="${escapeHtml(a.url)}">📎 ${escapeHtml(a.filename)}</a>`).join("")}</article>`).join("\n");
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(guildName)} #${escapeHtml(channelName)}</title><style>body{max-width:1000px;margin:auto;padding:24px;background:#1e1f22;color:#dbdee1;font:14px system-ui}article{padding:10px;border-bottom:1px solid #34363b}.meta span,.meta code{color:#949ba4;font-size:11px}.content{margin:5px 0;line-height:1.5}a{display:block;color:#00a8fc}</style></head><body><h1>${escapeHtml(guildName)} / #${escapeHtml(channelName)}</h1>${articles}</body></html>`;
    await Promise.all([
        writeFile(join(directory, `${base}.txt`), txt, "utf8"),
        writeFile(join(directory, `${base}.html`), html, "utf8")
    ]);
    return { directory, count: messages.length, newest, oldest };
}

export async function openLogFolder(_: IpcMainInvokeEvent) {
    const directory = join(app.getPath("documents"), LOG_FOLDER);
    await mkdir(directory, { recursive: true });
    await shell.openPath(directory);
    return directory;
}
