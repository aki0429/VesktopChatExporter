import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(new URL("../src/plugins/vesktopChatExporter/targets.ts", import.meta.url));
const code = buildSync({ entryPoints: [filename], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
const context = { module: { exports: {} } };
vm.runInNewContext(code, context, { filename });
const { discoverGuildTargets } = context.module.exports;
const id = n => `100000000000000${String(n).padStart(3, "0")}`;
const guildId = id(1);
const parent = (n, type = 0) => ({ id: id(n), type, guild_id: guildId, name: `parent ${n}` });
const thread = (n, p, type = 11, timestamp = "2026-01-02T03:04:05.123456+00:00") => ({
    id: id(n), type, guild_id: guildId, parent_id: p.id, name: `thread ${n}`,
    thread_metadata: { archive_timestamp: timestamp }
});
const page = (threads = [], has_more = false) => ({ threads, has_more });
const plain = value => JSON.parse(JSON.stringify(value));
const ids = result => Array.from(result.channels, c => c.id).sort();

async function discover(overrides = {}) {
    const calls = [];
    const result = await discoverGuildTargets({
        guildId, parents: [], cachedThreads: [], canRead: () => true, isBlocked: () => false,
        canManage: () => false, isStopped: () => false, scanActive: () => true,
        ...overrides,
        get: async (url, query) => {
            calls.push({ url, query: plain(query ?? {}) });
            return overrides.get ? overrides.get(url, query) : page();
        }
    });
    return { ...result, calls };
}

test("text, announcement, voice and stage parents are message targets; cached threads are normalized and deduplicated", async () => {
    const text = parent(2), announcement = parent(3, 5), forum = parent(4, 15), media = parent(5, 16), voice = parent(6, 2), stage = parent(7, 13);
    const cached = [thread(11, text), thread(12, announcement, 10), thread(13, forum), thread(14, media), thread(15, text, 12)];
    const result = await discover({ parents: [text, announcement, forum, media, voice, stage, text], cachedThreads: [...cached, cached[0]] });
    assert.deepEqual(ids(result), [text.id, announcement.id, voice.id, stage.id, ...cached.map(c => c.id)].sort());
    assert.deepEqual(plain(result.issues), []);
    // Voice and stage text has no thread list: never searched, never archive-listed.
    assert.deepEqual(result.calls.filter(c => c.url.includes(voice.id) || c.url.includes(stage.id)), []);
    assert.deepEqual(plain(result.channels.find(c => c.id === cached[0].id)), {
        id: cached[0].id, type: 11, guild_id: guildId, parent_id: text.id, name: cached[0].name
    }, "REST/cache entries become MessageTarget values, not Channel instances or raw metadata");
});

test("each eligible parent is searched for active threads and results merge with cached public, private and announcement threads", async () => {
    const text = parent(2), announcement = parent(3, 5), forum = parent(4, 15), media = parent(5, 16);
    const cached = thread(10, text);
    const active = [cached, thread(11, text, 12), thread(12, announcement, 10), thread(13, forum), thread(14, media)];
    const result = await discover({
        parents: [text, announcement, forum, media], cachedThreads: [cached],
        get: (url, query) => url.endsWith("/threads/search")
            ? { threads: active.filter(c => c.parent_id === url.split("/")[2]), has_more: false }
            : page()
    });
    assert.deepEqual(ids(result), [text.id, announcement.id, ...active.map(c => c.id)].sort());
    assert.deepEqual(result.calls.filter(c => c.url.endsWith("/threads/search")),
        [text, announcement, forum, media].map(p => ({ url: `/channels/${p.id}/threads/search`, query: { limit: 25, archived: false } })));
    assert.deepEqual(plain(result.issues), []);
});

test("active thread search pages by offset, reports stuck pagination and honors the scanActive gate", async t => {
    await t.test("offset paging", async () => {
        const text = parent(2), a = thread(10, text), b = thread(11, text);
        const url = `/channels/${text.id}/threads/search`;
        let pages = 0;
        const result = await discover({ parents: [text], get: route => route !== url ? page() : ++pages === 1 ? page([a], true) : page([b]) });
        assert.deepEqual(ids(result), [text.id, a.id, b.id].sort());
        assert.deepEqual(result.calls.filter(c => c.url === url), [
            { url, query: { limit: 25, archived: false } },
            { url, query: { limit: 25, archived: false, offset: 1 } }
        ]);
        assert.deepEqual(plain(result.issues), []);
    });
    await t.test("stuck pagination reports an issue once", async () => {
        const text = parent(2);
        const url = `/channels/${text.id}/threads/search`;
        const result = await discover({ parents: [text], get: route => route !== url ? page() : page([], true) });
        assert.equal(result.calls.filter(c => c.url === url).length, 1);
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].scope, url);
    });
    await t.test("scanActive excludes parents from search without touching archive routes", async () => {
        const text = parent(2), forum = parent(3, 15);
        const result = await discover({ parents: [text, forum], scanActive: p => p.type === 15 });
        assert.deepEqual(result.calls.filter(c => c.url.endsWith("/threads/search")), [
            { url: `/channels/${forum.id}/threads/search`, query: { limit: 25, archived: false } }
        ]);
    });
});

