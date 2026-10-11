import test from "node:test";
import assert from "node:assert/strict";
import { exportHtml, exportJson, exportStarted, exportText, loadPlugin, id, message } from "./harness.mjs";

const guild = { id: id(100), name: "Private thread fixture" };
const parent = { id: id(1), type: 0, name: "parent", guild_id: guild.id };
const privateThread = {
    id: id(2), type: 12, name: "private archive", guild_id: guild.id, parent_id: parent.id,
    thread_metadata: { archived: true, archive_timestamp: "2026-01-01T00:00:00.000Z" }
};
const privateUrl = `/channels/${privateThread.id}/messages`;
const privateContent = "PRIVATE-CONTENT-MUST-NOT-LEAK";
const privateMessage = () => ({ ...message(20), content: privateContent });
const archiveResponse = url => ({ body: {
    threads: url.endsWith("/threads/archived/private") ? [privateThread] : [],
    has_more: false, members: []
} });

function assertPrivateNotSaved(app) {
    assert.ok(!exportText(app).includes(privateContent), "TXT must discard revoked private history");
    assert.ok(!exportHtml(app).includes(privateContent), "HTML must discard revoked private history");
    assert.ok(!exportJson(app).includes(privateContent), "JSONL must discard revoked private history");
    // A page fetched just before access was revoked may be written and then deleted again, but it
    // must never survive the run: no record of it and no part file on disk.
    for (const saved of app.saved) {
        if (saved.kind === "history" && saved.channelId === privateThread.id)
            assert.ok(app.saved.some(entry => entry.kind === "history-discard" && entry.channelId === privateThread.id),
                "a page written for the revoked private thread must be deleted again");
    }
    for (const [file] of app.files)
        assert.ok(!file.includes(privateThread.id), "no part file may survive for the revoked private thread");
}

function assertPrivateSaved(app, mode) {
    if (mode === "manual") {
        assert.ok(exportStarted(app), "export must be persisted");
        assert.ok(exportText(app).includes(privateContent), "TXT retains currently authorized private history");
        assert.ok(exportHtml(app).includes(privateContent), "HTML retains currently authorized private history");
        assert.ok(exportJson(app).includes(privateContent), "JSONL retains currently authorized private history");
    } else {
        const saved = app.saved.find(s => s.kind === "history" && s.args[3] === privateThread.id);
        assert.ok(saved, "crawler retains currently authorized private history");
        assert.equal(saved.args[5][0].content, privateContent);
    }
}

const run = (app, mode) => mode === "manual" ? app.hooks.exportGuild(guild) : app.hooks.crawlAllHistory();

for (const mode of ["manual", "crawl"]) {
    for (const cached of [false, true]) {
        for (const authority of ["managed", "joined"]) {
            test(`${mode} retains ${cached ? "cached" : "uncached"} archived private history with current ${authority} access`, async () => {
                const app = loadPlugin({
                    channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                    can: bit => bit !== 4n || authority === "managed",
                    hasJoined: threadId => authority === "joined" && threadId === privateThread.id,
                    rest: ({ url }) => url.endsWith("/messages")
                        ? { body: [url === privateUrl ? privateMessage() : message(21)] } : archiveResponse(url)
                });
                await run(app, mode);
                assert.ok(app.requests.some(r => r.url === privateUrl));
                assertPrivateSaved(app, mode);
                const route = authority === "joined" ? "users/@me/threads/archived/private" : "threads/archived/private";
                assert.ok(app.requests.some(r => r.url === `/channels/${parent.id}/${route}`));
                assert.ok(!app.toasts.some(t => /不完全|一部/.test(t[0])));
            });

            for (const timing of ["own response", "earlier channel response"]) {
                test(`${mode} rejects ${cached ? "cached" : "uncached"} private history after ${authority} loss during ${timing}`, async () => {
                    let authorized = true;
                    const states = [];
                    const app = loadPlugin({
                        channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                        can: bit => bit !== 4n || authority === "managed" && authorized,
                        hasJoined: threadId => authority === "joined" && authorized && threadId === privateThread.id,
                        native: { saveCrawlState: async state => states.push(JSON.parse(JSON.stringify(state))) },
                        rest: ({ url }) => {
                            if (!url.endsWith("/messages")) return archiveResponse(url);
                            if (url === (timing === "own response" ? privateUrl : `/channels/${parent.id}/messages`)) authorized = false;
                            return { body: [url === privateUrl ? privateMessage() : message(21)] };
                        }
                    });
                    await run(app, mode);
                    assert.equal(app.requests.some(r => r.url === privateUrl), timing === "own response");
                    assertPrivateNotSaved(app);
                    assert.ok(states.every(state => !state[`${guild.id}:${privateThread.id}`]), "denied private history must not advance crawl state");
                    if (mode === "manual") assert.ok(!app.toasts.some(t => t[1] === "success"));
                });
            }
        }
    }
}

