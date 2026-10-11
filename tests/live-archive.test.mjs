import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const baseline = process.env.LIVE_ARCHIVE_BASELINE === "1";
const source = fileURLToPath(new URL(baseline ? "../src/plugins/vesktopChatExporter/native.ts" : "../src/plugins/vesktopChatExporter/liveArchive.ts", import.meta.url));
const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"] }).outputFiles[0].text;
const id = n => String(400000000000000000n + BigInt(n));
const message = (n, overrides = {}) => ({
    guildId: id(3), guildName: "Fixture", channelId: id(5), channelName: "chrono",
    messageId: id(n), timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    author: "fixture", authorId: id(99), content: `row ${n}`, attachments: [], ...overrides
});

function loadArchive(root, overrides = {}, globals = {}) {
    const context = {
        ...globals,
        module: { exports: {} },
        require: name => {
            if (name === "electron") return { app: { getPath: () => root } };
            if (name === "fs/promises" || name === "node:fs/promises") return { ...fs, ...overrides };
            return require(name);
        }
    };
    vm.runInNewContext(code, context);
    return baseline ? { writeLiveArchive: (_, record) => context.module.exports.appendLiveMessage(null, record) } : context.module.exports;
}

async function fixture(run) {
    assert.ok(process.env.TMPDIR, "TMPDIR must be the explicit synthetic scratch directory");
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR, "vesktop-live-archive-"));
    try { await run(root); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function rows(result) {
    const txt = await fs.readFile(result.txtPath, "utf8");
    const html = await fs.readFile(result.htmlPath, "utf8");
    return {
        txt: [...txt.matchAll(/^row (\d+)$/gm)].map(match => Number(match[1])),
        html: [...html.matchAll(/<code>(\d+)<\/code>/g)].map(match => match[1])
    };
}

test("reverse live arrival is published oldest-first in both formats", () => fixture(async root => {
    const archive = loadArchive(root);
    await archive.writeLiveArchive(root, message(22));
    const result = await archive.writeLiveArchive(root, message(21));
    const stored = await rows(result);
    assert.deepEqual(stored.txt, [21, 22]);
    assert.deepEqual(stored.html, [id(21), id(22)]);
}));

test("reloading with the same live payload never publishes a second copy", () => fixture(async root => {
    await loadArchive(root).writeLiveArchive(root, message(21));
    const result = await loadArchive(root).writeLiveArchive(root, message(21));
    assert.deepEqual((await rows(result)).html, [id(21)]);
    assert.deepEqual((await rows(result)).txt, [21]);
}));

test("reload deduplicates the canonical ID without replacing its first payload or stable path", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21));
    const again = await loadArchive(root).writeLiveArchive(root, message(21, {
        guildName: "renamed server", channelName: "renamed channel", content: "replacement must not win"
    }));
    assert.equal(again.txtPath, first.txtPath);
    assert.equal(again.htmlPath, first.htmlPath);
    assert.deepEqual((await rows(again)).txt, [21]);
    assert.deepEqual((await rows(again)).html, [id(21)]);
    assert.equal(again.count, 1);
    const records = path.join(again.directory, "2026-01-01.records");
    assert.deepEqual(await fs.readdir(records), [`${id(21)}.json`]);
    assert.equal(JSON.parse(await fs.readFile(path.join(records, `${id(21)}.json`), "utf8")).content, "row 21");
}));

test("a crash-left hard-linked record stage cannot overwrite the canonical first payload", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21));
    const recordPath = path.join(first.directory, "2026-01-01.records", `${id(21)}.json`);
    await fs.link(recordPath, `${recordPath}.stage`);
    const result = await loadArchive(root).writeLiveArchive(root, message(21, { content: "retry payload must not win" }));
    assert.equal(JSON.parse(await fs.readFile(recordPath, "utf8")).content, "row 21");
    assert.deepEqual((await rows(result)).txt, [21]);
}));

