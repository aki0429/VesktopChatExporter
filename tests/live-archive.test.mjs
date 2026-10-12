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
        Buffer,
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

test("new live archives persist only TXT and HTML, never JSON or another canonical body", () => fixture(async root => {
    const archive = loadArchive(root);
    await archive.writeLiveArchive(root, message(22));
    const result = await archive.writeLiveArchive(root, message(21));
    assert.deepEqual((await fs.readdir(result.directory)).sort(), [`2026-01-01_chrono_${id(5)}.html`, `2026-01-01_chrono_${id(5)}.txt`]);
    assert.equal(result.directory, path.join(root, "VesktopChatLogs", `Fixture_${id(3)}`));
}));

test("live paths retain original category, sanitized names, 180-character limit and UTC day", () => fixture(async root => {
    const archive = loadArchive(root);
    for (const [category, guildName, channelName, safeCategory, safeGuild, safeChannel] of [
        ['DMs:.. ', 'Guild/Name.. ', 'chat?room. ', 'DMs_', 'Guild_Name', 'chat_room'],
        ['... ', '... ', '... ', 'chat-export', 'chat-export', 'chat-export'],
        [undefined, 'G'.repeat(181), 'C'.repeat(181), undefined, 'G'.repeat(180), 'C'.repeat(180)]
    ]) {
        const result = await archive.writeLiveArchive(root, message(21, {
            category, guildName, channelName, timestamp: '2026-01-02T00:30:00+09:00'
        }));
        const directory = path.join(root, 'VesktopChatLogs', ...(safeCategory ? [safeCategory] : []), `${safeGuild}_${id(3)}`);
        assert.equal(result.directory, directory);
        assert.equal(result.txtPath, path.join(directory, `2026-01-01_${safeChannel}_${id(5)}.txt`));
        assert.equal(result.htmlPath, path.join(directory, `2026-01-01_${safeChannel}_${id(5)}.html`));
    }
}));

test("TXT body header lookalikes never become archive IDs", () => fixture(async root => {
    for (const fake of [id(50), id(21), id(22)]) {
        const content = `row 21\n\n[2026-01-01T00:00:00.000Z] fixture (${id(99)}) [${fake}]\nnot a message`;
        const first = await loadArchive(root).writeLiveArchive(root, message(21, { content }));
        const before = await fs.readFile(first.txtPath);
        const result = await loadArchive(root).writeLiveArchive(root, message(22));
        assert.equal(result.count, 2);
        assert.deepEqual((await fs.readFile(result.txtPath)).subarray(0, before.length), before);
        assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
        await fs.rm(first.directory, { recursive: true });
    }
}));

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

test("reload preserves first payload at the original name-based path", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21));
    const again = await loadArchive(root).writeLiveArchive(root, message(21, {
        content: "replacement must not win"
    }));
    assert.equal(again.txtPath, first.txtPath);
    assert.equal(again.count, 1);
    assert.deepEqual((await rows(again)).txt, [21]);
    assert.ok(!(await fs.readFile(again.htmlPath, "utf8")).includes("replacement must not win"));
}));

test("a crash-left hard-linked TXT stage cannot overwrite first payload", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21));
    await fs.link(first.txtPath, `${first.txtPath}.stage`);
    const result = await loadArchive(root).writeLiveArchive(root, message(21, { content: "replacement" }));
    assert.deepEqual((await rows(result)).txt, [21]);
}));

test("partial TXT stage writes stay nonfinal and the same ID is retryable", () => fixture(async root => {
    let fail = true;
    const archive = loadArchive(root, {
        writeFile: async (file, data, ...args) => {
            if (fail && String(file).endsWith(".txt.stage")) {
                fail = false;
                await fs.writeFile(file, "partial", ...args);
                throw new Error("synthetic interrupted TXT write");
            }
            return fs.writeFile(file, data, ...args);
        }
    });
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic interrupted TXT write/);
    const directory = path.join(root, "VesktopChatLogs", `Fixture_${id(3)}`);
    assert.deepEqual(await fs.readdir(directory), []);
    const result = await archive.writeLiveArchive(root, message(21));
    assert.deepEqual((await rows(result)).txt, [21]);
}));

