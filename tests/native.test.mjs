import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { id, loadPlugin } from "./harness.mjs";

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL("../src/plugins/vesktopChatExporter/native.ts", import.meta.url));

async function loadNative(dir) {
    const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"] }).outputFiles[0].text;
    const context = { module: { exports: {} }, require: name => name === "electron" ? { app: { getPath: () => dir }, shell: { openPath: async () => "" } } : require(name) };
    vm.runInNewContext(code, context);
    return context.module.exports;
}

const part = (channelId, n, channelName = "chrono") => ({
    guildId: id(3), guildName: "Fixture", channelId, channelName,
    messageId: id(n), timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    author: "fixture", authorId: id(21), content: `chrono ${n}`, attachments: []
});

test("history chunks are stored oldest-first so the archive reads chronologically", async () => {
    const scratch = process.env.TMPDIR;
    assert.ok(scratch, "TMPDIR must point to the test scratch directory");
    const dir = await mkdtemp(path.join(scratch, "vesktop-order-test-"));
    try {
        const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"] }).outputFiles[0].text;
        const context = { module: { exports: {} }, require: name => name === "electron" ? { app: { getPath: () => dir }, shell: { openPath: async () => "" } } : require(name) };
        vm.runInNewContext(code, context);
        const native = context.module.exports;
        const entry = n => ({
            category: undefined, guildId: id(3), guildName: "Fixture", channelId: id(5), channelName: "chrono",
            messageId: id(n), timestamp: `2026-01-01T00:00:${String(n - 10).padStart(2, "0")}.000Z`,
            author: "fixture", authorId: id(21), content: `chrono ${n}`, attachments: []
        });
        // The Discord API hands pages over newest -> oldest.
        const page = [entry(12), entry(11), entry(10)];
        const history = await native.saveHistoryPage(null, undefined, id(3), "Fixture", id(5), "chrono", page);

        const base = `${id(10)}_${id(12)}`;
        assert.deepEqual((await readdir(history.directory)).sort(), [`${base}.html`, `${base}.txt`]);
        assert.equal(history.oldest, id(10));
        assert.equal(history.newest, id(12));

        const txt = await readFile(path.join(history.directory, `${base}.txt`), "utf8");
        assert.deepEqual([...txt.matchAll(/chrono (\d+)/g)].map(match => Number(match[1])), [10, 11, 12]);
        const html = await readFile(path.join(history.directory, `${base}.html`), "utf8");
        assert.ok(html.indexOf("chrono 10") < html.indexOf("chrono 11"));
        assert.ok(html.indexOf("chrono 11") < html.indexOf("chrono 12"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("real native writer saves DM, group DM and forum/thread TXT/HTML in isolated folders", async () => {
    const scratch = process.env.TMPDIR;
    assert.ok(scratch, "TMPDIR must point to the test scratch directory");
    const dir = await mkdtemp(path.join(scratch, "vesktop-writer-test-"));
    try {
        const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"] }).outputFiles[0].text;
        const context = { module: { exports: {} }, require: name => name === "electron" ? { app: { getPath: () => dir }, shell: { openPath: async () => "" } } : require(name) };
        vm.runInNewContext(code, context);
        const native = context.module.exports;
        for (const [kind, category, guildId, channelId] of [
            ["DM", "DMs", id(1), id(1)],
            ["group DM", "DMs", id(2), id(2)],
            ["forum post", undefined, id(3), id(4)],
            ["thread", undefined, id(3), id(5)]
        ]) {
            const message = { category, guildId, guildName: "Fixture", channelId, channelName: kind, messageId: id(20), timestamp: "2026-01-01T00:00:00.000Z", author: "fixture", authorId: id(21), content: `<fixture> ${kind}`, attachments: [] };
            const live = await native.appendLiveMessage(null, message);
            assert.match(await readFile(live.txtPath, "utf8"), /<fixture>/);
            assert.match(await readFile(live.htmlPath, "utf8"), /&lt;fixture&gt;/);
            const history = await native.saveHistoryPage(null, category, guildId, "Fixture", channelId, kind, [message]);
            const files = await readdir(history.directory);
            assert.equal(files.length, 2);
            assert.ok(history.directory.includes(category === "DMs" ? `${path.sep}DMs${path.sep}` : `${path.sep}Fixture_${guildId}${path.sep}`));
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("per-page JSON parts are written as each page arrives, listed oldest-first and removable again", async () => {
    const scratch = process.env.TMPDIR;
    assert.ok(scratch, "TMPDIR must point to the test scratch directory");
    const dir = await mkdtemp(path.join(scratch, "vesktop-parts-test-"));
    try {
        const native = await loadNative(dir);
        const run = "Fixture_100_2026-01-01T00-00-00-000Z";
        const channel = id(5);
        // The API answers newest -> oldest; both pages must be stored oldest-first.
        const first = await native.writeHistoryPageJson(null, undefined, run, channel, "chrono", [part(channel, 12), part(channel, 11), part(channel, 10)]);
        const second = await native.writeHistoryPageJson(null, undefined, run, channel, "chrono", [part(channel, 22), part(channel, 21), part(channel, 20)]);

        assert.equal(first.base, `${id(10)}_${id(12)}`);
        assert.match(first.path, /\.parts/);
        const lines = (await readFile(first.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        assert.deepEqual(lines.map(message => message.messageId), [id(10), id(11), id(12)]);

        // Spread the arrays: values built inside the plugin's realm are not reference-equal.
        assert.deepEqual([...await native.listHistoryPages(null, undefined, run, channel, "chrono")], [`${id(10)}_${id(12)}`, `${id(20)}_${id(22)}`]);
        assert.deepEqual([...(await native.readHistoryPage(null, undefined, run, channel, "chrono", second.base)).map(message => message.messageId)], [id(20), id(21), id(22)]);

        assert.equal((await native.discardHistoryPages(null, undefined, run, channel, "chrono", [first.base])).removed, 1);
        assert.deepEqual([...await native.listHistoryPages(null, undefined, run, channel, "chrono")], [second.base]);
        // A page that was never written, and a traversal attempt, are both refused.
        await assert.rejects(() => native.readHistoryPage(null, undefined, run, channel, "chrono", "../../secret"));
        assert.equal((await native.discardHistoryPages(null, undefined, run, channel, "chrono", ["../../secret"])).removed, 0);
        // When revocation removes the last page, the directory must not keep the private channel's
        // id/name either. Partial page removal above must still retain the other valid page.
        await native.discardHistoryPages(null, undefined, run, channel, "chrono", [second.base]);
        const channelFolders = await readdir(path.dirname(path.dirname(second.path)));
        assert.ok(!channelFolders.some(folder => folder.includes(channel)), "no revoked channel folder may survive");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the run stub is opened first, the aggregate files only after the re-check, then closed with a manifest", async () => {
    const scratch = process.env.TMPDIR;
    assert.ok(scratch, "TMPDIR must point to the test scratch directory");
    const dir = await mkdtemp(path.join(scratch, "vesktop-stream-test-"));
    try {
        const native = await loadNative(dir);
        const run = "Fixture_100_stream";
        const opened = await native.beginExport(null, undefined, run, "{\"tool\":\"fixture\"}\n");
        assert.match(opened.partsDir, /\.parts$/);
        // A revoked channel must be able to leave the run without a header: the aggregate files do not
        // exist until the surviving channel list is known.
        await assert.rejects(() => readFile(opened.txtPath, "utf8"));
        await assert.rejects(() => readFile(opened.htmlPath, "utf8"));
        const started = await native.startExportFiles(null, undefined, run, "HEADER\n", "<html>HEAD");
        assert.equal(started.txtPath, opened.txtPath);
        assert.equal(started.htmlPath, opened.htmlPath);
        await assert.rejects(() => readFile(opened.txtPath, "utf8"), "the final TXT is not a partial header");
        await assert.rejects(() => readFile(opened.htmlPath, "utf8"), "the final HTML is not partial navigation");
        await native.appendExport(null, undefined, run, { txt: "page one\n", html: "<article>1</article>" });
        await native.appendExport(null, undefined, run, { txt: "page two\n" });
        const done = await native.finishExport(null, undefined, run, "{\"outcome\":\"complete\"}", "FOOTER\n", "</html>");
        await assert.rejects(() => readFile(opened.txtPath, "utf8"));
        const published = await native.publishExport(null, undefined, run);

        assert.equal(await readFile(opened.txtPath, "utf8"), "HEADER\npage one\npage two\nFOOTER\n");
        assert.equal(await readFile(opened.htmlPath, "utf8"), "<html>HEAD<article>1</article></html>");
        const manifest = JSON.parse(await readFile(opened.manifestPath, "utf8"));
        assert.equal(manifest.tool, "fixture", "the started run metadata remains available");
        assert.equal(manifest.outcome, "complete", "the finished run is one valid JSON document");
        assert.ok(done.bytes.txt > 0 && published.bytes.manifest > 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("page readers refuse a channel id that is not a snowflake", async () => {
    const scratch = process.env.TMPDIR;
    const dir = await mkdtemp(path.join(scratch, "vesktop-chan-guard-"));
    try {
        const native = await loadNative(dir);
        const run = "Fixture_100_guard";
        const written = await native.writeHistoryPageJson(null, undefined, run, id(1), "chan", [part(id(1), 1)]);
        assert.ok(written, "a valid channel id is accepted");
        assert.deepEqual([...await native.listHistoryPages(null, undefined, run, "../../etc", "chan")], []);
        await assert.rejects(() => native.readHistoryPage(null, undefined, run, "../../etc", "chan", written.base));
        assert.equal((await native.discardHistoryPages(null, undefined, run, "../../etc", "chan", [written.base])).removed, 0);
        // The valid page is untouched by those refused calls.
        assert.deepEqual([...await native.listHistoryPages(null, undefined, run, id(1), "chan")], [written.base]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the unchanged guild menu completes a multi-page export through the real native writer", async () => {
    const dir = await mkdtemp(path.join(process.env.TMPDIR, "vesktop-menu-writer-"));
    try {
        const writer = await loadNative(dir);
        const native = Object.fromEntries(Object.entries(writer).map(([key, fn]) => [key, (...args) => fn(null, ...args)]));
        const guild = { id: id(100), name: "Fixture guild" };
        const channel = { id: id(1), guild_id: guild.id, name: "fixture", type: 0 };
        const base = 400000000000000000n;
        const app = loadPlugin({ guilds: [guild], channels: [channel], native, rest: ({ url, query }) => {
            if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
            const before = query?.before ? Number(BigInt(query.before) - base) : 251;
            const end = Math.min(250, before - 1);
            const start = Math.max(1, end - 99);
            return { body: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => ({
                id: String(base + BigInt(end - i)), content: `row ${end - i}`,
                timestamp: "2026-01-01T00:00:00.000Z", author: { id: id(999), username: "fixture" }
            })) };
        } });
        const menu = [];
        app.plugin.contextMenus["guild-context"](menu, { guild });
        const action = menu.find(item => item?.props?.id === "vc-export-guild-chat");
        assert.equal(action.props.label, "全チャンネルのログを保存（TXT + HTML）");
        await action.props.action();
        const directory = path.join(dir, "VesktopChatLogs");
        const files = await readdir(directory);
        const txt = await readFile(path.join(directory, files.find(file => file.endsWith(".txt"))), "utf8");
        assert.deepEqual([...txt.matchAll(/^row (\d+)$/gm)].map(match => Number(match[1])), Array.from({ length: 250 }, (_, i) => i + 1));
        const html = await readFile(path.join(directory, files.find(file => file.endsWith(".html"))), "utf8");
        assert.equal((html.match(/<article>/g) ?? []).length, 250);
        const manifest = JSON.parse(await readFile(path.join(directory, files.find(file => file.endsWith(".manifest.json"))), "utf8"));
        assert.equal(manifest.messages, 250);
        assert.equal(manifest.savedChannels, 1);
        assert.equal(manifest.outcome, "complete");
        assert.ok(app.toasts.some(toast => toast[1] === "success"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
