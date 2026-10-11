import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = fileURLToPath(new URL("../src/plugins/vesktopChatExporter/historyCrawl.ts", import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
const id = n => String(400000000000000000n + BigInt(n));
const messages = (first, last) => Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({ id: id(first + i) })).reverse();
const target = (n, type = 1, extra = {}) => ({ id: id(n), type, name: "synthetic", ...extra });
const dm = target(1);
const container = (channel = dm) => ({ category: "DMs", id: channel.id, name: "synthetic", channels: [channel] });
const keyOf = (c, channel = c.channels[0]) => `${c.id}:${channel.id}`;

function loadModule() {
    assert.ok(existsSync(source), "missing standalone history crawler; old completed=true skips latest messages");
    const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
    const context = { module: { exports: {} } };
    vm.runInNewContext(code, context, { filename: source });
    return context.module.exports;
}

function fixture({ state = {}, containers = [container()], data = messages(1, 20), get, save, saveState, discover, makeScan, limits } = {}) {
    const module = loadModule();
    let disk = clone(state);
    const flags = { running: true, manual: false, allowed: true };
    const requests = [], stored = [], reports = [], stateWrites = [], waits = [];
    let loads = 0;
    const deps = {
        loadState: async () => { loads++; return clone(disk); },
        saveState: async next => {
            if (saveState) await saveState(next, stateWrites.length);
            disk = clone(next); stateWrites.push(clone(next));
        },
        getContainers: () => containers,
        makeScan: makeScan ?? (s => { s.__activeScan = { ...(s.__activeScan ?? {}), before: "rotation" }; return () => true; }),
        discover: async (c, running, scanActive) => discover ? discover(c, running, scanActive) : { channels: c.channels, issues: [] },
        allowed: (c, channel) => typeof flags.allowed === "function" ? flags.allowed(c, channel) : flags.allowed,
        running: () => flags.running,
        manualActive: () => flags.manual,
        getPage: async (channelId, cursor, allowed) => {
            assert.equal(allowed(), true, "request is guarded before entering the shared queue");
            requests.push({ channelId, ...cursor, allowed });
            if (get) return get(channelId, cursor, allowed, requests.length);
            const rows = typeof data === "function" ? data(channelId) : data;
            return rows.filter(m => !cursor.before || BigInt(m.id) < BigInt(cursor.before)).slice(0, 100);
        },
        savePage: async (c, channel, page) => {
            if (save) await save(c, channel, page);
            stored.push({ containerId: c.id, channelId: channel.id, ids: Array.from(page, m => m.id) });
        },
        now: () => "2026-01-01T00:00:00.000Z",
        wait: async ms => { waits.push(ms); },
        report: event => reports.push(clone(event))
    };
    const crawler = module.createHistoryCrawler(deps, limits);
    return { module, deps, crawler, flags, requests, stored, reports, stateWrites, waits,
        get state() { return clone(disk); }, get loads() { return loads; } };
}

const storedIds = f => f.stored.flatMap(p => [...p.ids]);

test("completed legacy DM, group DM, text, public thread and forum post catch up without erasing progress", async () => {
    const guild = id(1000);
    const text = target(3, 0, { guild_id: guild });
    const forum = target(4, 15, { guild_id: guild });
    const thread = target(5, 11, { guild_id: guild, parent_id: text.id });
    const post = target(6, 11, { guild_id: guild, parent_id: forum.id });
    const containers = [container(dm), container(target(2, 3)), {
        id: guild, name: "synthetic", channels: [text, thread, post], discover: true
    }];
    const old = Object.fromEntries(containers.flatMap(c => c.channels.map(ch => [keyOf(c, ch), {
        before: id(10), completed: true, updatedAt: "legacy", extension: "keep"
    }])));
    old.__activeScan = { before: "7", extension: "keep" };
    old.unrelated = { before: "preserved", completed: false };
    const f = fixture({ containers, state: old, data: messages(1, 21) });
    const result = await f.crawler.run();
    assert.equal(result.errors, 0);
    assert.deepEqual(f.requests.map(r => r.channelId).sort(), [dm.id, id(2), text.id, thread.id, post.id].sort());
    for (const c of containers) for (const ch of c.channels) {
        const progress = f.state[keyOf(c, ch)];
        assert.equal(progress.newest, id(21));
        assert.equal(progress.before, id(10));
        assert.equal(progress.completed, true);
        assert.equal(progress.extension, "keep");
        assert.deepEqual(f.stored.find(p => p.channelId === ch.id).ids, messages(11, 21).map(m => m.id).reverse());
    }
    assert.equal(f.state.__activeScan.extension, "keep");
    assert.deepEqual(f.state.unrelated, old.unrelated);
});

test("legacy unfinished backfill continues below before independently of latest catch-up", async () => {
    const key = keyOf(container());
    const old = { before: id(151), completed: false, extension: "keep" };
    const f = fixture({ state: { [key]: old }, data: messages(1, 250) });
    await f.crawler.run();
    assert.ok(storedIds(f).includes(id(250)), "head is collected from latest, never after=anchor");
    assert.ok(storedIds(f).includes(id(1)), "older backfill is not replaced by head checkpoint");
    assert.equal(f.state[key].newest, id(250));
    assert.equal(f.state[key].completed, true);
    assert.equal(f.state[key].before, id(1));
    assert.equal(f.state[key].extension, "keep");
    assert.deepEqual(f.requests.map(r => r.before), [undefined, id(151), id(51)]);
});

test("bounded fresh head walk does not duplicate pages through the independent legacy backfill", async () => {
    const f = fixture({ data: messages(1, 900), limits: { maxPagesPerChannel: 2 } });
    for (let i = 0; i < 8 && !f.state[keyOf(container())]?.completed; i++) await f.crawler.run();
    assert.equal(storedIds(f).length, 900);
    assert.equal(f.state[keyOf(container())].newest, id(900));
    assert.equal(f.state[keyOf(container())].completed, true);
});

test("fresh 250-message archive stores every page once and commits its head only after completion", async () => {
    const f = fixture({ data: messages(1, 250) });
    await f.crawler.run();
    const progress = f.state[keyOf(container())];
    assert.equal(progress.newest, id(250));
    assert.equal(progress.before, id(1));
    assert.equal(progress.completed, true);
    assert.equal(storedIds(f).length, 250, "fresh head/backfill must not request the first older page twice");
    assert.deepEqual(f.requests.map(r => r.before), [undefined, id(151), id(51)]);
});

test("250-message head gap persists before/highwater across bounded process restart and collects later arrivals next run", async () => {
    const key = keyOf(container());
    const f = fixture({ state: { [key]: { newest: id(20), before: id(1), completed: true } },
        data: messages(1, 270), limits: { maxPagesPerRun: 1 } });
    await f.crawler.run();
    assert.equal(f.state[key].newest, id(20), "partial gap must not commit the high-water mark");
    assert.deepEqual(f.state[key].catchup, { anchor: id(20), before: id(171), highWater: id(270) });
    const restarted = fixture({ state: f.state, data: messages(1, 280) });
    await restarted.crawler.run();
    assert.equal(restarted.requests[0].before, id(171));
    assert.equal(restarted.state[key].newest, id(270));
    assert.equal(restarted.state[key].catchup, undefined);
    const collected = [...storedIds(f), ...storedIds(restarted)].sort();
    assert.deepEqual(collected, messages(21, 270).map(m => m.id).sort());
    await restarted.crawler.run();
    assert.equal(restarted.state[key].newest, id(280));
    assert.deepEqual(storedIds(restarted).slice(-10), messages(271, 280).map(m => m.id).reverse());
});

test("cursor validation rejects even a partially advancing response before any storage or cursor update", async () => {
    const key = keyOf(container());
    const progress = { newest: id(20), before: id(1), completed: true,
        catchup: { anchor: id(20), before: id(100), highWater: id(200) } };
    const f = fixture({ state: { [key]: progress }, get: () => [{ id: id(150) }, { id: id(99) }] });
    const result = await f.crawler.run();
    assert.equal(result.errors, 1);
    assert.equal(f.stored.length, 0, "one older id must not conceal a repeated/newer id outside before");
    assert.deepEqual(f.state[key], progress);
    assert.deepEqual(f.reports, [{ kind: "cursor", count: 1 }]);
});

test("deleted newest message cannot move a completed high-water mark backwards", async () => {
    const key = keyOf(container());
    const f = fixture({ state: { [key]: { newest: id(20), before: id(1), completed: true } }, data: messages(1, 19) });
    await f.crawler.run();
    assert.equal(f.state[key].newest, id(20));
    assert.equal(f.stored.length, 0);
});

test("empty final head page preserves the oldest cursor when a fresh archive length is exactly 100", async () => {
    const key = keyOf(container());
    const f = fixture({ data: messages(1, 100) });
    await f.crawler.run();
    assert.equal(f.state[key].before, id(1));
    assert.equal(f.state[key].newest, id(100));
    assert.equal(f.state[key].completed, true);
    assert.equal(storedIds(f).length, 100);
});

test("unordered pages use the numerical oldest cursor before saving in ascending order", async () => {
    const key = keyOf(container());
    const f = fixture({ state: { [key]: { newest: id(1), completed: true } }, get: (c, cursor) => {
        if (cursor.before) return [];
        const page = messages(2, 101);
        return [page.at(-1), ...page.slice(0, -1)];
    } });
    await f.crawler.run();
    assert.deepEqual(f.requests.map(r => r.before), [undefined, id(2)]);
    assert.deepEqual(storedIds(f), messages(2, 101).map(m => m.id).reverse());
    assert.equal(f.state[key].newest, id(101));
});

test("storage failure leaves head and independent older checkpoint retryable and reports metadata only", async () => {
    const key = keyOf(container());
    let fails = true;
    const progress = { newest: id(20), before: id(10), completed: false,
        catchup: { anchor: id(20), before: id(121), highWater: id(220) } };
    const f = fixture({ state: { [key]: progress }, data: messages(1, 220), save: () => {
        if (fails) throw new Error("private synthetic error must not be reported");
    } });
    const failed = await f.crawler.run();
    assert.equal(failed.errors, 1);
    assert.deepEqual(f.state[key], progress);
    assert.equal(f.stored.length, 0);
    assert.deepEqual(f.reports, [{ kind: "storage", count: 1 }]);
    fails = false;
    await f.crawler.run();
    assert.equal(f.requests[1].before, id(121));
    assert.equal(f.state[key].newest, id(220));
    assert.equal(f.state[key].completed, true);
});

test("manual export starting midrequest yields the page without notices or checkpoint advancement", async () => {
    const key = keyOf(container());
    let first = true, queuedAllowed;
    const f = fixture({ state: { [key]: { newest: id(20), before: id(1), completed: true } }, get: (c, cursor, allowed) => {
        queuedAllowed = allowed;
        if (first) { first = false; f.flags.manual = true; }
        return messages(20, 21);
    } });
    const yielded = await f.crawler.run();
    assert.equal(queuedAllowed(), false, "shared queue sees live manualActive guard");
    assert.equal(yielded.yielded, true);
    assert.equal(yielded.errors, 0);
    assert.equal(f.stored.length, 0);
    assert.equal(f.reports.length, 0);
    assert.deepEqual(f.state[key].catchup, { anchor: id(20) });
    assert.equal(f.state[key].newest, id(20));
    f.flags.manual = false;
    await f.crawler.run();
    assert.equal(f.state[key].newest, id(21));
    assert.deepEqual(storedIds(f), [id(21)]);
});

test("manual queued cancellation and revocation after a response never save or emit failure", async () => {
    const key = keyOf(container());
    for (const reason of ["manual", "allowed"]) {
        const f = fixture({ state: { [key]: { newest: id(20), completed: true } }, get: (c, cursor, allowed) => {
            f.flags[reason] = reason === "manual";
            assert.equal(allowed(), false);
            if (reason === "manual") throw new Error("queue cancelled");
            return messages(20, 21);
        } });
        const result = await f.crawler.run();
        assert.equal(result.errors, 0);
        assert.equal(f.stored.length, 0);
        assert.equal(f.reports.length, 0);
        assert.equal(f.state[key].newest, id(20));
    }
});

function schedulerFixture() {
    const module = loadModule();
    assert.equal(typeof module.createHistoryScheduler, "function", "OFF/ON needs a one-timer scheduler independent of enabled");
    const flags = { lifecycle: true, enabled: false, manual: false };
    const timers = new Map();
    let serial = 0, io = 0;
    let run = async () => { io++; };
    const scheduler = module.createHistoryScheduler({
        canSchedule: () => flags.lifecycle,
        enabled: () => flags.enabled,
        manualActive: () => flags.manual,
        run: () => run(),
        setTimer: (fn, ms) => { const handle = ++serial; timers.set(handle, { fn, ms }); return handle; },
        clearTimer: handle => timers.delete(handle)
    });
    return { scheduler, flags, timers, get io() { return io; },
        set run(fn) { run = fn; },
        async tick() {
            assert.equal(timers.size, 1, "exactly one pending timer");
            const [handle, timer] = [...timers][0]; timers.delete(handle); await timer.fn();
        } };
}

test("OFF startup preserves no-I/O readiness checks and ON resumes; manual pause also preserves readiness", async () => {
    const f = schedulerFixture();
    f.scheduler.start();
    assert.equal([...f.timers.values()][0].ms, 10_000);
    await f.tick();
    assert.equal(f.io, 0);
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].ms, 10_000);
    f.flags.enabled = true;
    await f.tick();
    assert.equal(f.io, 1);
    assert.equal([...f.timers.values()][0].ms, 300_000);
    f.flags.manual = true;
    await f.tick();
    assert.equal(f.io, 1);
    assert.equal([...f.timers.values()][0].ms, 10_000);
    f.flags.manual = false;
    await f.tick();
    assert.equal(f.io, 2);
    f.scheduler.stop();
    assert.equal(f.timers.size, 0);
});