test("partial canonical writes stay nonfinal and the same ID is retryable", () => fixture(async root => {
    let fail = true;
    const archive = loadArchive(root, {
        writeFile: async (file, data, ...args) => {
            if (fail && String(file).endsWith(`${id(21)}.json.stage`)) {
                fail = false;
                await fs.writeFile(file, '{"partial":', ...args);
                throw new Error("synthetic interrupted canonical write");
            }
            return fs.writeFile(file, data, ...args);
        }
    });
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic interrupted canonical write/);
    const directory = path.join(root, "VesktopChatLogs", "Live", id(3), id(5));
    assert.deepEqual(await fs.readdir(path.join(directory, "2026-01-01.records")), []);
    await assert.rejects(() => fs.stat(path.join(directory, "2026-01-01.txt")));
    const result = await archive.writeLiveArchive(root, message(21));
    assert.equal(result.count, 1);
    assert.deepEqual((await rows(result)).txt, [21]);
}));

test("a rejected append never counts canonical existence as TXT/HTML success and reload repairs it", () => fixture(async root => {
    let fail = false;
    const archive = loadArchive(root, {
        appendFile: async (file, data, ...args) => {
            if (fail && String(file).endsWith(".html")) {
                fail = false;
                await fs.appendFile(file, '<article>partial', ...args);
                throw new Error("synthetic partial HTML append");
            }
            return fs.appendFile(file, data, ...args);
        }
    });
    const first = await archive.writeLiveArchive(root, message(21));
    fail = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(22)), /synthetic partial HTML append/);
    const recordPath = path.join(first.directory, "2026-01-01.records", `${id(22)}.json`);
    assert.equal(JSON.parse(await fs.readFile(recordPath, "utf8")).messageId, id(22));
    const result = await loadArchive(root).writeLiveArchive(root, message(22));
    assert.equal(result.count, 2);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
    assert.ok(!(await fs.readFile(result.htmlPath, "utf8")).includes('partial'));
}));

test("reload recovers an interrupted pair publication and ignores leftover stages", () => fixture(async root => {
    let fail = false;
    const archive = loadArchive(root, {
        rename: async (from, to) => {
            if (fail && String(to).endsWith(".html")) {
                fail = false;
                throw new Error("synthetic second publication failure");
            }
            return fs.rename(from, to);
        }
    });
    const first = await archive.writeLiveArchive(root, message(22));
    fail = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic second publication failure/);
    await fs.writeFile(`${first.txtPath}.stage`, "crash leftovers", "utf8");
    await fs.writeFile(path.join(first.directory, "2026-01-01.records", `${id(23)}.json.stage`), '{"partial":', "utf8");
    const result = await loadArchive(root).writeLiveArchive(root, message(21));
    assert.equal(result.count, 2);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
}));

test("legacy daily files are never read, reordered or written", () => fixture(async root => {
    const legacy = path.join(root, "VesktopChatLogs", `Fixture_${id(3)}`);
    await fs.mkdir(legacy, { recursive: true });
    const files = [path.join(legacy, `2026-01-01_chrono_${id(5)}.txt`), path.join(legacy, `2026-01-01_chrono_${id(5)}.html`)];
    for (const file of files) await fs.writeFile(file, "row 22\nrow 21\n", "utf8");
    const archive = loadArchive(root, {
        readFile: async (file, ...args) => {
            assert.ok(!String(file).startsWith(legacy), "legacy content is out of scope");
            return fs.readFile(file, ...args);
        }
    });
    const result = await archive.writeLiveArchive(root, message(23));
    assert.ok(result.directory.includes(`${path.sep}Live${path.sep}`));
    for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "row 22\nrow 21\n");
}));

test("numeric snowflake order works across different ID lengths and timestamp formats", () => fixture(async root => {
    const archive = loadArchive(root);
    const high = message(22, { messageId: "100000000000000000", timestamp: "2026-01-01T00:00:00.212Z" });
    const low = message(21, { messageId: "99999999999999999", timestamp: "2026-01-01T00:00:00.180000+00:00" });
    await archive.writeLiveArchive(root, high);
    const result = await archive.writeLiveArchive(root, low);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [low.messageId, high.messageId]);
}));

test("invalid IDs and timestamps are refused before filesystem access", () => fixture(async root => {
    const archive = loadArchive(root, { mkdir: async () => { assert.fail("invalid input must not touch disk"); } });
    for (const changed of [
        { guildId: "../secret" }, { channelId: id(1) + "/.." }, { messageId: "123" },
        { messageId: " " + id(21) }, { messageId: "0".repeat(21) }, { timestamp: "not-a-date" },
        { attachments: [{ filename: "test", url: null }] }
    ]) await assert.rejects(() => archive.writeLiveArchive(root, message(21, changed)));
}));

