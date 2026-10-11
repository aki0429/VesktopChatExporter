import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message } from "./harness.mjs";
const dm = { id: id(1), type: 1 };

test("the real plugin catches new history after a completed state and a process restart", async () => {
    let state = { [`${dm.id}:${dm.id}`]: { completed: true, before: id(20), extension: "keep" } };
    const app = loadPlugin({ channels: [dm], rest: () => ({ body: [message(21), message(20)] }), native: {
        loadCrawlState: async () => structuredClone(state),
        saveCrawlState: async next => { state = JSON.parse(JSON.stringify(next)); }
    } });
    await app.hooks.crawlAllHistory();
    assert.equal(app.requests.length, 1);
    assert.equal(app.saved.find(s => s.kind === "history").args[5][0].messageId, id(21));
    assert.equal(state[`${dm.id}:${dm.id}`].newest, id(21));
    assert.equal(state[`${dm.id}:${dm.id}`].extension, "keep");
});

test("background requests yield to a real manual menu export and do not write their in-flight page", async () => {
    let startedManual = false;
    let manual;
    let background;
    const app = loadPlugin({ channels: [dm], rest: () => {
        if (!startedManual) {
            startedManual = true;
            manual = app.hooks.exportDm(dm);
        }
        return { body: [message(21)] };
    } });
    background = app.hooks.crawlAllHistory();
    await background;
    await manual;
    const backgroundWrites = app.saved.filter(s => s.kind === "history" && s.args[1] === dm.id);
    assert.equal(backgroundWrites.length, 0, "manual starts before background save and owns the request slot");
    assert.ok(app.toasts.some(t => t[1] === "success"));
});
