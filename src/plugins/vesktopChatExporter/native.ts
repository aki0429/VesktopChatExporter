/*
 * Vesktop Chat Exporter - native file writer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent, shell } from "electron";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
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

function snowflakeOf(value: string): bigint | null {
    return /^\d{17,20}$/.test(value) ? BigInt(value) : null;
}

// Snowflake ids embed the send time, so they order messages reliably even when the
// timestamp formats of two events differ (e.g. ".180000+00:00" vs ".212Z").
function compareChronologically(a: HistoryMessage, b: HistoryMessage) {
    const left = snowflakeOf(a.messageId);
    const right = snowflakeOf(b.messageId);
    if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;
    const at = Date.parse(a.timestamp ?? "");
    const bt = Date.parse(b.timestamp ?? "");
    if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt) return at - bt;
    return 0;
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

    // Nothing may be dropped, the archive must read oldest -> newest: Discord pages
    // arrive newest -> oldest, so sort them back into chronological order and name the
    // chunk by its oldest snowflake first. A re-fetch of the same page overwrites the
    // same two files instead of duplicating the archive.
    const ordered = [...messages].sort(compareChronologically);
    const oldest = ordered[0].messageId;
    const newest = ordered[ordered.length - 1].messageId;
    const base = `${oldest}_${newest}`;
    const txt = ordered.map(message => {
        const links = message.attachments.map(a => `[添付] ${a.filename}: ${a.url}`).join("\n");
        return `[${message.timestamp}] ${message.author} (${message.authorId}) [${message.messageId}]\n${message.content}${links ? `\n${links}` : ""}`;
    }).join("\n\n") + "\n";
    const articles = ordered.map(message => `<article><div class="meta"><b>${escapeHtml(message.author)}</b> <span>${escapeHtml(message.timestamp)}</span> <code>${message.messageId}</code></div><div class="content">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>${message.attachments.map(a => `<a href="${escapeHtml(a.url)}">📎 ${escapeHtml(a.filename)}</a>`).join("")}</article>`).join("\n");
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(guildName)} #${escapeHtml(channelName)}</title><style>body{max-width:1000px;margin:auto;padding:24px;background:#1e1f22;color:#dbdee1;font:14px system-ui}article{padding:10px;border-bottom:1px solid #34363b}.meta span,.meta code{color:#949ba4;font-size:11px}.content{margin:5px 0;line-height:1.5}a{display:block;color:#00a8fc}</style></head><body><h1>${escapeHtml(guildName)} / #${escapeHtml(channelName)}</h1>${articles}</body></html>`;
    await Promise.all([
        writeFile(join(directory, `${base}.txt`), txt, "utf8"),
        writeFile(join(directory, `${base}.html`), html, "utf8")
    ]);
    return { directory, count: messages.length, newest, oldest };
}

// Streaming export: the run's aggregate files are opened up front, then filled page by page from
// the per-page JSON files already on disk (see writeHistoryPageJson). A server with hundreds of
// thousands of messages therefore never has to fit in renderer memory, and a crash keeps every
// page written so far. The per-page JSONL files are the canonical, re-parseable record.
function exportPaths(category: string | undefined, baseName: string) {
    const directory = rootDir(category);
    const safeBase = safeFileName(baseName);
    return {
        directory,
        base: safeBase,
        partsDir: join(directory, `${safeBase}.parts`),
        txtPath: join(directory, `${safeBase}.txt`),
        htmlPath: join(directory, `${safeBase}.html`),
        manifestPath: join(directory, `${safeBase}.manifest.json`)
    };
}

export async function beginExport(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    manifest: string
) {
    const paths = exportPaths(category, baseName);
    await mkdir(paths.directory, { recursive: true });
    // Only the run stub is written here. The aggregate files are created after the phase-2
    // authorization re-check (startExportFiles) so their header and navigation can be built from the
    // channels the run really saved.
    await writeFile(paths.manifestPath, manifest, "utf8");
    return paths;
}

// The aggregate files are opened only once every channel has been re-checked, so a channel revoked
// mid-run can never appear in the saved output, not even as a navigation link or a name.
export async function startExportFiles(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    txtHeader: string,
    htmlHeader: string
) {
    const paths = exportPaths(category, baseName);
    await mkdir(paths.directory, { recursive: true });
    await Promise.all([
        writeFile(paths.txtPath, txtHeader, "utf8"),
        writeFile(paths.htmlPath, htmlHeader, "utf8")
    ]);
    return paths;
}

export async function appendExport(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    fragment: { txt?: string; html?: string; }
) {
    const paths = exportPaths(category, baseName);
    const writes: Promise<unknown>[] = [];
    if (fragment.txt) writes.push(appendFile(paths.txtPath, fragment.txt, "utf8"));
    if (fragment.html) writes.push(appendFile(paths.htmlPath, fragment.html, "utf8"));
    await Promise.all(writes);
    return { written: writes.length };
}

export async function finishExport(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    summary: string,
    txtFooter: string,
    htmlFooter: string
) {
    const paths = exportPaths(category, baseName);
    await Promise.all([
        appendFile(paths.txtPath, txtFooter, "utf8"),
        appendFile(paths.htmlPath, htmlFooter, "utf8"),
        appendFile(paths.manifestPath, `\n${summary}`, "utf8")
    ]);
    const [txt, html, manifest] = await Promise.all([stat(paths.txtPath), stat(paths.htmlPath), stat(paths.manifestPath)]);
    return { ...paths, bytes: { txt: txt.size, html: html.size, manifest: manifest.size } };
}

// An export that produced no message at all leaves nothing behind, so a blocked or failed run does
// not litter the log folder with empty files.
export async function discardExport(_: IpcMainInvokeEvent, category: string | undefined, baseName: string) {
    const paths = exportPaths(category, baseName);
    await Promise.all([paths.txtPath, paths.htmlPath, paths.manifestPath].map(file => rm(file, { force: true })));
    await rm(paths.partsDir, { recursive: true, force: true });
    return { removed: 3 };
}

// Per-page JSON parts: every fetched page is serialised to `<oldest>_<newest>.jsonl` the moment it
// arrives, oldest message first, inside the run's own `.parts` folder. Nothing survives in memory
// between pages, a crashed run keeps every page it had already reached, and the aggregate is later
// assembled from these files. Keeping them inside the run folder means access revoked mid-run can
// be honoured by deleting this run's parts without touching an older archive.
function partsDir(category: string | undefined, baseName: string, channelId: string, channelName: string) {
    return join(rootDir(category), `${safeFileName(baseName)}.parts`, `${channelId}_${safeFileName(channelName)}`);
}

function compareIds(left: string, right: string) {
    const a = snowflakeOf(left);
    const b = snowflakeOf(right);
    if (a !== null && b !== null) return a < b ? -1 : a > b ? 1 : 0;
    return left < right ? -1 : left > right ? 1 : 0;
}

export async function writeHistoryPageJson(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    channelId: string,
    channelName: string,
    messages: HistoryMessage[]
) {
    if (!/^\d{17,20}$/.test(channelId) || !messages.length) return null;
    const ordered = [...messages].sort(compareChronologically);
    const directory = partsDir(category, baseName, channelId, channelName);
    await mkdir(directory, { recursive: true });
    const base = `${ordered[0].messageId}_${ordered[ordered.length - 1].messageId}`;
    const path = join(directory, `${base}.jsonl`);
    await writeFile(path, `${ordered.map(message => JSON.stringify(message)).join("\n")}\n`, "utf8");
    return { base, path, count: ordered.length };
}

export async function listHistoryPages(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    channelId: string,
    channelName: string
) {
    if (!/^\d{17,20}$/.test(channelId)) return [];
    const directory = partsDir(category, baseName, channelId, channelName);
    const names = await readdir(directory).catch(() => [] as string[]);
    return names
        .filter(name => name.endsWith(".jsonl"))
        .map(name => name.slice(0, -".jsonl".length))
        .sort((left, right) => compareIds(left.split("_")[0], right.split("_")[0]));
}

export async function readHistoryPage(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    channelId: string,
    channelName: string,
    base: string
) {
    if (!/^\d{17,20}$/.test(channelId)) throw new Error("不正なチャンネルIDです");
    if (!/^\d{17,20}_\d{17,20}$/.test(base)) throw new Error("不正な履歴ページ名です");
    const text = await readFile(join(partsDir(category, baseName, channelId, channelName), `${base}.jsonl`), "utf8");
    return text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as HistoryMessage);
}

// Access revoked while a run was already under way: this run must leave no trace of the channel.
export async function discardHistoryPages(
    _: IpcMainInvokeEvent,
    category: string | undefined,
    baseName: string,
    channelId: string,
    channelName: string,
    bases: string[]
) {
    if (!/^\d{17,20}$/.test(channelId)) return { removed: 0 };
    const directory = partsDir(category, baseName, channelId, channelName);
    let removed = 0;
    for (const base of bases) {
        if (!/^\d{17,20}_\d{17,20}$/.test(base)) continue;
        await rm(join(directory, `${base}.jsonl`), { force: true });
        removed++;
    }
    return { removed };
}

export async function openLogFolder(_: IpcMainInvokeEvent) {
    const directory = join(app.getPath("documents"), LOG_FOLDER);
    await mkdir(directory, { recursive: true });
    await shell.openPath(directory);
    return directory;
}
