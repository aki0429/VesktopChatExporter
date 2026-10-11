import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id } from "./harness.mjs";

// Adaptive pacing: the configured interval is the floor, 429s push the interval up, successes bring
// it back down, so a full crawl finds a rate the account can sustain.

const guild = { id: id(100), name: "Fixture guild" };
const text = { id: id(1), type: 0, name: "text", guild_id: guild.id };
const page = (from, to) => ({ body: Array.from({ length: to - from + 1 }, (_, i) => ({
    id: id(from + i), timestamp: "2026-01-01T00:00:00.000Z", content: `m${from + i}`, author: { id: id(999) }
})).reverse() });

// The 429 sleep is its own, much larger wait; the paced intervals are the small ones.
const pacedIntervals = app => app.waits.filter(ms => ms < 5000);

test("the pure pacing decision slows down on a 429 and speeds back up to the floor", () => {
    const { nextDelay, DELAY_FLOOR, DELAY_CEILING } = loadPlugin({}).hooks;
    assert.equal(nextDelay(750, "ok"), 675, "a success only shaves a little off");
    assert.equal(nextDelay(750, "throttled"), 2000, "a 429 at least doubles the interval");
    assert.equal(nextDelay(8000, "throttled"), DELAY_CEILING, "and never exceeds the ceiling");
    assert.equal(nextDelay(500, "ok"), DELAY_FLOOR, "and never drops below the configured floor");

    let delay = 2000;
    for (let i = 0; i < 20; i++) delay = nextDelay(delay, "ok");
    assert.equal(delay, DELAY_FLOOR, "a run of successes walks all the way back down");
});

test("a 429 raises the next request interval above the configured one", async () => {
    let calls = 0;
    const app = loadPlugin({ channels: [text], guilds: [guild], rest: ({ url, query }) => {
        if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
        calls++;
        if (calls === 1) throw { status: 429, body: { retry_after: 1 } };
        return query?.before ? page(1, 50) : page(101, 200);
    } });
    await app.hooks.exportGuild(guild);

    // Discovery walks through the same queue, so compare the interval around the 429 instead of
    // the whole list: the request right after it doubles, the next success eases it back down.
    const paced = pacedIntervals(app);
    assert.equal(paced.at(-2), 2000, "the request after the 429 must use the raised interval");
    assert.equal(paced.at(-1), 1800, "then a success eases it back down");
});

test("with adaptive pacing off the interval never exceeds the configured one", async () => {
    let calls = 0;
    const app = loadPlugin({ channels: [text], guilds: [guild], settings: { adaptivePacing: false }, rest: ({ url, query }) => {
        if (!url.endsWith("/messages")) return { body: { threads: [], has_more: false } };
        calls++;
        if (calls === 1) throw { status: 429, body: { retry_after: 1 } };
        return query?.before ? page(1, 50) : page(101, 200);
    } });
    await app.hooks.exportGuild(guild);

    const paced = pacedIntervals(app);
    assert.ok(paced.length > 0);
    assert.ok(paced.every(ms => ms === 750), "a fixed interval must be respected");
});
