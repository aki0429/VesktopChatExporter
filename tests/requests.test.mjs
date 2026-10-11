import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id } from "./harness.mjs";

test("manual export retries a 429 through the shared paced request path", async () => {
    const dm = { id: id(1), type: 1 };
    let attempt = 0;
    const app = loadPlugin({ channels: [dm], rest: () => {
        if (++attempt === 1) throw { status: 429, body: { retry_after: 1000 } };
        return { body: [] };
    } });
    await app.hooks.exportDm(dm);
    assert.equal(app.requests.length, 2);
    assert.ok(app.waits.reduce((sum, ms) => sum + ms, 0) >= 1000000);
    assert.ok(app.requests.every(r => r.retries === 0));
});

test("DM blocked while the response is in flight is not persisted", async () => {
    const dm = { id: id(1), type: 1 };
    const app = loadPlugin({ channels: [dm], rest: () => {
        app.plugin.settings.store.blockedChannelIds = dm.id;
        return { body: [{ id: id(20), timestamp: "2026-01-01T00:00:00Z" }] };
    } });
    await app.hooks.exportDm(dm);
    assert.equal(app.saved.length, 0);
});

test("stopping the plugin during an export discards in-flight output", async () => {
    const dm = { id: id(1), type: 1 };
    const app = loadPlugin({ channels: [dm], rest: () => {
        app.plugin.stop();
        return { body: [] };
    } });
    await app.hooks.exportDm(dm);
    assert.equal(app.saved.length, 0);
});

test("unauthorized response stops all collection and does not report a successful export", async () => {
    const dm = { id: id(1), type: 1 };
    const app = loadPlugin({ channels: [dm], rest: () => { throw { status: 401 }; } });
    await app.hooks.exportDm(dm);
    await app.hooks.exportDm(dm);
    assert.equal(app.requests.length, 1);
    assert.equal(app.saved.length, 0);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});

test("cancellation during a 429 still holds the global queue for its full cooldown", async () => {
    const dm = { id: id(1), type: 1 };
    const app = loadPlugin({ channels: [dm], rest: () => {
        app.plugin.settings.store.blockedChannelIds = dm.id;
        throw { status: 429, body: { retry_after: 120 } };
    } });
    await app.hooks.exportDm(dm);
    assert.ok(app.waits.reduce((sum, ms) => sum + ms, 0) >= 122000);
    assert.equal(app.requests.length, 1);
});

test("retry_after always means seconds, including large waits", () => {
    const app = loadPlugin();
    assert.equal(app.hooks.retryAfterMs({ body: { retry_after: 1000 } }), 1000000);
    assert.ok(app.hooks.retryAfterMs({ body: { retry_after: 0.5 } }) >= 500);
});
