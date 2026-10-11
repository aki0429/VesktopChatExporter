/*
 * Vesktop Chat Exporter - durable live archive
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { appendFile, link, mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from "fs/promises";
import { join } from "path";

export type LiveRecord = {
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

function formatTxt(message: LiveRecord) {
    const links = message.attachments.map(a => `[添付] ${a.filename}: ${a.url}`).join("\n");
    return `[${message.timestamp}] ${message.author} (${message.authorId}) [${message.messageId}]\n${message.content}${links ? `\n${links}` : ""}\n\n`;
}

function formatHtml(message: LiveRecord) {
    const attachments = message.attachments.map(a => /^https?:\/\/[^\s]+$/i.test(a.url)
        ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">📎 ${escapeHtml(a.filename)}</a>`
        : `<div>📎 ${escapeHtml(a.filename)}: ${escapeHtml(a.url)}</div>`).join("");
    return `<article><div class="meta"><b>${escapeHtml(message.author)}</b> <span>${escapeHtml(message.timestamp)}</span> <code>${escapeHtml(message.messageId)}</code></div><div class="content">${escapeHtml(message.content).replace(/\n/g, "<br>")}</div>${attachments}</article>\n`;
}

function htmlHeader(message: LiveRecord) {
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(message.guildName)} #${escapeHtml(message.channelName)}</title><style>body{max-width:1000px;margin:auto;padding:24px;background:#1e1f22;color:#dbdee1;font:14px system-ui}article{padding:10px;border-bottom:1px solid #34363b}.meta span,.meta code{color:#949ba4;font-size:11px}.content{margin:5px 0;line-height:1.5}a{display:block;color:#00a8fc;margin-top:4px}</style></head><body><h1>${escapeHtml(message.guildName)} / #${escapeHtml(message.channelName)}</h1>\n`;
}

type ArchivePaths = { directory: string; recordsDirectory: string; txtPath: string; htmlPath: string; };
const queues = new Map<string, Promise<void>>();
type PublishedState = { count: number; newest: string; txtSize: number; htmlSize: number; };
const published = new Map<string, PublishedState>();
const HTML_FOOTER = "</body></html>\n";

function recordDay(message: LiveRecord) {
    if (!message || ![message.guildId, message.channelId, message.messageId].every(value => typeof value === "string" && /^\d{17,20}$/.test(value))) throw new Error("Invalid Discord ID");
    if (![message.guildName, message.channelName, message.timestamp, message.author, message.authorId, message.content].every(value => typeof value === "string")
        || (message.category !== undefined && typeof message.category !== "string")
        || !Array.isArray(message.attachments)
        || message.attachments.some(a => !a || typeof a.filename !== "string" || typeof a.url !== "string")) throw new Error("Invalid live record");
    const date = new Date(message.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid live timestamp");
    return date.toISOString().slice(0, 10);
}

export async function writeLiveArchive(documentsRoot: string, message: LiveRecord) {
    const day = recordDay(message);
    // A new namespace leaves every legacy daily log untouched. Display names never
    // participate in the key, so renaming a server/channel cannot split an archive.
    const category = message.category?.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/g, "").slice(0, 180);
    const directory = join(documentsRoot, "VesktopChatLogs", ...(category ? [category] : []), "Live", message.guildId, message.channelId);
    const paths = {
        directory,
        recordsDirectory: join(directory, `${day}.records`),
        txtPath: join(directory, `${day}.txt`),
        htmlPath: join(directory, `${day}.html`)
    };
    const key = paths.txtPath;
    const operation = (queues.get(key) ?? Promise.resolve()).then(() => writeArchive(paths, message)).catch(error => {
        published.delete(key);
        throw error;
    });
    // The queue tail includes rejection and finally cleanup, but cannot poison the
    // following retry. The caller still observes the original failure.
    const tail = operation.then(() => {}, () => {});
    queues.set(key, tail);
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return operation;
}

async function writeArchive({ directory, recordsDirectory, txtPath, htmlPath }: ArchivePaths, message: LiveRecord) {
    await mkdir(recordsDirectory, { recursive: true });
    const recordPath = join(recordsDirectory, `${message.messageId}.json`);
    const recordStage = `${recordPath}.stage`;
    let added = false;
    try {
        // A crash after link() may leave the stage sharing the canonical inode.
        // Unlink it before writing, never truncate the committed record via it.
        await rm(recordStage, { force: true });
        await writeFile(recordStage, `${JSON.stringify(message)}\n`, "utf8");
        // Linking a complete stage is atomic and exclusive: a canonical ID can
        // never be a half-written JSON file or be overwritten by a duplicate.
        try { await link(recordStage, recordPath); added = true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    } finally {
        await rm(recordStage, { force: true });
    }

    const state = published.get(txtPath);
    if (added && state && BigInt(message.messageId) > BigInt(state.newest)) {
        let intact = false;
        try {
            const txt = await stat(txtPath);
            const html = await stat(htmlPath);
            intact = txt.size === state.txtSize && html.size === state.htmlSize;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (intact) {
            await appendFile(txtPath, formatTxt(message), "utf8");
            await truncate(htmlPath, state.htmlSize - HTML_FOOTER.length);
            await appendFile(htmlPath, formatHtml(message) + HTML_FOOTER, "utf8");
            await rememberPublished(txtPath, htmlPath, state.count + 1, message.messageId);
            return { directory, txtPath, htmlPath, count: state.count + 1 };
        }
    }

    const names = (await readdir(recordsDirectory)).filter(name => /^\d{17,20}\.json$/.test(name));
    if (!names.length || !names.includes(`${message.messageId}.json`)) throw new Error("Canonical live record missing");
    names.sort((left, right) => BigInt(left.slice(0, -5)) < BigInt(right.slice(0, -5)) ? -1 : 1);
    const txtStage = `${txtPath}.stage`;
    const htmlStage = `${htmlPath}.stage`;
    try {
        await writeFile(txtStage, "", "utf8");
        await writeFile(htmlStage, htmlHeader(message), "utf8");
        // Only filenames are sorted in memory; each canonical message is parsed,
        // formatted and released before the following record is read.
        for (const name of names) {
            const record = JSON.parse(await readFile(join(recordsDirectory, name), "utf8")) as LiveRecord;
            if (recordDay(record) !== recordDay(message) || record.messageId !== name.slice(0, -5)
                || record.guildId !== message.guildId || record.channelId !== message.channelId) throw new Error("Invalid canonical live record");
            await appendFile(txtStage, formatTxt(record), "utf8");
            await appendFile(htmlStage, formatHtml(record), "utf8");
        }
        await appendFile(htmlStage, HTML_FOOTER, "utf8");
        // No final file is truncated or published while the rebuild is incomplete.
        await rename(txtStage, txtPath);
        await rename(htmlStage, htmlPath);
    } finally {
        await rm(txtStage, { force: true });
        await rm(htmlStage, { force: true });
    }
    await rememberPublished(txtPath, htmlPath, names.length, names[names.length - 1].slice(0, -5));
    return { directory, txtPath, htmlPath, count: names.length };
}

async function rememberPublished(txtPath: string, htmlPath: string, count: number, newest: string) {
    const txt = await stat(txtPath);
    const html = await stat(htmlPath);
    published.delete(txtPath);
    published.set(txtPath, { count, newest, txtSize: txt.size, htmlSize: html.size });
    // Eviction only loses the ascending fast path: canonical records remain the
    // source of truth and a future write rebuilds the evicted day.
    while (published.size > 5000) published.delete(published.keys().next().value!);
}