test("day and channel keys isolate independent archives", () => fixture(async root => {
    const archive = loadArchive(root);
    const today = await archive.writeLiveArchive(root, message(21));
    const otherChannel = await archive.writeLiveArchive(root, message(21, { channelId: id(6), category: "DMs" }));
    const tomorrow = await archive.writeLiveArchive(root, message(21, { timestamp: "2026-01-02T00:00:00.000Z" }));
    assert.notEqual(today.directory, otherChannel.directory);
    assert.ok(otherChannel.directory.includes(`${path.sep}DMs${path.sep}`), "DM isolation survives the new live namespace");
    assert.notEqual(today.txtPath, tomorrow.txtPath);
    for (const result of [today, otherChannel, tomorrow]) {
        assert.equal(result.count, 1);
        assert.deepEqual((await rows(result)).txt, [21]);
    }
}));

test("rebuild reads and writes one canonical message at a time", () => fixture(async root => {
    const initial = loadArchive(root);
    await initial.writeLiveArchive(root, message(23));
    await initial.writeLiveArchive(root, message(22));
    const trace = [];
    const archive = loadArchive(root, {
        readFile: async (file, ...args) => {
            if (/\d{17,20}\.json$/.test(String(file))) trace.push(`read:${path.basename(String(file))}`);
            return fs.readFile(file, ...args);
        },
        appendFile: async (file, data, ...args) => {
            if (String(file).endsWith(".stage") && String(data).includes("row ")) trace.push(`write:${path.extname(String(file).slice(0, -6))}`);
            return fs.appendFile(file, data, ...args);
        }
    });
    const result = await archive.writeLiveArchive(root, message(21));
    assert.deepEqual(trace, [21, 22, 23].flatMap(n => [`read:${id(n)}.json`, "write:.txt", "write:.html"]));
    assert.equal(result.count, 3);
}));

test("HTML escapes every displayed field and never activates non-web attachment URLs", () => fixture(async root => {
    const archive = loadArchive(root);
    const result = await archive.writeLiveArchive(root, message(21, {
        guildName: '<img src=x onerror="bad()">', channelName: '<script>bad()</script>',
        author: '<b onmouseover="bad()">', content: '<script>bad()</script>\n& text',
        attachments: [
            { filename: '<img src=x>', url: 'https://example.invalid/file?x="bad"&y=1' },
            { filename: 'unsafe.txt', url: 'javascript:bad()' }
        ]
    }));
    const html = await fs.readFile(result.htmlPath, "utf8");
    assert.ok(!html.includes('<script>') && !html.includes('<img'));
    assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;<br>&amp; text/);
    assert.match(html, /href="https:\/\/example.invalid\/file\?x=&quot;bad&quot;&amp;y=1"/);
    assert.ok(!html.includes('href="javascript:'), "escaped text is not a safe URL scheme");
    assert.match(await fs.readFile(result.txtPath, "utf8"), /\[添付\] unsafe\.txt: javascript:bad\(\)/);
}));

test("an empty canonical listing fails closed instead of publishing a zero-message day", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21));
    const txtBefore = await fs.readFile(first.txtPath, "utf8");
    const htmlBefore = await fs.readFile(first.htmlPath, "utf8");
    const archive = loadArchive(root, { readdir: async () => [] });
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)));
    assert.equal(await fs.readFile(first.txtPath, "utf8"), txtBefore);
    assert.equal(await fs.readFile(first.htmlPath, "utf8"), htmlBefore);
}));

test("canonical contents must match the stable filename, channel and day before publishing", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(22));
    const txtBefore = await fs.readFile(first.txtPath, "utf8");
    const htmlBefore = await fs.readFile(first.htmlPath, "utf8");
    const recordPath = path.join(first.directory, "2026-01-01.records", `${id(22)}.json`);
    for (const changed of [
        { messageId: id(23) }, { channelId: id(6) }, { guildId: id(4) },
        { timestamp: "2026-01-02T00:00:22.000Z" }, { attachments: undefined }
    ]) {
        await fs.writeFile(recordPath, JSON.stringify(message(22, changed)), "utf8");
        await assert.rejects(() => loadArchive(root).writeLiveArchive(root, message(21)));
        assert.equal(await fs.readFile(first.txtPath, "utf8"), txtBefore);
        assert.equal(await fs.readFile(first.htmlPath, "utf8"), htmlBefore);
    }
    await fs.writeFile(recordPath, JSON.stringify(message(22)), "utf8");
    const result = await loadArchive(root).writeLiveArchive(root, message(21));
    assert.equal(result.count, 2);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
}));