test("archive routes cover every eligible parent and choose managed versus joined private threads", async t => {
    for (const manages of [true, false]) await t.test(`MANAGE_THREADS=${manages}`, async () => {
        const text = parent(2), announcement = parent(3, 5), forum = parent(4, 15), media = parent(5, 16);
        const parents = [text, announcement, forum, media];
        const publicThreads = parents.map((p, i) => thread(10 + i, p, p.type === 5 ? 10 : 11));
        const privateThread = thread(14, text, 12);
        const result = await discover({
            parents: [...parents, text], cachedThreads: [publicThreads[0]], canManage: () => manages,
            get: (url, query) => {
                if (url.endsWith("/threads/search")) {
                    const parentId = url.split("/")[2];
                    return { threads: publicThreads.filter(c => c.parent_id === parentId), has_more: false };
                }
                if (url.endsWith("/private")) return page([privateThread]);
                return page(publicThreads.filter(c => url.startsWith(`/channels/${c.parent_id}/`)));
            }
        });
        assert.deepEqual(ids(result), [text.id, announcement.id, ...publicThreads.map(c => c.id), privateThread.id].sort());
        assert.deepEqual(result.calls.filter(c => !c.url.endsWith("/threads/search")).map(c => c.url).sort(), [
            ...parents.map(p => `/channels/${p.id}/threads/archived/public`),
            manages ? `/channels/${text.id}/threads/archived/private` : `/channels/${text.id}/users/@me/threads/archived/private`
        ].sort());
        assert.ok(result.calls.filter(c => !c.url.endsWith("/threads/search")).every(c => c.query.limit === 100));
        assert.deepEqual(plain(result.issues), []);
    });
});

test("has_more drives pagination using the unfiltered tail and exact ISO or joined-thread ID cursor", async t => {
    for (const kind of ["public", "managed", "joined"]) await t.test(kind, async () => {
        const text = parent(2);
        const first = thread(10, text, kind === "public" ? 11 : 12);
        const blocked = thread(11, text, first.type, "2026-01-01T12:34:56.123456+09:00");
        const last = thread(12, text, first.type, "2025-12-01T00:00:00.000000+00:00");
        const url = kind === "public" ? `/channels/${text.id}/threads/archived/public`
            : kind === "managed" ? `/channels/${text.id}/threads/archived/private`
                : `/channels/${text.id}/users/@me/threads/archived/private`;
        const cursor = kind === "joined" ? blocked.id : blocked.thread_metadata.archive_timestamp;
        let pages = 0;
        const result = await discover({
            parents: [text], canManage: () => kind === "managed", isBlocked: c => c.id === blocked.id,
            get: route => route === url ? (++pages === 1 ? page([first, blocked], true) : page([last])) : page()
        });
        assert.deepEqual(result.calls.filter(c => c.url === url), [
            { url, query: { limit: 100 } }, { url, query: { limit: 100, before: cursor } }
        ], "a short or blocked page with has_more=true must not terminate pagination");
        assert.deepEqual(ids(result), [text.id, first.id, last.id].sort());
        assert.deepEqual(plain(result.issues), []);
    });
});

test("broken pagination reports an issue and terminates that route without retrying", async t => {
    const text = parent(2), url = `/channels/${text.id}/threads/archived/public`;
    const valid = thread(10, text);
    for (const [name, body, count] of [
        ["repeated cursor", page([valid], true), 2],
        ["empty has_more", page([], true), 1],
        ["missing cursor", page([{ ...valid, thread_metadata: {} }], true), 1],
        ["invalid cursor", page([{ ...valid, thread_metadata: { archive_timestamp: "not-an-ISO-date" } }], true), 1]
    ]) await t.test(name, async () => {
        let requests = 0;
        const result = await discover({ parents: [text], get: route => {
            if (route !== url) return page();
            return ++requests < 4 ? body : page(); // Finite guard also makes a missing loop guard fail quickly.
        } });
        assert.equal(result.issues.length, 1, "an incomplete route must never look like successful empty discovery");
        assert.equal(result.issues[0].scope, url);
        assert.equal(requests, count);
    });
});

