import test from "node:test";
import assert from "node:assert/strict";
import { exportJson, exportManifest, exportText, exportHtml, loadPlugin, id, message, items } from "./harness.mjs";
const dm = { id: id(1), type: 3, name: "fixture" };

test("overlapping message pages are rejected before duplicate storage", async () => {
    let calls = 0;
    const app = loadPlugin({ channels: [dm], rest: () => ({ body: ++calls === 1
        ? Array.from({ length: 100 }, (_, i) => message(200 - i))
        : [message(102), message(100), message(99)] }) });
    await app.hooks.exportDm(dm);
    const ids = exportJson(app).split("\n").filter(Boolean).map(line => JSON.parse(line).messageId);
    assert.equal(ids.length, 100);
    assert.equal(new Set(ids).size, 100);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});

test("a failed private fetch which is later revoked cannot leak its name in notices or checkpoint", async () => {
    const guild = { id: id(100), name: "fixture" };
    const text = { id: id(1), guild_id: guild.id, type: 0, name: "parent" };
    const forum = { id: id(3), guild_id: guild.id, type: 15, name: "forum" };
    const thread = { id: id(2), parent_id: text.id, guild_id: guild.id, type: 12, name: "FIXTURE-REVOKED-NAME" };
    const post = { id: id(4), parent_id: forum.id, guild_id: guild.id, type: 11, name: "post" };
    let managed = true, tries = 0;
    const app = loadPlugin({ channels: [text, forum, thread], guilds: [guild], can: bit => bit !== 4n || managed,
        rest: ({ url }) => {
            if (url === `/channels/${thread.id}/messages`) {
                if (++tries === 2) throw { status: 500 };
                return { body: Array.from({ length: 100 }, (_, i) => message(200 - i)) };
            }
            if (url === `/channels/${post.id}/messages`) managed = false;
            return { body: url.endsWith("/messages") ? [message(21)]
                : { threads: url === `/channels/${forum.id}/threads/search` ? [post] : [], has_more: false } };
        } });
    await app.hooks.exportGuild(guild);
    for (const text of [exportText(app), exportManifest(app), exportJson(app)]) {
        assert.ok(!text.includes(thread.id));
        assert.ok(!text.includes(thread.name));
    }
    assert.ok(exportText(app).includes("fixture message 21"));
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});

test("a page interrupted after storage but before checkpoint is idempotently fetched once on resume", async () => {
    const app = loadPlugin({ channels: [dm], rest: () => ({ body: [message(20)] }) });
    const checkpoint = app.native.checkpointExport;
    let fail = true;
    app.native.checkpointExport = async (...args) => {
        if (fail && JSON.parse(args[2]).fetched === 1) { fail = false; throw new Error("fixture checkpoint failure"); }
        return checkpoint(...args);
    };
    await app.hooks.exportDm(dm);
    await app.hooks.exportDm(dm);
    const lines = exportJson(app).split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal((exportText(app).match(/fixture message 20/g) ?? []).length, 1);
});

test("discovery notices never persist a revoked parent's ID or endpoint", async () => {
    const guild = { id: id(100), name: "fixture" };
    const parent = { id: id(2), guild_id: guild.id, type: 0, name: "REVOKED-PARENT-FIXTURE" };
    const other = { id: id(3), guild_id: guild.id, type: 0, name: "public" };
    let readable = true;
    const app = loadPlugin({ channels: [parent, other], guilds: [guild],
        can: (bit, channel) => channel.id !== parent.id || readable,
        rest: ({ url }) => {
            if (url === `/channels/${parent.id}/threads/search`) throw { status: 403 };
            return { body: url.endsWith("/messages") ? [message(21)] : { threads: [], has_more: false } };
        } });
    const start = app.native.startExportFiles;
    app.native.startExportFiles = async (...args) => { const out = await start(...args); readable = false; return out; };
    await app.hooks.exportGuild(guild);
    for (const output of [exportText(app), exportHtml(app), exportManifest(app), exportJson(app)]) {
        assert.ok(!output.includes(parent.id));
        assert.ok(!output.includes(parent.name));
        assert.ok(!output.includes('/channels/'));
    }
    assert.ok(exportText(app).includes('HTTP 403'));
    assert.ok(!app.toasts.some(t => t[1] === 'success'));
});

for (const boundary of ['finishExport', 'publishExport']) {
    test(`cancellation during ${boundary} cannot leave a complete manifest or footer`, async () => {
        const app = loadPlugin({ channels: [dm], rest: () => ({ body: [message(20)] }) });
        const original = app.native[boundary];
        let cancelled = false;
        app.native[boundary] = async (...args) => {
            const out = await original(...args);
            if (!cancelled) {
                const menu = [];
                app.plugin.contextMenus['gdm-context'](menu, { channel: dm });
                items(menu).find(item => item.props.id === 'vc-cancel-dm-export').props.action();
                cancelled = true;
            }
            return out;
        };
        await app.hooks.exportDm(dm);
        assert.ok(cancelled);
        assert.equal(JSON.parse(exportManifest(app)).outcome, 'cancelled');
        assert.ok(exportText(app).includes('CANCELLED'));
        assert.ok(exportHtml(app).includes('CANCELLED'));
        assert.ok(!app.toasts.some(t => t[1] === 'success'));
        assert.ok(app.saved.filter(save => save.kind === 'export-files').length <= 2, 'one cancellation rebuild is bounded');
    });
}