test("normal ascending arrivals append without reading earlier canonical messages", () => fixture(async root => {
    const recordReads = [];
    const archive = loadArchive(root, {
        readFile: async (file, ...args) => {
            if (/\d{17,20}\.json$/.test(String(file))) recordReads.push(path.basename(String(file)));
            return fs.readFile(file, ...args);
        }
    });
    await archive.writeLiveArchive(root, message(21));
    recordReads.length = 0;
    const result = await archive.writeLiveArchive(root, message(22));
    assert.ok(!recordReads.includes(`${id(21)}.json`), "ascending fast path cannot reread the whole day");
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.equal(result.count, 2);
    assert.match(await fs.readFile(result.htmlPath, "utf8"), /<\/body><\/html>\n$/);
}));

test("published metadata has a 5000-key LRU cap and an evicted day rebuilds safely", () => fixture(async root => {
    const maps = [];
    class TrackingMap extends Map {
        constructor(...args) { super(...args); maps.push(this); }
    }
    const archive = loadArchive(root, {}, { Map: TrackingMap });
    const first = await archive.writeLiveArchive(root, message(21));
    const cache = maps.find(map => map.get(first.txtPath)?.count === 1);
    assert.ok(cache, "metadata cache records successful publication");
    for (let n = 0; n < 5000; n++) cache.set(`synthetic-key-${n}`, { count: 1 });
    // A successful publication is the trim boundary; no synthetic disk contents
    // are involved in exercising a large cache.
    const other = await archive.writeLiveArchive(root, message(21, { channelId: id(6) }));
    assert.ok(cache.size <= 5000, "cache cannot retain metadata for every historical day forever");
    assert.ok(!cache.has(first.txtPath), "oldest day is evicted");
    assert.ok(cache.has(other.txtPath), "most recently published day remains cached");
    const result = await archive.writeLiveArchive(root, message(22));
    assert.equal(result.count, 2);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
}));

test("same-day concurrent writes serialize the full operation including failure cleanup", () => fixture(async root => {
    let active = 0, maxActive = 0, fail = true;
    const archive = loadArchive(root, {
        appendFile: async (file, data, ...args) => {
            active++;
            maxActive = Math.max(maxActive, active);
            try {
                await new Promise(resolve => setTimeout(resolve, 5));
                if (fail && String(file).includes(".html")) {
                    fail = false;
                    throw new Error("synthetic first operation failure");
                }
                return await fs.appendFile(file, data, ...args);
            } finally { active--; }
        }
    });
    const writes = [22, 21, 23, 21].map(n => archive.writeLiveArchive(root, message(n)));
    const outcomes = await Promise.allSettled(writes);
    assert.equal(outcomes[0].status, "rejected");
    assert.ok(outcomes.slice(1).every(outcome => outcome.status === "fulfilled"));
    assert.equal(maxActive, 1, "the queue must not release before rejection and cleanup have settled");
    const result = outcomes[3].value;
    assert.deepEqual((await rows(result)).txt, [21, 22, 23]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22), id(23)]);
    assert.equal(result.count, 3);
}));

test("a failed streamed rebuild leaves both published files intact and retries the same canonical ID", () => fixture(async root => {
    let fail = false;
    const archive = loadArchive(root, {
        appendFile: async (file, data, ...args) => {
            if (fail && String(file).includes(".html")) {
                fail = false;
                throw new Error("synthetic staged HTML failure");
            }
            return fs.appendFile(file, data, ...args);
        }
    });
    const first = await archive.writeLiveArchive(root, message(22));
    const txtBefore = await fs.readFile(first.txtPath, "utf8");
    const htmlBefore = await fs.readFile(first.htmlPath, "utf8");
    fail = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic staged HTML failure/);
    assert.equal(await fs.readFile(first.txtPath, "utf8"), txtBefore);
    assert.equal(await fs.readFile(first.htmlPath, "utf8"), htmlBefore);
    const result = await archive.writeLiveArchive(root, message(21));
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
    assert.equal(result.count, 2);
    assert.ok(!(await fs.readdir(result.directory)).some(name => name.endsWith(".stage")));
}));
