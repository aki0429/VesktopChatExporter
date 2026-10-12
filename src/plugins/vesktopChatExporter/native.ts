/*
 * Vesktop Chat Exporter - native file writer
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent, shell } from "electron";
import { appendFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import type { CrawlState } from "./historyCrawl";
import { writeLiveArchive, LiveRecord } from "./liveArchive";

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

type LiveMessage = LiveRecord;

function escapeHtml(value: unknown) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function appendLiveMessage(_: IpcMainInvokeEvent, message: LiveMessage) {
    return writeLiveArchive(app.getPath("documents"), message);
}

type HistoryMessage = LiveMessage;


function statePath() {
    return join(app.getPath("userData"), "vesktop-chat-exporter-crawl-state.json");
}

export async function loadCrawlState(_: IpcMainInvokeEvent): Promise<CrawlState> {
    try {
        return JSON.parse(await readFile(statePath(), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
}

export async function saveCrawlState(_: IpcMainInvokeEvent, state: CrawlState) {
    await atomicJson(statePath(), state);
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

    // Keep the original newest_oldest filename contract, independently of the
    // oldest -> newest body order. Re-fetching the same page overwrites the same files.
    const ordered = [...messages].sort(compareChronologically);
    const oldest = ordered[0].messageId;
    const newest = ordered[ordered.length - 1].messageId;
    const base = `${newest}_${oldest}`;
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
        txtPartialPath: join(directory, `${safeBase}.txt.partial`),
        htmlPartialPath: join(directory, `${safeBase}.html.partial`),
        summaryPath: join(directory, `${safeBase}.summary.pending.json`),
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
    await atomicJson(paths.manifestPath, JSON.parse(manifest));
    return paths;
}

async function atomicJson(path: string, value: unknown) {
    const temporary = `${path}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function drainWrites(operations: Promise<unknown>[]) {
    const results = await Promise.allSettled(operations);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
}

export async function checkpointExport(_: IpcMainInvokeEvent, category: string | undefined, baseName: string, record: string) {
    const paths = exportPaths(category, baseName);
    await atomicJson(paths.manifestPath, JSON.parse(record));
}

export async function loadPendingExport(_: IpcMainInvokeEvent, category: string | undefined, targetId: string) {
    if (!/^\d{17,20}$/.test(targetId)) throw new Error("Invalid target ID");
    let files: string[];
    try { files = await readdir(rootDir(category)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const candidates: { base: string; manifest: any; }[] = [];
    for (const file of files) {
        if (!file.endsWith(".manifest.json")) continue;
        let manifest: any;
        try { manifest = JSON.parse(await readFile(join(rootDir(category), file), "utf8")); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        if (manifest?.tool !== "VesktopChatExporter" || manifest.version !== 2 || manifest.targetId !== targetId
            || manifest.outcome === "complete" || !Array.isArray(manifest.progress)) continue;
        if (manifest.progress.some((p: any) => !p?.channel || !/^\d{17,20}$/.test(p.channel.id)
            || ![0, 1, 2, 3, 5, 10, 11, 12, 13].includes(p.channel.type)
            || p.channel.guild_id && p.channel.guild_id !== targetId
            || p.channel.parent_id && !/^\d{17,20}$/.test(p.channel.parent_id)
            || p.before && !/^\d{17,20}$/.test(p.before)
            || !Number.isSafeInteger(p.messages) || p.messages < 0
            || p.completed !== undefined && typeof p.completed !== "boolean"
            || !Array.isArray(p.pages) || p.pages.some((name: string) => !/^\d{17,20}_\d{17,20}$/.test(name)))) continue;
        candidates.push({ base: file.slice(0, -".manifest.json".length), manifest });
    }
    candidates.sort((a, b) => String(b.manifest.started).localeCompare(String(a.manifest.started)));
    return candidates[0] ?? null;
}

export async function abortExportFiles(_: IpcMainInvokeEvent, category: string | undefined, baseName: string) {
    const paths = exportPaths(category, baseName);
    await drainWrites([paths.txtPath, paths.htmlPath, paths.txtPartialPath, paths.htmlPartialPath, paths.summaryPath]
        .map(file => rm(file, { force: true })));
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
    // Every attempt begins unpublished; never present a header or torn TXT/HTML pair as final.
    await abortExportFiles(_, category, baseName);
    await drainWrites([
        writeFile(paths.txtPartialPath, txtHeader, "utf8"),
        writeFile(paths.htmlPartialPath, htmlHeader, "utf8")
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
    if (fragment.txt) writes.push(appendFile(paths.txtPartialPath, fragment.txt, "utf8"));
    if (fragment.html) writes.push(appendFile(paths.htmlPartialPath, fragment.html, "utf8"));
    await drainWrites(writes);
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
    const started = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    const finished = JSON.parse(summary);
    await drainWrites([
        appendFile(paths.txtPartialPath, txtFooter, "utf8"),
        appendFile(paths.htmlPartialPath, htmlFooter, "utf8")
    ]);
    await atomicJson(paths.summaryPath, { ...started, ...finished });
    const [txt, html] = await Promise.all([stat(paths.txtPartialPath), stat(paths.htmlPartialPath)]);
    return { ...paths, bytes: { txt: txt.size, html: html.size } };
}

export async function publishExport(_: IpcMainInvokeEvent, category: string | undefined, baseName: string) {
    const paths = exportPaths(category, baseName);
    const summary = JSON.parse(await readFile(paths.summaryPath, "utf8"));
    try {
        await rename(paths.txtPartialPath, paths.txtPath);
        await rename(paths.htmlPartialPath, paths.htmlPath);
        await atomicJson(paths.manifestPath, summary);
    } catch (error) {
        try { await abortExportFiles(_, category, baseName); } catch { /* Renderer independently records failure. */ }
        throw error;
    }
    // Publication is committed. A leftover cleanup record must not delete a complete pair.
    let cleanupPending = false;
    try { await rm(paths.summaryPath, { force: true }); } catch { cleanupPending = true; }
    const [txt, html, manifest] = await Promise.all([stat(paths.txtPath), stat(paths.htmlPath), stat(paths.manifestPath)]);
    return { ...paths, cleanupPending, bytes: { txt: txt.size, html: html.size, manifest: manifest.size } };
}

