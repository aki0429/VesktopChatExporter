import test from "node:test";
import assert from "node:assert/strict";
import { exportStarted, exportText, loadPlugin, id, message } from "./harness.mjs";

const guild = { id: id(100), name: "Fixture guild" };
const text = { id: id(1), type: 0, name: "text", guild_id: guild.id };
const forum = { id: id(2), type: 15, name: "forum", guild_id: guild.id };
const post = { id: id(3), type: 11, name: "post", guild_id: guild.id, parent_id: forum.id, thread_metadata: { archive_timestamp: "2026-01-01T00:00:00.000Z" } };
const thread = { id: id(4), type: 11, name: "thread", guild_id: guild.id, parent_id: text.id };
const fixtureRest = ({ url }) => ({ body: url.endsWith("/messages") ? [message(20)] : url.endsWith("/threads/search") ? { threads: url === `/channels/${text.id}/threads/search` ? [thread] : [], has_more: false, members: [] } : { threads: url === `/channels/${forum.id}/threads/archived/public` ? [post] : [], has_more: false, members: [] } });

test("text permissions are checked on the channel, not its category parent", async () => {
    const category = { id: id(30), type: 4, guild_id: guild.id };
    const child = { ...text, parent_id: category.id };
    const app = loadPlugin({ channels: [category, child], guilds: [guild], can: (bit, channel) => channel.type !== 4, rest: fixtureRest });
    await app.hooks.exportGuild(guild);
    assert.ok(app.requests.some(r => r.url === `/channels/${text.id}/messages`));
});

const voice = { id: id(40), type: 2, name: "voice", guild_id: guild.id };
const stage = { id: id(41), type: 13, name: "stage", guild_id: guild.id };

test("full-channel export includes voice and stage channel text", async () => {
    const app = loadPlugin({ channels: [text, voice, stage], guilds: [guild], rest: fixtureRest });
    await app.hooks.exportGuild(guild);
    const messageUrls = app.requests.filter(r => r.url.endsWith("/messages")).map(r => r.url);
    assert.ok(messageUrls.includes(`/channels/${voice.id}/messages`), "voice channel text must be exported");
    assert.ok(messageUrls.includes(`/channels/${stage.id}/messages`), "stage channel text must be exported");
    // Voice/stage channels carry no threads, so discovery must not query them for threads.
    assert.ok(!app.requests.some(r => r.url === `/channels/${voice.id}/threads/search`));
    assert.ok(!app.requests.some(r => r.url === `/channels/${stage.id}/threads/search`));
});

test("a voice channel the account cannot view stays out of the export", async () => {
    const app = loadPlugin({
        channels: [text, voice], guilds: [guild],
        can: (bit, channel) => channel.id !== voice.id,
        rest: fixtureRest
    });
    assert.deepEqual([...app.hooks.getGuildParents(guild.id).map(c => c.id)], [text.id]);
    await app.hooks.exportGuild(guild);
    assert.ok(!app.requests.some(r => r.url === `/channels/${voice.id}/messages`));
    assert.ok(app.requests.some(r => r.url === `/channels/${text.id}/messages`));
});

test("the existing guild menu keeps its name", () => {
    const app = loadPlugin({ channels: [text, voice], guilds: [guild] });
    const children = [];
    app.plugin.contextMenus["guild-context"](children, { guild });
    const exportItem = children.find(c => c?.props?.id === "vc-export-guild-chat");
    assert.equal(exportItem.props.label, "全チャンネルのログを保存（TXT + HTML）");
});

test("thread context supports the same stop list menu as guild channels", () => {
    const app = loadPlugin({ channels: [text, thread], guilds: [guild] });
    const menu = app.plugin.contextMenus["thread-context"];
    assert.equal(typeof menu, "function");
    const children = [];
    menu(children, { channel: thread });
    assert.ok(children.some(c => c?.props?.id === "vc-toggle-channel-log"));
});

test("guild export saves active threads and archived forum posts instead of forum parents", async () => {
    const app = loadPlugin({ channels: [text, forum], guilds: [guild], rest: fixtureRest });
    await app.hooks.exportGuild(guild);
    assert.deepEqual(app.requests.filter(r => r.url.endsWith("/messages")).map(r => r.url).sort(), [text, post, thread].map(c => `/channels/${c.id}/messages`).sort());
    assert.ok(exportStarted(app), "the run must open its export files");
    assert.match(exportText(app), /post/);
    assert.match(exportText(app), /thread/);
});

