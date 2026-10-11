import test from "node:test";
import assert from "node:assert/strict";
import { exportHtml, exportJson, exportManifest, exportText, loadPlugin, id, message } from "./harness.mjs";

const BASE = 400000000000000000n;
const dm = { id: id(1), type: 3, name: "Original fixture" };
const mid = n => String(BASE + BigInt(n));
function restPage(total, requests = []) {
    return ({ url, query }) => {
        if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
        const before = query?.before ? Number(BigInt(query.before) - BASE) : total + 1;
        const end = Math.min(total, before - 1), start = Math.max(1, end - 99);
        requests.push(query?.before ?? null);
        return { body: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => ({ ...message(end - i), id: mid(end - i), content: `recovery ${end - i}` })) };
    };
}

test("a missing stored page cannot be silently omitted from a complete export", async () => {
    const app = loadPlugin({ channels: [dm], rest: restPage(150) });
    const list = app.native.listHistoryPages;
    app.native.listHistoryPages = async (...args) => [...await list(...args)].slice(1);
    await app.hooks.exportDm(dm);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
    assert.equal(exportText(app), "", "no incomplete aggregate is published as a final TXT");
    assert.equal(exportHtml(app), "");
    assert.equal(exportJson(app).trim().split("\n").filter(Boolean).length, 150, "preserve pages for retry");
    assert.equal(JSON.parse(exportManifest(app)).outcome, "failed");
    app.native.listHistoryPages = list;
    await app.hooks.exportDm(dm);
    assert.ok(app.toasts.some(t => t[1] === "success"), "restoring storage access allows the same run to finish");
});

test("DM rename between pages keeps its stable storage identity", async () => {
    const channel = { ...dm };
    const app = loadPlugin({ channels: [channel], rest: restPage(150) });
    const write = app.native.writeHistoryPageJson;
    let calls = 0;
    app.native.writeHistoryPageJson = async (...args) => {
        const result = await write(...args);
        if (++calls === 1) channel.name = "Renamed fixture";
        return result;
    };
    await app.hooks.exportDm(channel);
    assert.equal((exportText(app).match(/^recovery /gm) ?? []).length, 150);
    assert.ok(app.toasts.some(t => t[1] === "success"));
});

test("the same existing button resumes its saved cursor without re-fetching the latest page", async () => {
    const requests = [];
    const app = loadPlugin({ channels: [dm], rest: restPage(250, requests) });
    const write = app.native.writeHistoryPageJson;
    let stopOnce = true;
    app.native.writeHistoryPageJson = async (...args) => {
        const saved = await write(...args);
        if (stopOnce) { stopOnce = false; app.plugin.stop(); }
        return saved;
    };
    await app.hooks.exportDm(dm);
    const state = JSON.parse(exportManifest(app));
    assert.ok(Array.isArray(state.progress), "interrupted runs must persist per-channel progress");
    assert.equal(state.progress[0].before, mid(151));
    assert.equal(state.fetched, 100, "each saved page persists its cursor and count");
    assert.equal(exportText(app), "", "an interrupted assembly is not published");
    app.plugin.start();
    await app.hooks.exportDm(dm);
    assert.deepEqual(requests, [null, mid(151), mid(51)]);
    assert.equal((exportText(app).match(/^recovery /gm) ?? []).length, 250);
    assert.ok(app.toasts.some(t => t[1] === "success"));
});

test("a failed live write remains retryable but parallel confirmed copies are suppressed", async () => {
    const saved = [];
    let attempts = 0;
    const app = loadPlugin({ channels: [dm], native: { appendLiveMessage: async msg => {
        if (++attempts === 1) throw new Error("fixture I/O failure");
        saved.push(msg.messageId);
    } } });
    const event = { message: { ...message(10), channel_id: dm.id } };
    await app.hooks.saveLiveMessage(event);
    await Promise.all([app.hooks.saveLiveMessage(event), app.hooks.saveLiveMessage(event)]);
    assert.deepEqual(saved, [id(10)]);
    assert.equal(attempts, 2);
});

test("sorted private IDs and channel objects are merged with the mutable fallback", () => {
    const app = loadPlugin({ channels: [dm], privateChannels: [dm.id, id(999)] });
    assert.deepEqual([...app.hooks.getDmChannels()].map(c => c.id), [dm.id]);
});