test("OFF during I/O schedules readiness again; only lifecycle/auth stop suppresses the timer", async () => {
    const f = schedulerFixture();
    f.flags.enabled = true;
    f.run = async () => { f.flags.enabled = false; };
    f.scheduler.start();
    await f.tick();
    assert.equal(f.timers.size, 1);
    assert.equal([...f.timers.values()][0].ms, 10_000);
    f.flags.enabled = true;
    f.run = async () => { f.flags.lifecycle = false; };
    await f.tick();
    assert.equal(f.timers.size, 0);
});

test("explicit scheduler tick replaces its pending timer rather than orphaning a duplicate", async () => {
    const f = schedulerFixture();
    f.scheduler.start();
    await f.scheduler.tick();
    assert.equal(f.timers.size, 1);
});

test("state-write failure cannot publish a new cursor even after archive storage succeeded", async () => {
    const key = keyOf(container());
    const progress = { newest: id(20), before: id(1), completed: true,
        catchup: { anchor: id(20), before: id(121), highWater: id(220) } };
    let fails = true;
    const f = fixture({ state: { [key]: progress }, data: messages(1, 220), saveState: s => {
        if (fails && s[key].catchup?.before !== id(121)) throw new Error("synthetic state storage");
    } });
    const result = await f.crawler.run();
    assert.equal(result.errors, 1);
    assert.deepEqual(f.state[key], progress);
    assert.equal(f.stored.length, 1);
    assert.deepEqual(f.reports, [{ kind: "state", count: 1 }]);
    fails = false;
    await f.crawler.run();
    assert.equal(f.requests[1].before, id(121));
    assert.equal(f.state[key].newest, id(220));
});