test("malformed REST bodies produce scoped issues rather than successful empty pages", async t => {
    const text = parent(2);
    for (const endpoint of ["search", "public"]) {
        const url = endpoint === "search" ? `/channels/${text.id}/threads/search` : `/channels/${text.id}/threads/archived/public`;
        const bodies = [null, [], {}, { body: page() }, { threads: null }, { threads: {} }, { threads: [] }, { threads: [], has_more: "false" }];
        for (const [i, body] of bodies.entries()) await t.test(`${endpoint} invalid body ${i}`, async () => {
            const result = await discover({ parents: [text], get: route => route === url ? body : page() });
            assert.deepEqual(ids(result), [text.id]);
            assert.equal(result.issues.length, 1);
            assert.equal(result.issues[0].scope, url);
            assert.ok(result.issues[0].message);
            assert.equal(result.calls.filter(c => c.url === url).length, 1);
        });
    }
});

test("REST thread entries validate IDs, type, guild, parent and archive route before becoming targets", async t => {
    const text = parent(2), other = parent(3), valid = thread(10, text);
    const url = `/channels/${text.id}/threads/archived/public`;
    for (const [name, invalid] of [
        ["null", null], ["array", []], ["missing ID", { ...valid, id: undefined }],
        ["numeric ID", { ...valid, id: 123 }], ["path ID", { ...valid, id: "../private" }],
        ["oversized ID", { ...valid, id: "99999999999999999999" }],
        ["non-thread type", { ...valid, type: 0 }], ["string type", { ...valid, type: "11" }],
        ["wrong guild", { ...valid, guild_id: id(99) }], ["missing parent", { ...valid, parent_id: undefined }],
        ["wrong parent", { ...valid, parent_id: other.id }], ["numeric parent", { ...valid, parent_id: 123 }],
        ["private in public route", { ...valid, type: 12 }], ["announcement in text parent", { ...valid, type: 10 }],
        ["thread is its own parent", { ...valid, id: text.id }], ["thread collides with another parent", { ...valid, id: other.id }]
    ]) await t.test(name, async () => {
        const result = await discover({ parents: [text, other], get: route => route === url ? page([invalid]) : page() });
        assert.deepEqual(ids(result), [text.id, other.id].sort());
        assert.equal(result.issues.length, 1);
        assert.equal(result.issues[0].scope, url);
    });
});

test("search and cached malformed threads are rejected while absent guild IDs are normalized", async t => {
    const text = parent(2), valid = thread(10, text);
    delete valid.guild_id;
    for (const source of ["search", "cache"]) await t.test(source, async () => {
        const values = [valid, { ...valid, id: "invalid" }, { ...valid, id: id(11), guild_id: id(99) }];
        const result = await discover({
            parents: [text], cachedThreads: source === "cache" ? values : [],
            get: url => source === "search" && url.endsWith("/threads/search") ? { threads: values, has_more: false } : page()
        });
        assert.deepEqual(ids(result), [text.id, valid.id].sort());
        assert.equal(result.channels.find(c => c.id === valid.id).guild_id, guildId);
        assert.ok(result.issues.length > 0);
    });
});

test("recoverable request failures expose scope/status only and continue other discovery routes", async t => {
    const text = parent(2), forum = parent(3, 15), archived = thread(10, forum);
    for (const endpoint of ["search", "public"]) for (const status of [403, 404, 500, 429, undefined]) {
        await t.test(`${endpoint} ${status ?? "network"}`, async () => {
            const url = endpoint === "search" ? `/channels/${text.id}/threads/search` : `/channels/${text.id}/threads/archived/public`;
            const error = { status, message: "private error body", body: { message: "private error body", code: 12345 } };
            const result = await discover({ parents: [text, forum], get: route => {
                if (route === url) throw error;
                return route === `/channels/${forum.id}/threads/archived/public` ? page([archived]) : page();
            } });
            assert.deepEqual(ids(result), [text.id, archived.id].sort());
            assert.equal(result.issues.length, 1);
            assert.equal(result.issues[0].scope, url);
            assert.equal(result.issues[0].status, status);
            assert.ok(!JSON.stringify(result.issues).includes("private error body"));
            assert.ok(!JSON.stringify(result.issues).includes("12345"));
            assert.equal(result.calls.filter(c => c.url === url).length, 1, "rate/429 retry belongs to the supplied get");
        });
    }
});