for (const cached of [false, true]) {
    for (const authority of ["managed", "joined"]) {
        test(`manual save rechecks ${authority} access after fetching another post (${cached ? "cached" : "uncached"} private)`, async () => {
            const forum = { id: id(3), type: 15, name: "forum", guild_id: guild.id };
            const post = { id: id(4), type: 11, name: "later post", parent_id: forum.id, guild_id: guild.id };
            let authorized = true;
            let fetchedPrivate = false;
            const app = loadPlugin({
                channels: [parent, forum, ...(cached ? [privateThread] : [])], guilds: [guild],
                can: bit => bit !== 4n || authority === "managed" && authorized,
                hasJoined: threadId => authority === "joined" && authorized && threadId === privateThread.id,
                rest: ({ url }) => {
                    if (url === `/channels/${forum.id}/threads/archived/public`) return { body: { threads: [post], has_more: false } };
                    if (url === privateUrl) {
                        fetchedPrivate = true;
                        return { body: [privateMessage()] };
                    }
                    if (url === `/channels/${post.id}/messages`) {
                        assert.equal(fetchedPrivate, true, "private history must already be buffered before revocation");
                        authorized = false;
                    }
                    return url.endsWith("/messages") ? { body: [message(21)] } : archiveResponse(url);
                }
            });
            await app.hooks.exportGuild(guild);
            assert.ok(fetchedPrivate);
            assert.ok(app.requests.some(r => r.url === `/channels/${post.id}/messages`));
            assertPrivateNotSaved(app);
            assert.ok(exportStarted(app), "still save accessible public data");
            assert.ok(exportText(app).includes("later post"));
            assert.ok(!app.toasts.some(t => t[1] === "success"));
        });
    }
}

test("manual export discards uncached private history when MANAGE_THREADS is revoked in its successful response", async () => {
    let managed = true;
    const app = loadPlugin({
        channels: [parent], guilds: [guild],
        can: bit => bit !== 4n || managed,
        rest: ({ url }) => {
            if (url === privateUrl) {
                managed = false;
                return { body: [privateMessage()] };
            }
            return url.endsWith("/messages") ? { body: [message(21)] } : archiveResponse(url);
        }
    });
    await app.hooks.exportGuild(guild);
    assert.ok(app.requests.some(r => r.url === privateUrl), "reproduce revocation after authorized discovery and GET");
    assertPrivateNotSaved(app);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});

test("live save discards a cached private message after MANAGE_THREADS is revoked", async () => {
    let managed = true;
    const app = loadPlugin({
        channels: [parent, privateThread], guilds: [guild], can: bit => bit !== 4n || managed
    });
    managed = false;
    await app.hooks.saveLiveMessage({ message: { ...privateMessage(), channel_id: privateThread.id, guild_id: guild.id } });
    assert.equal(app.saved.length, 0);
});