test("bounded cycles rotate targets so completed heads cannot starve later containers", async () => {
    const channels = [target(1), target(2), target(3)];
    const f = fixture({ containers: channels.map(ch => container(ch)), limits: { maxPagesPerRun: 1 } });
    for (let i = 0; i < 3; i++) await f.crawler.run();
    assert.deepEqual(f.requests.map(r => r.channelId), channels.map(ch => ch.id));
});

test("bounded resume rotates inside one container when every request fails", async () => {
    const channels = [target(1), target(2), target(3)];
    const c = { id: id(1000), name: "synthetic", channels };
    const state = Object.fromEntries(channels.map(ch => [keyOf(c, ch), {
        newest: id(20), completed: true, catchup: { anchor: id(20), before: id(100), highWater: id(200) }
    }]));
    const f = fixture({ state, containers: [c], limits: { maxPagesPerRun: 1 }, get: () => { throw { status: 500 }; } });
    for (let i = 0; i < 3; i++) await f.crawler.run();
    assert.deepEqual(f.requests.map(r => r.channelId), channels.map(ch => ch.id));
});

test("failed message requests also consume the global run budget", async () => {
    const channels = [target(1), target(2), target(3)];
    const f = fixture({ containers: channels.map(ch => container(ch)), limits: { maxPagesPerRun: 1 },
        get: () => { throw { status: 500 }; } });
    const result = await f.crawler.run();
    assert.equal(f.requests.length, 1);
    assert.equal(result.pages, 1);
    assert.equal(result.errors, 1);
    assert.equal(result.bounded, true);
    assert.deepEqual(f.reports, [{ kind: "request", count: 1, status: 500 }]);
});

