import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message, exportText, exportHtml, exportJson, exportManifest } from "./harness.mjs";
const guild = { id: id(100), name: "checkpoint fixture" };
const parent = { id: id(1), type: 0, name: "parent", guild_id: guild.id };
const thread = { id: id(2), type: 12, name: "private", guild_id: guild.id, parent_id: parent.id };
test("checkpoint completion must recheck private access before the next await or assembly publication", async () => {
    let managed = true;
    const app = loadPlugin({ channels: [parent, thread], guilds: [guild], can: bit => bit !== 4n || managed,
        rest: ({ url }) => ({ body: url.endsWith("/messages") ? [url.includes(thread.id) ? { ...message(20), content: "private-checkpoint" } : message(21)] : { threads: [], has_more: false } }) });
    const checkpoint = app.native.checkpointExport;
    let revoked = false;
    app.native.checkpointExport = async (...args) => {
        await checkpoint(...args);
        const state = JSON.parse(args[2]);
        if (!revoked && state.phase === "assembling") { managed = false; revoked = true; }
    };
    await app.hooks.exportGuild(guild);
    assert.ok(revoked);
    for (const output of [exportText(app), exportHtml(app), exportJson(app), exportManifest(app)]) {
        assert.ok(!output.includes(thread.id), "checkpoint must never retain a now-revoked identity");
        assert.ok(!output.includes("private-checkpoint"));
    }
    assert.ok(exportText(app).includes("fixture message 21"));
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});
