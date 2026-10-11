import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { id } from "./harness.mjs";

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL("../src/plugins/vesktopChatExporter/native.ts", import.meta.url));

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