test("crawler records forum post history, never marks a forum parent complete", async () => {
    const states = [];
    const app = loadPlugin({ channels: [text, forum], guilds: [guild], rest: fixtureRest, native: { saveCrawlState: async s => states.push(JSON.parse(JSON.stringify(s))) } });
    await app.hooks.crawlAllHistory();
    assert.ok(app.saved.some(s => s.kind === "history" && s.args[3] === post.id));
    assert.ok(states.every(s => !s[`${guild.id}:${forum.id}`]));
    assert.equal(states.at(-1)[`${guild.id}:${post.id}`].completed, true);
});

test("withheld history permission does not silently drop a viewable channel", async () => {
    // The previous release included every channel the account can view and reported a fetch
    // failure instead of hiding the channel, so inclusion must stay VIEW_CHANNEL based.
    const app = loadPlugin({ channels: [text, forum], guilds: [guild], can: bit => bit === 1n, rest: fixtureRest });
    await app.hooks.exportGuild(guild);
    assert.ok(app.requests.some(r => r.url === `/channels/${text.id}/messages`), "viewable channels must still be exported");
    assert.ok(exportStarted(app), "the export must still be written");
});

test("parent blocked during discovery cannot leak its post to export", async () => {
    const app = loadPlugin({ channels: [forum], guilds: [guild], rest: options => {
        app.plugin.settings.store.blockedChannelIds = forum.id;
        return fixtureRest(options);
    } });
    await app.hooks.exportGuild(guild);
    assert.ok(!app.requests.some(r => r.url.endsWith("/messages")));
    assert.equal(app.saved.length, 0);
});

test("discovery errors show an incomplete export instead of a success toast", async () => {
    const app = loadPlugin({ channels: [text], guilds: [guild], rest: options => {
        if (!options.url.endsWith("/messages")) throw { status: 403 };
        return fixtureRest(options);
    } });
    await app.hooks.exportGuild(guild);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
    assert.ok(app.toasts.some(t => /一部|不完全/.test(t[0])));
    assert.match(exportText(app), /403/);
});

test("background crawler rotates a bounded window of text parents while forums scan every cycle", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: id(1000 + i), type: 0, name: `t${i}`, guild_id: guild.id }));
    const media = { id: id(2000), type: 16, name: "media", guild_id: guild.id };
    const app = loadPlugin({ channels: [...many, forum, media], guilds: [guild] });
    const state = {};
    const collect = () => {
        const scan = app.hooks.buildActiveScan(state);
        return [...many, forum, media].filter(scan).map(c => c.id);
    };
    const first = collect();
    assert.equal(first.length, 82, "80 rotated text parents plus every forum/media parent");
    assert.ok(first.includes(forum.id) && first.includes(media.id));
    assert.equal(state.__activeScan.before, "80");
    const second = collect();
    assert.equal(state.__activeScan.before, "10");
    const textIds = new Set([...first, ...second].filter(id2 => many.some(c => c.id === id2)));
    assert.equal(textIds.size, 150, "two consecutive cycles cover every text parent exactly once in aggregate");
    assert.deepEqual(first.filter(id2 => many.some(c => c.id === id2)), many.slice(0, 80).map(c => c.id));
});

test("a 202 index-pending thread search is retried once after its retry_after", async () => {
    const searchUrl = `/channels/${text.id}/threads/search`;
    let first = true;
    const app = loadPlugin({ channels: [text, forum], guilds: [guild], rest: options => {
        if (options.url === searchUrl && first) {
            first = false;
            return { status: 202, body: { message: "Index not yet available. Try again later", code: 110000, documents_indexed: 0, retry_after: 0.1 } };
        }
        return fixtureRest(options);
    } });
    await app.hooks.exportGuild(guild);
    assert.equal(app.requests.filter(r => r.url === searchUrl).length, 2, "the not-indexed response must be retried exactly once");
    assert.ok(app.requests.some(r => r.url === `/channels/${thread.id}/messages`), "the thread must be discovered after the retry");
    assert.ok(!app.toasts.some(t => /一部|不完全/.test(t[0])), "a successful retry is not incomplete discovery");
});

test("a permanently pending search index is retried once, then reported incomplete", { timeout: 15000 }, async () => {
    const searchUrl = `/channels/${text.id}/threads/search`;
    const app = loadPlugin({ channels: [text, forum], guilds: [guild], rest: options => {
        if (options.url === searchUrl) return { status: 202, body: { message: "Index not yet available. Try again later", code: 110000, documents_indexed: 0, retry_after: 0.1 } };
        return fixtureRest(options);
    } });
    await app.hooks.exportGuild(guild);
    assert.equal(app.requests.filter(r => r.url === searchUrl).length, 2, "the pending notice must be retried exactly once, never in a loop");
    assert.ok(!app.requests.some(r => r.url === `/channels/${thread.id}/messages`), "the undiscovered thread must not be fetched");
    assert.ok(app.toasts.some(t => /一部|不完全/.test(t[0])), "a still-pending index is incomplete discovery, not silent success");
});