test("401 is rethrown immediately from search or archive discovery", async t => {
    const text = parent(2);
    for (const endpoint of ["search", "public", "private"]) for (const error of [{ status: 401 }, { statusCode: 401 }, { response: { status: 401 } }]) {
        await t.test(`${endpoint} ${Object.keys(error)[0]}`, async () => {
            const calls = [];
            const url = endpoint === "search" ? `/channels/${text.id}/threads/search`
                : endpoint === "public" ? `/channels/${text.id}/threads/archived/public`
                    : `/channels/${text.id}/users/@me/threads/archived/private`;
            await assert.rejects(discover({ parents: [text, parent(3, 15)], get: route => {
                calls.push(route);
                if (route === url) throw error;
                return page();
            } }), thrown => thrown === error);
            assert.equal(calls.at(-1), url);
        });
    }
});

test("VIEW_CHANNEL and READ_MESSAGE_HISTORY restrictions and blocklists apply to parents and children", async t => {
    for (const mode of ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY", "blocked"]) await t.test(mode, async () => {
        const allowed = parent(2), denied = parent(3, 15);
        const visible = thread(10, allowed), hidden = thread(11, allowed, 12), inherited = thread(12, denied);
        const rejected = new Set([denied.id, hidden.id]);
        const result = await discover({
            parents: [allowed, denied], cachedThreads: [visible, hidden, inherited],
            canRead: c => mode === "blocked" || !rejected.has(c.id),
            isBlocked: c => mode === "blocked" && rejected.has(c.id),
            get: url => url.endsWith("/threads/search") ? { threads: [visible, hidden, inherited], has_more: false } : page()
        });
        assert.deepEqual(ids(result), [allowed.id, visible.id].sort());
        assert.ok(result.calls.every(c => !c.url.includes(`/channels/${denied.id}/`)));
    });
});

test("stop, parent blocks and permission revocation during get discard stale targets and stop pagination", async t => {
    for (const endpoint of ["search", "public", "private"]) for (const cause of ["stop", "block", "permission"]) {
        await t.test(`${endpoint} ${cause}`, async () => {
            const text = parent(2), child = thread(10, text, endpoint === "private" ? 12 : 11);
            const url = endpoint === "search" ? `/channels/${text.id}/threads/search`
                : endpoint === "public" ? `/channels/${text.id}/threads/archived/public`
                    : `/channels/${text.id}/users/@me/threads/archived/private`;
            let changed = false;
            const result = await discover({
                parents: [text], cachedThreads: [child],
                isStopped: () => changed && cause === "stop",
                isBlocked: c => changed && cause === "block" && c.id === text.id,
                canRead: c => !(changed && cause === "permission" && c.id === text.id),
                get: route => {
                    if (route === url) { changed = true; return page([child], true); }
                    return page();
                }
            });
            assert.deepEqual(ids(result), [], "targets discovered before the await must also be rechecked");
            assert.equal(result.calls.at(-1).url, url);
            assert.ok(result.issues.some(i => i.scope === url), "an interrupted request is not completed discovery");
        });
    }
});

test("a stopped or wholly excluded discovery performs no requests", async t => {
    const text = parent(2);
    for (const guard of [{ isStopped: () => true }, { canRead: () => false }, { isBlocked: () => true }]) await t.test(Object.keys(guard)[0], async () => {
        const result = await discover({ parents: [text], cachedThreads: [thread(10, text)], ...guard });
        assert.deepEqual(ids(result), []);
        assert.equal(result.calls.length, 0);
    });
});

test("private route permissions are evaluated after public discovery and around every private request", async t => {
    const text = parent(2), publicUrl = `/channels/${text.id}/threads/archived/public`;
    const managedUrl = `/channels/${text.id}/threads/archived/private`;
    const joinedUrl = `/channels/${text.id}/users/@me/threads/archived/private`;
    for (const initial of [true, false]) await t.test(`manage changes from ${initial} during public request`, async () => {
        let manage = initial;
        const result = await discover({ parents: [text], canManage: () => manage, get: url => {
            if (url === publicUrl) manage = !initial;
            return page();
        } });
        assert.deepEqual(result.calls.filter(c => c.url.endsWith("/private")).map(c => c.url), [initial ? joinedUrl : managedUrl]);
    });
    await t.test("manage revoked during managed archive request", async () => {
        let manage = true;
        const privateThread = thread(10, text, 12);
        const result = await discover({ parents: [text], canManage: () => manage, get: url => {
            if (url === managedUrl) { manage = false; return page([privateThread], true); }
            return page();
        } });
        assert.deepEqual(ids(result), [text.id]);
        assert.equal(result.calls.filter(c => c.url === managedUrl).length, 1);
        assert.ok(result.issues.some(i => i.scope === managedUrl));
    });
});

