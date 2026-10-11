import test from "node:test";
import assert from "node:assert/strict";
import { exportText, loadPlugin, id, items, message } from "./harness.mjs";

const dm = { id: id(1), type: 1, recipients: [id(2)], rawRecipients: [] };
const group = { id: id(3), type: 3, name: "Fixture group", recipients: [id(2)] };

test("DM user context resolves the existing DM when no channel prop is passed", async () => {
    const app = loadPlugin({ channels: [dm], users: [{ id: id(2), username: "Fixture partner" }], rest: () => ({ body: [message(10)] }) });
    const children = [];
    app.plugin.contextMenus["user-context"](children, { user: { id: id(2) } });
    const item = items(children).find(x => x.props.id === "vc-export-dm-chat");
    assert.ok(item, "DM save menu must be available from a user-only context");
    await item.props.action();
    assert.equal(app.requests[0].url, `/channels/${dm.id}/messages`);
    assert.equal(app.saved.find(s => s.kind === "export-begin").args[0], "DMs");
    assert.match(exportText(app), /fixture message 10/);
});

test("DM labels resolve recipient IDs from the user store", () => {
    const app = loadPlugin({ channels: [dm], users: [{ id: id(2), username: "Fixture partner" }] });
    assert.equal(app.hooks.channelLabel(dm), "Fixture partner");
});

test("blocked DM cannot be exported through its menu or a stale action", async () => {
    const app = loadPlugin({ channels: [dm], settings: { blockedChannelIds: dm.id } });
    await app.hooks.exportDm(dm);
    assert.equal(app.requests.length, 0, "blocked DM must not be fetched");
    assert.equal(app.saved.length, 0, "blocked DM must not be written");
});

test("existing DM and group DM are included in automatic history", async () => {
    const app = loadPlugin({ channels: [dm, group], rest: () => ({ body: [message(10)] }) });
    await app.hooks.crawlAllHistory();
    assert.deepEqual(app.requests.map(r => r.url).sort(), [dm, group].map(c => `/channels/${c.id}/messages`).sort());
    assert.equal(app.saved.filter(s => s.kind === "history" && s.args[0] === "DMs").length, 2);
});

test("live thread inherits its parent channel block", async () => {
    const guild = { id: id(5), name: "Fixture guild" };
    const parent = { id: id(6), type: 15, guild_id: guild.id };
    const thread = { id: id(7), type: 11, parent_id: parent.id, guild_id: guild.id };
    const app = loadPlugin({ channels: [parent, thread], guilds: [guild], settings: { blockedChannelIds: parent.id } });
    await app.hooks.saveLiveMessage({ message: { ...message(10), channel_id: thread.id } });
    assert.equal(app.saved.length, 0);
});

test("live DM and group DM use separate local DM category", async () => {
    const app = loadPlugin({ channels: [dm, group] });
    await app.hooks.saveLiveMessage({ message: { ...message(10), channel_id: dm.id } });
    await app.hooks.saveLiveMessage({ message: { ...message(11), channel_id: group.id } });
    assert.equal(app.saved.length, 2);
    assert.ok(app.saved.every(s => s.args[0].category === "DMs"));
});
