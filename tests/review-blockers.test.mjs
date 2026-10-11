import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message, exportManifest, exportJson, exportText, exportHtml } from "./harness.mjs";
const guild = { id: id(100), name: "review fixture" };
const parent = { id: id(1), type: 0, name: "parent", guild_id: guild.id };
const thread = { id: id(2), type: 12, name: "SECRET-FIXTURE-NAME", guild_id: guild.id, parent_id: parent.id };
const secret = "REVIEW-PRIVATE-FIXTURE";
const rest = ({ url }) => ({ body: url.endsWith("/messages") ? [url.includes(thread.id) ? { ...message(20), content: secret } : message(21)] : { threads: [], has_more: false } });
const assertScrubbed = app => {
    for (const output of [exportManifest(app), exportJson(app), exportText(app), exportHtml(app)]) {
        assert.ok(!output.includes(thread.id), "revoked identity must leave every output/checkpoint");
        assert.ok(!output.includes(secret));
        assert.ok(!output.includes(thread.name));
    }
};
for (const boundary of ["appendExport", "publishExport"]) {
    test(`revocation plus ${boundary} rejection scrubs private pages and progress independently of cleanup failure`, async () => {
        let managed = true;
        const app = loadPlugin({ channels: [parent, thread], guilds: [guild], can: bit => bit !== 4n || managed, rest });
        app.native[boundary] = async () => { managed = false; throw Object.assign(new Error("fixture"), { code: "EIO" }); };
        const abort = app.native.abortExportFiles;
        app.native.abortExportFiles = async (...args) => {
            await abort(...args);
            if (!managed) throw Object.assign(new Error("fixture cleanup"), { code: "EACCES" });
        };
        await app.hooks.exportGuild(guild);
        assertScrubbed(app);
        assert.equal(JSON.parse(exportManifest(app)).outcome, "failed");
        assert.ok(!app.toasts.some(t => t[1] === "success"));
    });
}

test("zero readable parents after an interrupted private run still scrub that pending run", async () => {
    let view = true;
    const app = loadPlugin({ channels: [parent, thread], guilds: [guild], can: bit => bit !== 1n || view, rest });
    const write = app.native.writeHistoryPageJson;
    app.native.writeHistoryPageJson = async (...args) => {
        const out = await write(...args);
        if (args[2] === thread.id) app.plugin.stop();
        return out;
    };
    await app.hooks.exportGuild(guild);
    assert.ok(exportJson(app).includes(secret));
    view = false;
    app.plugin.start();
    await app.hooks.exportGuild(guild);
    assertScrubbed(app);
});

test("a DM blocked after interruption still purges pending private history", async () => {
    const dm = { id: id(3), type: 3, name: "private DM" };
    const app = loadPlugin({ channels: [dm], rest: () => ({ body: [message(20)] }) });
    const write = app.native.writeHistoryPageJson;
    app.native.writeHistoryPageJson = async (...args) => { const out = await write(...args); app.plugin.stop(); return out; };
    await app.hooks.exportDm(dm);
    assert.ok(exportJson(app));
    app.plugin.start();
    app.plugin.settings.store.blockedChannelIds = dm.id;
    await app.hooks.exportDm(dm);
    assert.equal(exportJson(app), "");
    assert.ok(!exportManifest(app).includes(dm.id), "a fully blocked pending DM leaves no identifying run record");
});

test("tampered pending cursor cannot skip an entire page and report complete", async () => {
    const dm = { id: id(3), type: 3, name: "fixture" };
    const base = 400000000000000000n;
    const app = loadPlugin({ channels: [dm], rest: ({ query }) => {
        const end = query.before ? Number(BigInt(query.before) - base) - 1 : 250;
        const start = Math.max(1, end - 99);
        return { body: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => ({ ...message(end - i), id: String(base + BigInt(end - i)) })) };
    } });
    const write = app.native.writeHistoryPageJson;
    let once = true;
    app.native.writeHistoryPageJson = async (...args) => { const out = await write(...args); if (once) { once = false; app.plugin.stop(); } return out; };
    await app.hooks.exportDm(dm);
    const manifestFile = [...app.files.keys()].find(file => file.endsWith(".manifest.json"));
    const state = JSON.parse(app.files.get(manifestFile));
    state.progress[0].before = String(base + 51n);
    app.files.set(manifestFile, JSON.stringify(state));
    app.plugin.start();
    await app.hooks.exportDm(dm);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
    assert.equal(JSON.parse(exportManifest(app)).outcome, "failed");
    assert.equal(exportText(app), "");
});

test("a revoked channel cleanup rejection invalidates complete publication and retries its purge", async () => {
    let managed = true, failures = 0;
    const app = loadPlugin({ channels: [parent, thread], guilds: [guild], can: bit => bit !== 4n || managed, rest });
    const publish = app.native.publishExport;
    app.native.publishExport = async (...args) => { const out = await publish(...args); managed = false; return out; };
    const purge = app.native.purgeChannelPages;
    app.native.purgeChannelPages = async (...args) => {
        if (args[2] === thread.id && !failures++) {
            assert.notEqual(JSON.parse(exportManifest(app)).outcome, 'complete', 'invalidate before any fallible deletion');
            throw Object.assign(new Error('fixture purge EIO'), { code: 'EIO' });
        }
        return purge(...args);
    };
    await app.hooks.exportGuild(guild);
    assert.ok(failures >= 2, 'a removed progress entry must still have its deletion retried');
    assertScrubbed(app);
    assert.equal(JSON.parse(exportManifest(app)).outcome, 'failed');
    assert.ok(!app.toasts.some(t => t[1] === 'success'));
});

test("revocation during assembly bypasses failing selective deletion and purges the whole channel", async () => {
    let managed = true, purges = 0;
    const app = loadPlugin({ channels: [parent, thread], guilds: [guild], can: bit => bit !== 4n || managed, rest });
    const start = app.native.startExportFiles;
    app.native.startExportFiles = async (...args) => { const out = await start(...args); managed = false; return out; };
    app.native.discardHistoryPages = async () => { throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' }); };
    const purge = app.native.purgeChannelPages;
    app.native.purgeChannelPages = async (...args) => { if (args[2] === thread.id) purges++; return purge(...args); };
    await app.hooks.exportGuild(guild);
    assert.ok(purges > 0);
    assertScrubbed(app);
    assert.ok(!app.toasts.some(t => t[1] === 'success'));
});
