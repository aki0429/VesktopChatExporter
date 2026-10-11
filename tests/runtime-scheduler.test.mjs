import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message } from "./harness.mjs";

const dm = { id: id(1), type: 1 };

test("history disabled at startup preserves a future no-I/O scheduler check", async () => {
    const app = loadPlugin({ channels: [dm], settings: { forceHistoryCrawl: false } });
    app.plugin.start();
    const first = app.timers.find(timer => timer.fn.name === "crawlAllHistory");
    assert.ok(first);
    await first.fn();
    assert.equal(app.requests.length, 0);
    app.plugin.settings.store.forceHistoryCrawl = true;
    assert.ok(app.timers.some(timer => timer !== first && !timer.cleared && timer.fn.name === "crawlAllHistory"));
});

test("background collection paused during a request has a later tick after enabling", async () => {
    const app = loadPlugin({ channels: [dm], rest: () => {
        app.plugin.settings.store.forceHistoryCrawl = false;
        return { body: [message(10)] };
    } });
    app.plugin.start();
    const first = app.timers.find(timer => timer.fn.name === "crawlAllHistory");
    await first.fn();
    app.plugin.settings.store.forceHistoryCrawl = true;
    assert.ok(app.timers.some(timer => timer !== first && !timer.cleared && timer.fn.name === "crawlAllHistory"));
});

test("stop-start during a pending crawl cannot create an orphan timer from the old lifecycle", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const app = loadPlugin({ channels: [dm], native: { loadCrawlState: async () => { await pending; return {}; } } });
    app.plugin.start();
    const first = app.timers.find(timer => timer.fn.name === "crawlAllHistory");
    const run = first.fn();
    app.plugin.stop();
    app.plugin.start();
    release();
    await run;
    const liveTimers = () => app.timers.filter(timer => timer.fn.name === "crawlAllHistory" && !timer.cleared);
    assert.equal(liveTimers().length, 1);
    app.plugin.stop();
    assert.equal(liveTimers().length, 0);
});

test("a new startup tick firing before the old crawl drains still leaves exactly one future check", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const app = loadPlugin({ channels: [dm], native: { loadCrawlState: async () => { await pending; return {}; } } });
    app.plugin.start();
    const first = app.timers.find(timer => timer.fn.name === "crawlAllHistory");
    const run = first.fn();
    app.plugin.stop();
    app.plugin.start();
    const startup = app.timers.at(-1);
    startup.cleared = true; // Emulate expiration, not cancellation, of this timer.
    await startup.fn();
    release(); await run;
    const future = app.timers.filter(timer => timer.fn.name === "crawlAllHistory" && !timer.cleared);
    assert.equal(future.length, 1);
    app.plugin.stop();
    assert.ok(future.every(timer => timer.cleared));
});