test("concurrent calls share one runner and scheduler stop during an await leaves no timer", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const f = fixture({ get: async () => { await pending; return messages(1, 20); } });
    const first = f.crawler.run();
    for (let i = 0; i < 10 && !f.requests.length; i++) await Promise.resolve();
    assert.equal((await f.crawler.run()).busy, true);
    assert.equal(f.requests.length, 1);
    release(); await first;
    const s = schedulerFixture();
    s.flags.enabled = true;
    let finish;
    s.run = () => new Promise(resolve => { finish = resolve; });
    s.scheduler.start();
    const tick = s.tick();
    s.scheduler.stop();
    finish(); await tick;
    assert.equal(s.timers.size, 0);
});

test("OFF and manual-before-run make zero state/discovery/message/storage calls", async () => {
    const f = fixture();
    f.flags.running = false;
    await f.crawler.run();
    f.flags.running = true; f.flags.manual = true;
    await f.crawler.run();
    assert.equal(f.loads, 0);
    assert.equal(f.stateWrites.length, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.stored.length, 0);
});

test("denied discovery targets stay excluded and permitted private-thread membership stays included", async () => {
    const privateThread = target(30, 12, { parent_id: id(31) });
    const blockedThread = target(32, 11, { parent_id: id(33) });
    const unknownPrivate = target(34, 12, { parent_id: id(31) });
    const c = { id: id(1000), name: "synthetic", channels: [privateThread, blockedThread, unknownPrivate], discover: true };
    const f = fixture({ containers: [c], discover: () => ({ channels: c.channels, issues: [{ message: "never emitted" }] }) });
    f.flags.allowed = (container, channel) => channel.id === privateThread.id;
    const result = await f.crawler.run();
    assert.deepEqual(f.requests.map(r => r.channelId), [privateThread.id]);
    assert.deepEqual(f.stored.map(r => r.channelId), [privateThread.id]);
    assert.equal(result.errors, 1);
    assert.deepEqual(f.reports, [{ kind: "discovery", count: 1 }]);
});
