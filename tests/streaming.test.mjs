import test from "node:test";
import assert from "node:assert/strict";
import { exportJson, exportStarted, exportText, loadPlugin, id } from "./harness.mjs";

// A very long history must not be expanded in memory: the run writes one file per page as the page
// arrives and only then assembles the aggregate from what is on disk, oldest message first.

const guild = { id: id(100), name: "Fixture guild" };
const text = { id: id(1), type: 0, name: "text", guild_id: guild.id };

const BASE = 400000000000000000n;
const mid = n => String(BASE + BigInt(n));
const row = n => ({
    id: mid(n),
    // The API hands every page over newest -> oldest; ordering must not depend on that.
    timestamp: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(),
    content: `row ${n}`,
    author: { id: mid(999), username: "fixture" }
});

// 100 messages per page, ending with a short page, exactly like Discord's messages endpoint.
function pagedRest(total, pages = []) {
    return ({ url, query }) => {
        if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
        const before = query?.before ? Number(BigInt(query.before) - BASE) : total + 1;
        const end = Math.min(total, before - 1);
        const start = Math.max(1, end - 99);
        const count = Math.max(0, end - start + 1);
        pages.push([start, end]);
        return { body: Array.from({ length: count }, (_, i) => row(start + i)).reverse() };
    };
}

test("a long channel is written to storage page by page instead of one buffered value", async () => {
    const pages = [];
    const app = loadPlugin({ channels: [text], guilds: [guild], rest: pagedRest(250, pages) });
    await app.hooks.exportGuild(guild);

    assert.deepEqual(pages, [[151, 250], [51, 150], [1, 50]]);
    const writes = app.saved.filter(entry => entry.kind === "history");
    assert.equal(writes.length, 3, "each non-empty page is stored on its own");
    for (const write of writes)
        assert.ok(write.args[4].length <= 100, "no write may hold more than one page");
    assert.equal(exportJson(app).trim().split("\n").filter(Boolean).length, 250, "every message is on disk");
    assert.ok(exportStarted(app));
});

test("the aggregate is assembled oldest-first even though every page arrives newest-first", async () => {
    const app = loadPlugin({ channels: [text], guilds: [guild], rest: pagedRest(250) });
    await app.hooks.exportGuild(guild);

    const text_ = exportText(app);
    const first = [...app.saved.filter(entry => entry.kind === "history")[0].args[4].map(message => message.content)];
    assert.deepEqual(first, Array.from({ length: 100 }, (_, i) => `row ${i + 151}`), "the stored page keeps the ids it was given");
    assert.ok(text_.indexOf("row 1\n") < text_.indexOf("row 101\n"), "the aggregate starts at the oldest page");
    assert.ok(text_.indexOf("row 101\n") < text_.indexOf("row 201\n"));
    // Each stored page is written oldest-first inside the file as well.
    assert.ok(text_.indexOf("row 151\n") < text_.indexOf("row 250\n"));
});

test("a page that never advances the cursor stops the channel instead of spinning", async () => {
    let calls = 0;
    const app = loadPlugin({ channels: [text], guilds: [guild], rest: ({ url }) => {
        if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
        calls++;
        // A broken endpoint that answers the same full page forever.
        return { body: Array.from({ length: 100 }, (_, i) => row(250 - i)) };
    } });
    await app.hooks.exportGuild(guild);

    assert.equal(calls, 2, "the second identical page must end the walk");
    assert.equal(app.saved.filter(entry => entry.kind === "history").length, 1, "only the first page is stored");
    assert.ok(app.toasts.some(toast => /不完全|一部/.test(toast[0])));
    assert.ok(!app.toasts.some(toast => toast[1] === "success"));
});