test("invalid guild and parent identities never become request paths", async t => {
    await t.test("invalid guild", async () => {
        const result = await discover({ guildId: "../guilds", parents: [parent(2)] });
        assert.equal(result.calls.length, 0);
        assert.deepEqual(ids(result), []);
        assert.ok(result.issues.length);
    });
    for (const invalid of [null, { ...parent(2), id: "../channels" }, { ...parent(2), guild_id: id(99) }]) await t.test("invalid parent", async () => {
        const result = await discover({ parents: [invalid] });
        assert.equal(result.calls.length, 0);
        assert.deepEqual(ids(result), []);
        assert.ok(result.issues.length);
    });
});

test("fully blocked archive pages still advance; has_more=false stops even a full page", async t => {
    for (const kind of ["public", "private", "joined"]) await t.test(kind, async () => {
        const text = parent(2), blocked = thread(10, text, kind === "public" ? 11 : 12);
        const url = `/channels/${text.id}/${kind === "joined" ? "users/@me/" : ""}threads/archived/${kind === "public" ? "public" : "private"}`;
        const fullPage = Array.from({ length: 100 }, (_, i) => thread(100 + i, text, blocked.type));
        let requests = 0;
        const result = await discover({ parents: [text], canManage: () => kind === "private", isBlocked: c => c.id === blocked.id, get: route => {
            if (route !== url) return page();
            if (++requests > 2) throw Error("unexpected page after has_more=false");
            return requests === 1 ? page([blocked], true) : page(fullPage, false);
        } });
        assert.deepEqual(ids(result), [text.id, ...fullPage.map(c => c.id)].sort());
        assert.equal(requests, 2);
        assert.equal(result.calls.filter(c => c.url === url)[1].query.before, kind === "joined" ? blocked.id : blocked.thread_metadata.archive_timestamp);
        assert.deepEqual(plain(result.issues), []);
    });
});

test("joined cursor repetition and cycles terminate without leaking malformed IDs to queries", async t => {
    const text = parent(2), url = `/channels/${text.id}/users/@me/threads/archived/private`;
    const a = thread(10, text, 12), b = thread(11, text, 12);
    for (const [name, values, expected] of [["repeat", [a, a], 2], ["cycle", [a, b, a], 3], ["invalid", [{ ...a, id: "../invalid" }], 1]]) {
        await t.test(name, async () => {
            let requests = 0;
            const result = await discover({ parents: [text], get: route => {
                if (route !== url) return page();
                const value = values[requests++];
                return value ? page([value], true) : page();
            } });
            assert.equal(requests, expected);
            assert.ok(result.issues.some(i => i.scope === url));
            assert.ok(result.calls.every(c => !String(c.query.before).includes("invalid")));
        });
    }
});

test("individually blocked or unreadable threads are removed after a later request", async t => {
    for (const deniedBy of ["block", "permission"]) await t.test(deniedBy, async () => {
        const text = parent(2), child = thread(10, text, 12);
        let denied = false;
        const result = await discover({
            parents: [text], cachedThreads: [child],
            canRead: c => !(denied && deniedBy === "permission" && c.id === child.id),
            isBlocked: c => denied && deniedBy === "block" && c.id === child.id,
            get: () => { denied = true; return page(); }
        });
        assert.deepEqual(ids(result), [text.id]);
    });
});

test("stopping during an empty page does not report successful empty discovery", async () => {
    const forum = parent(2, 15);
    let stopped = false;
    const result = await discover({ parents: [forum], isStopped: () => stopped, get: () => {
        stopped = true;
        return page();
    } });
    assert.deepEqual(ids(result), []);
    assert.equal(result.calls.length, 1);
    assert.ok(result.issues.length);
});

test("conflicting duplicate identities cannot move a cached thread into another parent", async () => {
    const text = parent(2), forum = parent(3, 15), cached = thread(10, text);
    const result = await discover({
        parents: [text, forum], cachedThreads: [cached],
        get: url => url.endsWith("/threads/search") ? { threads: [{ ...cached, parent_id: forum.id }], has_more: false } : page()
    });
    assert.equal(result.channels.find(c => c.id === cached.id).parent_id, text.id);
    assert.ok(result.issues.some(i => i.scope === `/channels/${text.id}/threads/search`));
});

test("search entries for other parents cannot inject, query or join outside parents", async () => {
    const text = parent(2), outside = parent(3);
    const result = await discover({ parents: [text], get: url => url.endsWith("/threads/search") ? { threads: [thread(10, outside)], has_more: false } : page() });
    assert.deepEqual(ids(result), [text.id]);
    assert.ok(result.calls.every(c => c.url.includes(text.id)));
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].scope, `/channels/${text.id}/threads/search`);
});