for (const mode of ["manual", "crawl"]) {
    for (const cached of [false, true]) {
        for (const membership of ["false", "undefined", "missing store"]) {
            test(`${mode} fails closed for ${cached ? "cached" : "uncached"} private archive with membership ${membership}`, async () => {
                const app = loadPlugin({
                    channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                    can: bit => bit !== 4n,
                    hasJoined: membership === "missing store" ? null : () => membership === "false" ? false : undefined,
                    rest: ({ url }) => url.endsWith("/messages") ? { body: [message(21)] } : archiveResponse(url)
                });
                await run(app, mode);
                assert.ok(!app.requests.some(r => r.url === privateUrl));
                assertPrivateNotSaved(app);
                assert.ok(app.toasts.some(t => /不完全|一部/.test(t[0])), "a joined-list response alone is not proof of current membership");
                assert.ok(!app.toasts.some(t => t[1] === "success"));
            });
        }

        for (const authority of ["managed", "joined"]) {
            test(`${mode} rechecks ${authority} access at save after a successful response check (${cached ? "cached" : "uncached"})`, async () => {
                let authorized = true;
                let bodyRead = false;
                const app = loadPlugin({
                    channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                    can: bit => bit !== 4n || authority === "managed" && authorized,
                    hasJoined: threadId => authority === "joined" && authorized && threadId === privateThread.id,
                    rest: ({ url }) => {
                        if (url === privateUrl) return {
                            // queuedGet rechecks authorization before reading response.body.
                            // Revoke at that boundary to exercise the later save guard itself.
                            get body() { bodyRead = true; authorized = false; return [privateMessage()]; }
                        };
                        return url.endsWith("/messages") ? { body: [message(21)] } : archiveResponse(url);
                    }
                });
                await run(app, mode);
                assert.ok(bodyRead, "the successful response check must already have completed");
                assertPrivateNotSaved(app);
            });
        }

        for (const revoked of ["managed", "joined"]) {
            test(`${mode} retains private history when ${revoked} is revoked but the other current authority remains (${cached ? "cached" : "uncached"})`, async () => {
                let managed = true;
                let joined = true;
                const app = loadPlugin({
                    channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                    can: bit => bit !== 4n || managed,
                    hasJoined: threadId => joined && threadId === privateThread.id,
                    rest: ({ url }) => {
                        if (!url.endsWith("/messages")) return archiveResponse(url);
                        if (url === privateUrl) {
                            if (revoked === "managed") managed = false;
                            else joined = false;
                        }
                        return { body: [url === privateUrl ? privateMessage() : message(21)] };
                    }
                });
                await run(app, mode);
                assertPrivateSaved(app, mode);
            });
        }

        for (const deniedBit of [1n]) {
            test(`${mode} never treats membership as a substitute for parent VIEW_CHANNEL (${cached ? "cached" : "uncached"})`, async () => {
                let denied = false;
                const app = loadPlugin({
                    channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                    can: (bit, channel) => bit !== 4n && !(denied && channel.id === parent.id && bit === deniedBit),
                    hasJoined: threadId => threadId === privateThread.id,
                    rest: ({ url }) => {
                        if (!url.endsWith("/messages")) return archiveResponse(url);
                        if (url === privateUrl) denied = true;
                        return { body: [url === privateUrl ? privateMessage() : message(21)] };
                    }
                });
                await run(app, mode);
                assert.ok(app.requests.some(r => r.url === privateUrl));
                assertPrivateNotSaved(app);
            });
        }

        // Restored contract: inclusion is VIEW_CHANNEL based (as in the previous release), so a
        // withheld history permission must not hide a thread the account can view.
        test(`${mode} keeps a viewable private thread when only history permission is withheld (${cached ? "cached" : "uncached"})`, async () => {
            let denied = false;
            const app = loadPlugin({
                channels: cached ? [parent, privateThread] : [parent], guilds: [guild],
                can: (bit, channel) => bit !== 4n && !(denied && channel.id === parent.id && bit === 2n),
                hasJoined: threadId => threadId === privateThread.id,
                rest: ({ url }) => {
                    if (!url.endsWith("/messages")) return archiveResponse(url);
                    if (url === privateUrl) denied = true;
                    return { body: [url === privateUrl ? privateMessage() : message(21)] };
                }
            });
            await run(app, mode);
            assertPrivateSaved(app, mode);
        });
    }
}

for (const authority of ["managed", "joined"]) {
    test(`live private save retains ${authority} access and rejects it after loss`, async () => {
        let authorized = true;
        const app = loadPlugin({
            channels: [parent, privateThread], guilds: [guild],
            can: bit => bit !== 4n || authority === "managed" && authorized,
            hasJoined: threadId => authority === "joined" && authorized && threadId === privateThread.id
        });
        await app.hooks.saveLiveMessage({ message: { ...privateMessage(), channel_id: privateThread.id, guild_id: guild.id } });
        assert.equal(app.saved.length, 1);
        assert.equal(app.saved[0].kind, "live");
        authorized = false;
        await app.hooks.saveLiveMessage({ message: { ...message(22), channel_id: privateThread.id, guild_id: guild.id } });
        assert.equal(app.saved.length, 1, "new event must not bypass the current permission check");
    });
}

test("uncached live private message is not persisted without a channel identity", async () => {
    const app = loadPlugin({ channels: [parent], guilds: [guild], hasJoined: () => true });
    await app.hooks.saveLiveMessage({ message: { ...privateMessage(), channel_id: privateThread.id, guild_id: guild.id } });
    assert.equal(app.saved.length, 0);
});

test("joined archive with unknown current membership fails closed and reports incomplete discovery", async () => {
    const app = loadPlugin({
        channels: [parent], guilds: [guild],
        can: bit => bit !== 4n,
        hasJoined: () => false,
        rest: ({ url }) => url.endsWith("/messages") ? { body: [message(21)] } : archiveResponse(url)
    });
    await app.hooks.exportGuild(guild);
    assert.ok(app.requests.some(r => r.url.includes("/users/@me/threads/archived/private")));
    assert.ok(!app.requests.some(r => r.url === privateUrl));
    assertPrivateNotSaved(app);
    assert.ok(exportStarted(app), "accessible parent is still exported");
    assert.match(exportText(app), /INCOMPLETE/);
    assert.ok(!app.toasts.some(t => t[1] === "success"));
});