// An export that produced no message at all leaves nothing behind, so a blocked or failed run does
// not litter the log folder with empty files.
export async function discardExport(_: IpcMainInvokeEvent, category: string | undefined, baseName: string) {
    const paths = exportPaths(category, baseName);
    await abortExportFiles(_, category, baseName);
    await rm(paths.manifestPath, { force: true });
    await rm(paths.partsDir, { recursive: true, force: true });
    return { removed: 3 };
}

// Per-page JSON parts: every fetched page is serialised to `<oldest>_<newest>.jsonl` the moment it
// arrives, oldest message first, inside the run's own `.parts` folder. Nothing survives in memory
// between pages, a crashed run keeps every page it had already reached, and the aggregate is later
// assembled from these files. Keeping them inside the run folder means access revoked mid-run can
// be honoured by deleting this run's parts without touching an older archive.
function partsDir(category: string | undefined, baseName: string, channelId: string, channelName: string) {
    return join(rootDir(category), `${safeFileName(baseName)}.parts`, channelId);
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
    if (messages.length > 100 || messages.some(message => !/^\d{17,20}$/.test(message.messageId) || message.channelId !== channelId)
        || new Set(messages.map(message => message.messageId)).size !== messages.length) throw new Error("Invalid history page");
    const ordered = [...messages].sort(compareChronologically);
    const directory = partsDir(category, baseName, channelId, channelName);
    await mkdir(directory, { recursive: true });
    const base = `${ordered[0].messageId}_${ordered[ordered.length - 1].messageId}`;
    const path = join(directory, `${base}.json`);
    const temporary = `${path}.tmp`;
    try {
        await writeFile(temporary, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
        await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
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
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return names
        .filter(name => /^\d{17,20}_\d{17,20}\.jsonl?$/.test(name))
        .map(name => name.replace(/\.jsonl?$/, ""))
        .filter((name, index, all) => all.indexOf(name) === index)
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
    const directory = partsDir(category, baseName, channelId, channelName);
    let messages: HistoryMessage[];
    try {
        messages = JSON.parse(await readFile(join(directory, `${base}.json`), "utf8"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const text = await readFile(join(directory, `${base}.jsonl`), "utf8");
        messages = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as HistoryMessage);
    }
    if (!Array.isArray(messages)) throw new Error("Invalid stored chat JSON");
    if (!messages.length || messages.length > 100 || messages.some(message => !/^\d{17,20}$/.test(message.messageId) || message.channelId !== channelId)
        || new Set(messages.map(message => message.messageId)).size !== messages.length
        || messages.some((message, index) => index > 0 && compareIds(messages[index - 1].messageId, message.messageId) >= 0)
        || `${messages[0].messageId}_${messages[messages.length - 1].messageId}` !== base) throw new Error("Invalid stored history page");
    return messages;
}

// Access revoked while a run was already under way: this run must leave no trace of the channel.
export async function listExportChannelIds(_: IpcMainInvokeEvent, category: string | undefined, baseName: string) {
    let entries;
    try { entries = await readdir(exportPaths(category, baseName).partsDir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (entries.some(entry => !entry.isDirectory() || !/^\d{17,20}$/.test(entry.name)))
        throw new Error("Invalid export channel directory");
    return entries.map(entry => entry.name);
}

export async function purgeChannelPages(_: IpcMainInvokeEvent, category: string | undefined, baseName: string, channelId: string) {
    if (!/^\d{17,20}$/.test(channelId)) throw new Error("Invalid channel ID");
    await rm(partsDir(category, baseName, channelId, ""), { recursive: true, force: true });
}

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
        await drainWrites([".json", ".jsonl"].map(extension => rm(join(directory, `${base}${extension}`), { force: true })));
        removed++;
    }
    // Removing only the files still leaves a private channel's id/name in its folder. rmdir is
    // intentionally non-recursive so selective page deletion cannot erase pages that remain.
    try { await rmdir(directory); }
    catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    return { removed };
}

export async function openLogFolder(_: IpcMainInvokeEvent) {
    const directory = join(app.getPath("documents"), LOG_FOLDER);
    await mkdir(directory, { recursive: true });
    await shell.openPath(directory);
    return directory;
}