test("reload recovers interrupted pair publication using TXT/HTML and same ID retry", () => fixture(async root => {
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
    const result = await loadArchive(root).writeLiveArchive(root, message(21));
    assert.equal(result.count, 2);
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
}));

test("different ID proceeds after second pair rename fails", () => fixture(async root => {
    let fail = false;
    const archive = loadArchive(root, {
        rename: async (from, to) => {
            if (fail && String(from).endsWith(".html.stage")) {
                fail = false;
                throw new Error("synthetic HTML rename EIO");
            }
            return fs.rename(from, to);
        }
    });
    const first = await archive.writeLiveArchive(root, message(22));
    const txtBefore = await fs.readFile(first.txtPath);
    const htmlBefore = await fs.readFile(first.htmlPath);
    fail = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic HTML rename EIO/);
    const result = await archive.writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [22, 23]);
    assert.deepEqual((await rows(result)).html, [id(22), id(23)]);
    assert.deepEqual((await fs.readFile(result.txtPath)).subarray(0, txtBefore.length), txtBefore);
    assert.ok((await fs.readFile(result.htmlPath)).includes(htmlBefore.subarray(0, htmlBefore.length - 14)));
    assert.deepEqual((await fs.readdir(result.directory)).sort(), [`2026-01-01_chrono_${id(5)}.html`, `2026-01-01_chrono_${id(5)}.txt`]);
}));

test("multiline author is refused before touching files and cannot poison later saves", () => fixture(async root => {
    for (const author of ['first\nsecond', 'first\r\nsecond']) {
        const archive = loadArchive(root, { mkdir: async () => assert.fail('invalid author must not touch files') });
        await assert.rejects(() => archive.writeLiveArchive(root, message(22, { author })), /Invalid live author/);
    }
    const result = await loadArchive(root).writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [23]);
}));

test("partial rollback marker preparation never strands the old pair", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(22));
    const before = await fs.readFile(first.txtPath);
    let fail = true;
    const archive = loadArchive(root, {
        writeFile: async (file, data, ...args) => {
            if (fail && String(file).includes(".rollback")) {
                fail = false;
                await fs.writeFile(file, "pa", ...args);
                throw new Error("synthetic interrupted marker write");
            }
            return fs.writeFile(file, data, ...args);
        }
    });
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic interrupted marker write/);
    const result = await loadArchive(root).writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [22, 23]);
    assert.deepEqual((await fs.readFile(result.txtPath)).subarray(0, before.length), before);
}));

