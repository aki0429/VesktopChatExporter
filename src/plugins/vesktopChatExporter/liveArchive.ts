/*
 * Vesktop Chat Exporter - durable live archive
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createReadStream } from "fs";
import { appendFile, copyFile, mkdir, open, rename, rm, stat, writeFile } from "fs/promises";
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

const queues = new Map<string, Promise<void>>();
type Segment = { start: number; end: number; lines?: number; };
const HTML_FOOTER = "</body></html>\n";

function recordDay(message: LiveRecord) {
    if (!message || ![message.guildId, message.channelId, message.messageId].every(value => typeof value === "string" && /^\d{17,20}$/.test(value))) throw new Error("Invalid Discord ID");
    if (![message.guildName, message.channelName, message.timestamp, message.author, message.authorId, message.content].every(value => typeof value === "string")
        || (message.category !== undefined && typeof message.category !== "string")
        || !Array.isArray(message.attachments)
        || message.attachments.some(a => !a || typeof a.filename !== "string" || typeof a.url !== "string")) throw new Error("Invalid live record");
    if (/[\r\n]/.test(message.author) || /[\r\n]/.test(message.authorId)) throw new Error("Invalid live author");
    const date = new Date(message.timestamp);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid live timestamp");
    return date.toISOString().slice(0, 10);
}

function safeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "chat-export";
}

export async function writeLiveArchive(documentsRoot: string, message: LiveRecord) {
    const day = recordDay(message);
    const category = message.category ? safeFileName(message.category) : undefined;
    const directory = join(documentsRoot, "VesktopChatLogs", ...(category ? [category] : []), `${safeFileName(message.guildName)}_${message.guildId}`);
    const base = `${day}_${safeFileName(message.channelName)}_${message.channelId}`;
    const txtPath = join(directory, `${base}.txt`);
    const htmlPath = join(directory, `${base}.html`);
    const operation = (queues.get(txtPath) ?? Promise.resolve()).then(() => writeArchive(directory, txtPath, htmlPath, message));
    const tail = operation.then(() => {}, () => {});
    queues.set(txtPath, tail);
    void tail.then(() => { if (queues.get(txtPath) === tail) queues.delete(txtPath); });
    return operation;
}

// Only IDs and byte ranges stay in memory. Existing human-readable files are
// the only persisted source; legacy JSON and record directories are not opened.
async function* byteLines(path: string) {
    const input = createReadStream(path, { highWaterMark: 64 * 1024 });
    let parts: Buffer[] = [];
    let offset = 0;
    try {
        for await (const chunk of input) {
            let start = 0;
            for (let lf = chunk.indexOf(10, start); lf !== -1; lf = chunk.indexOf(10, start)) {
                parts.push(chunk.subarray(start, lf));
                const line = Buffer.concat(parts);
                offset += line.length + 1;
                yield { line: line.toString("utf8"), end: offset };
                parts = [];
                start = lf + 1;
            }
            if (start < chunk.length) parts.push(chunk.subarray(start));
        }
        if (parts.length) {
            const line = Buffer.concat(parts);
            yield { line: line.toString("utf8"), end: offset + line.length };
        }
    } finally { input.destroy(); }
}

async function indexFile(path: string, html: boolean, expectedTxt?: Array<{ id: string; lines: number; }>) {
    const entries = new Map<string, Segment>();
    let size: number;
    try { size = (await stat(path)).size; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
        throw error;
    }

    let offset = 0;
    let pending: { id: string; start: number; } | undefined;
    let remaining = 0;
    {
        for await (const { line, end } of byteLines(path)) {
            if (html) {
                if (line.startsWith("<article>")) {
                    if (pending) throw new Error("Invalid live HTML article");
                    const id = /<code>(\d{17,20})<\/code>/.exec(line)?.[1];
                    if (!id || entries.has(id)) throw new Error("Invalid live HTML ID");
                    pending = { id, start: offset };
                    remaining = 1; // final blank line in TXT
                }
                if (pending) remaining += 1 + (line.match(/<br>/g)?.length ?? 0) + (line.match(/<a href=|<div>📎 /g)?.length ?? 0);
                if (pending && line.endsWith("</article>")) {
                    entries.set(pending.id, { start: pending.start, end, lines: remaining });
                    pending = undefined;
                }
            } else {
                // HTML supplies the exact number of body lines for each real
                // article. Header-shaped content is never a boundary candidate.
                const expected = expectedTxt?.[entries.size];
                if (!pending && expected) {
                    const id = /^\[[^\]\r\n]+\] .* \([^\r\n]*\) \[(\d{17,20})\]$/.exec(line)?.[1];
                    if (id !== expected.id) throw new Error("Invalid live TXT/HTML boundary");
                    pending = { id, start: offset };
                    remaining = expected.lines;
                } else if (pending && --remaining === 0) {
                    entries.set(pending.id, { start: pending.start, end });
                    pending = undefined;
                }
            }
            offset = end;
        }
        if (pending) {
            throw new Error("Incomplete live archive article");
        }
        if (!html && (offset !== size || entries.size !== expectedTxt?.length)) throw new Error("Invalid live TXT archive");
    }
    return entries;
}

async function copySegment(source: string, target: string, segment: Segment) {
    const file = await open(source, "r");
    try {
        const buffer = Buffer.alloc(64 * 1024);
        for (let position = segment.start; position < segment.end;) {
            const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, segment.end - position), position);
            if (!bytesRead) throw new Error("Live archive changed during publication");
            await appendFile(target, buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
    } finally { await file.close(); }
}

async function writeArchive(directory: string, txtPath: string, htmlPath: string, message: LiveRecord) {
    await mkdir(directory, { recursive: true });
    await recoverPair(txtPath, htmlPath);
    const html = await indexFile(htmlPath, true);
    const txt = await indexFile(txtPath, false, [...html].map(([id, segment]) => ({ id, lines: segment.lines! })));
    const ids = new Set([...txt.keys(), ...html.keys(), message.messageId]);
    for (const id of ids) {
        if (id !== message.messageId && (!txt.has(id) || !html.has(id))) throw new Error("Incomplete live archive pair; retry the missing ID");
    }
    const ordered = [...ids].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    if (txt.has(message.messageId) && html.has(message.messageId)) {
        await rm(`${txtPath}.stage`, { force: true });
        await rm(`${htmlPath}.stage`, { force: true });
        return { directory, txtPath, htmlPath, count: ordered.length };
    }
    if (html.size && ordered[ordered.length - 1] === message.messageId) {
        try {
            await prepareRollback(txtPath, htmlPath);
            await appendFile(txtPath, formatTxt(message), "utf8");
            const file = await open(htmlPath, "r+");
            try {
                const size = (await file.stat()).size;
                const footer = Buffer.alloc(Buffer.byteLength(HTML_FOOTER));
                const { bytesRead } = await file.read(footer, 0, footer.length, size - footer.length);
                if (bytesRead !== footer.length || footer.toString("utf8") !== HTML_FOOTER) throw new Error("Invalid live HTML footer");
                await file.truncate(size - footer.length);
            } finally { await file.close(); }
            await appendFile(htmlPath, formatHtml(message) + HTML_FOOTER, "utf8");
            await rm(`${txtPath}.rollback.stage`, { force: true });
        } catch (error) {
            await recoverPair(txtPath, htmlPath);
            throw error;
        } finally {
            await rm(`${txtPath}.rollback.prepare.stage`, { force: true });
            if (!await exists(`${txtPath}.rollback.stage`)) {
                await rm(`${txtPath}.backup.stage`, { force: true });
                await rm(`${htmlPath}.backup.stage`, { force: true });
            }
        }
        return { directory, txtPath, htmlPath, count: ordered.length };
    }
    const txtStage = `${txtPath}.stage`;
    const htmlStage = `${htmlPath}.stage`;
    try {
        // Unlink first: a crash-left hard link must not truncate a final file.
        await rm(txtStage, { force: true });
        await rm(htmlStage, { force: true });
        await writeFile(txtStage, "", "utf8");
        await writeFile(htmlStage, htmlHeader(message), "utf8");
        for (const id of ordered) {
            if (txt.has(id)) await copySegment(txtPath, txtStage, txt.get(id)!);
            else await appendFile(txtStage, formatTxt(message), "utf8");
            if (html.has(id)) await copySegment(htmlPath, htmlStage, html.get(id)!);
            else await appendFile(htmlStage, formatHtml(message), "utf8");
        }
        await appendFile(htmlStage, HTML_FOOTER, "utf8");
        await prepareRollback(txtPath, htmlPath);
        await rename(txtStage, txtPath);
        await rename(htmlStage, htmlPath);
        await rm(`${txtPath}.rollback.stage`, { force: true });
    } catch (error) {
        await recoverPair(txtPath, htmlPath);
        throw error;
    } finally {
        await rm(txtStage, { force: true });
        await rm(htmlStage, { force: true });
        await rm(`${txtPath}.rollback.prepare.stage`, { force: true });
        if (!await exists(`${txtPath}.rollback.stage`)) {
            await rm(`${txtPath}.backup.stage`, { force: true });
            await rm(`${htmlPath}.backup.stage`, { force: true });
        }
    }
    return { directory, txtPath, htmlPath, count: ordered.length };
}

async function exists(path: string) {
    try { await stat(path); return true; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function prepareRollback(txtPath: string, htmlPath: string) {
    const hadPair = await exists(txtPath);
    if (hadPair !== await exists(htmlPath)) throw new Error("Incomplete live archive pair");
    for (const path of [txtPath, htmlPath]) {
        await rm(`${path}.backup.stage`, { force: true });
        if (hadPair) await copyFile(path, `${path}.backup.stage`);
    }
    // Publish the marker only after both backups are complete.
    await rm(`${txtPath}.rollback.prepare.stage`, { force: true });
    await writeFile(`${txtPath}.rollback.prepare.stage`, hadPair ? "pair\n" : "empty\n", "utf8");
    await rename(`${txtPath}.rollback.prepare.stage`, `${txtPath}.rollback.stage`);
}

async function recoverPair(txtPath: string, htmlPath: string) {
    const marker = `${txtPath}.rollback.stage`;
    if (!await exists(marker)) return;
    const file = await open(marker, "r");
    const buffer = Buffer.alloc(16);
    let state: string;
    try {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        state = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await file.close(); }
    if (state !== "pair\n" && state !== "empty\n") throw new Error("Invalid live rollback marker");
    // Keep backups and marker until BOTH restorations complete. A crash in
    // this loop can therefore be retried without consuming either backup.
    for (const path of [txtPath, htmlPath]) {
        if (state === "pair\n") await copyFile(`${path}.backup.stage`, path);
        else await rm(path, { force: true });
    }
    await rm(marker, { force: true });
    for (const path of [txtPath, htmlPath]) await rm(`${path}.backup.stage`, { force: true });
}