test("ascending arrivals do not rebuild earlier TXT or HTML bodies", () => fixture(async root => {
    const archive = loadArchive(root, {
        appendFile: async (file, data, ...args) => {
            assert.ok(!Buffer.isBuffer(data), "ascending write cannot copy earlier segments");
            return fs.appendFile(file, data, ...args);
        }
    });
    await archive.writeLiveArchive(root, message(21));
    const result = await archive.writeLiveArchive(root, message(22));
    assert.deepEqual((await rows(result)).txt, [21, 22]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
    assert.match(await fs.readFile(result.htmlPath, "utf8"), /<\/body><\/html>\n$/);
}));

test("restart rolls back crash snapshots before accepting a different ID", () => fixture(async root => {
    for (const phase of ["first rename", "both renames", "interrupted rollback", "first publication"]) {
        const first = await loadArchive(root).writeLiveArchive(root, message(22));
        const txtBefore = await fs.readFile(first.txtPath);
        const htmlBefore = await fs.readFile(first.htmlPath);
        await fs.copyFile(first.txtPath, `${first.txtPath}.backup.stage`);
        await fs.copyFile(first.htmlPath, `${first.htmlPath}.backup.stage`);
        await fs.writeFile(`${first.txtPath}.rollback.stage`, phase === "first publication" ? "empty\n" : "pair\n");
        await fs.writeFile(first.txtPath, "uncommitted TXT");
        if (phase !== "first rename") await fs.writeFile(first.htmlPath, "partial HTML restore");
        const result = await loadArchive(root).writeLiveArchive(root, message(23));
        assert.deepEqual((await rows(result)).txt, phase === "first publication" ? [23] : [22, 23]);
        assert.deepEqual((await rows(result)).html, phase === "first publication" ? [id(23)] : [id(22), id(23)]);
        if (phase !== "first publication") {
            assert.deepEqual((await fs.readFile(result.txtPath)).subarray(0, txtBefore.length), txtBefore);
            assert.ok((await fs.readFile(result.htmlPath)).includes(htmlBefore.subarray(0, htmlBefore.length - 14)));
        }
        assert.deepEqual((await fs.readdir(result.directory)).sort(), [`2026-01-01_chrono_${id(5)}.html`, `2026-01-01_chrono_${id(5)}.txt`]);
        await fs.rm(result.directory, { recursive: true });
    }
}));

test("failed rollback preserves backups for the next different ID", () => fixture(async root => {
    let failRename = false, failRestore = false;
    const archive = loadArchive(root, {
        rename: async (from, to) => {
            if (failRename && String(from).endsWith(".html.stage")) {
                failRename = false;
                failRestore = true;
                throw new Error("synthetic publication EIO");
            }
            return fs.rename(from, to);
        },
        copyFile: async (from, to, ...args) => {
            if (failRestore && String(from).endsWith(".html.backup.stage")) {
                failRestore = false;
                await fs.writeFile(to, "partial restore");
                throw new Error("synthetic restore EIO");
            }
            return fs.copyFile(from, to, ...args);
        }
    });
    const first = await archive.writeLiveArchive(root, message(22));
    failRename = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(21)), /synthetic restore EIO/);
    assert.ok((await fs.readdir(first.directory)).includes(`2026-01-01_chrono_${id(5)}.txt.rollback.stage`));
    const result = await loadArchive(root).writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [22, 23]);
    assert.deepEqual((await rows(result)).html, [id(22), id(23)]);
}));

test("ascending HTML append failure rolls back before accepting another ID", () => fixture(async root => {
    let fail = false;
    const archive = loadArchive(root, {
        appendFile: async (file, data, ...args) => {
            if (fail && String(file).endsWith(".html")) {
                fail = false;
                await fs.appendFile(file, "partial", ...args);
                throw new Error("synthetic append EIO");
            }
            return fs.appendFile(file, data, ...args);
        }
    });
    const first = await archive.writeLiveArchive(root, message(21));
    const txtBefore = await fs.readFile(first.txtPath);
    const htmlBefore = await fs.readFile(first.htmlPath);
    fail = true;
    await assert.rejects(() => archive.writeLiveArchive(root, message(22)), /synthetic append EIO/);
    assert.deepEqual(await fs.readFile(first.txtPath), txtBefore);
    assert.deepEqual(await fs.readFile(first.htmlPath), htmlBefore);
    const result = await archive.writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [21, 23]);
    assert.deepEqual((await rows(result)).html, [id(21), id(23)]);
}));

test("the unsolicited Live ID namespace is never read, renamed or migrated", () => fixture(async root => {
    const legacy = path.join(root, "VesktopChatLogs", "Live", id(3), id(5));
    await fs.mkdir(legacy, { recursive: true });
    const files = [path.join(legacy, "2026-01-01.txt"), path.join(legacy, "2026-01-01.html")];
    for (const file of files) await fs.writeFile(file, "row 22\nrow 21\n", "utf8");
    const archive = loadArchive(root, {
        readFile: async (file, ...args) => {
            assert.ok(!String(file).startsWith(legacy), "legacy content is out of scope");
            return fs.readFile(file, ...args);
        }
    });
    const result = await archive.writeLiveArchive(root, message(23));
    assert.equal(result.directory, path.join(root, "VesktopChatLogs", `Fixture_${id(3)}`));
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
    assert.equal(otherChannel.directory, path.join(root, "VesktopChatLogs", "DMs", `Fixture_${id(3)}`));
    assert.equal(otherChannel.txtPath, path.join(otherChannel.directory, `2026-01-01_chrono_${id(6)}.txt`));
    assert.notEqual(today.txtPath, tomorrow.txtPath);
    for (const result of [today, otherChannel, tomorrow]) {
        assert.equal(result.count, 1);
        assert.deepEqual((await rows(result)).txt, [21]);
    }
}));

test("rebuild copies bounded chunks without loading whole TXT/HTML bodies", () => fixture(async root => {
    await loadArchive(root).writeLiveArchive(root, message(22, { content: "row 22\n" + "あ".repeat(100000) }));
    let largest = 0;
    const archive = loadArchive(root, {
        readFile: async () => assert.fail("whole-file reads forbidden"),
        appendFile: async (file, data, ...args) => {
            if (Buffer.isBuffer(data)) largest = Math.max(largest, data.length);
            return fs.appendFile(file, data, ...args);
        }
    });
    const result = await archive.writeLiveArchive(root, message(21));
    assert.equal(result.count, 2);
    assert.ok(largest > 0 && largest <= 65536);
    assert.deepEqual((await rows(result)).html, [id(21), id(22)]);
}));

test("CRLF middle insertion preserves every TXT byte", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(21, { content: "row 21\r\n日本語\r\nlast" }));
    const prefix = await fs.readFile(first.txtPath);
    await loadArchive(root).writeLiveArchive(root, message(23));
    const suffix = (await fs.readFile(first.txtPath)).subarray(prefix.length);
    const result = await loadArchive(root).writeLiveArchive(root, message(22));
    const middle = Buffer.from(`[${message(22).timestamp}] fixture (${id(99)}) [${id(22)}]\nrow 22\n\n`);
    assert.deepEqual(await fs.readFile(result.txtPath), Buffer.concat([prefix, middle, suffix]));
    assert.deepEqual((await rows(result)).html, [id(21), id(22), id(23)]);
}));

test("restart rebuild preserves CRLF content byte-for-byte", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(22, { content: "row 22\r\n日本語\r\nlast" }));
    await loadArchive(root).writeLiveArchive(root, message(23));
    const before = await fs.readFile(first.txtPath, "utf8");
    const result = await loadArchive(root).writeLiveArchive(root, message(21));
    assert.ok((await fs.readFile(result.txtPath, "utf8")).endsWith(before));
    assert.match(await fs.readFile(result.txtPath, "utf8"), /last\n\n\[2026-01-01T00:00:23/);
    assert.deepEqual((await rows(result)).txt, [21, 22, 23]);
    assert.deepEqual((await rows(result)).html, [id(21), id(22), id(23)]);
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

test("old JSON and JSONL are never read, removed or migrated", () => fixture(async root => {
    const first = await loadArchive(root).writeLiveArchive(root, message(22));
    const legacy = path.join(first.directory, "2026-01-01.records");
    await fs.mkdir(legacy);
    const files = [path.join(legacy, `${id(21)}.json`), path.join(first.directory, "legacy.jsonl")];
    for (const file of files) await fs.writeFile(file, "synthetic legacy body");
    const archive = loadArchive(root, {
        readFile: async () => assert.fail("legacy reads forbidden"),
        rm: async (file, ...args) => {
            assert.ok(!files.includes(String(file)) && String(file) !== legacy);
            return fs.rm(file, ...args);
        }
    });
    const result = await archive.writeLiveArchive(root, message(23));
    assert.deepEqual((await rows(result)).txt, [22, 23]);
    for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "synthetic legacy body");
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
    assert.deepEqual((await rows(result)).txt, [21, 23]);
    assert.deepEqual((await rows(result)).html, [id(21), id(23)]);
    assert.equal(result.count, 2);
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
