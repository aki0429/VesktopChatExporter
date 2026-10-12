import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { loadPlugin, id, message } from "./harness.mjs";

// Inject only the missing DOM boundary into the existing real-plugin VM loader.
function fixture(options) {
    const history = [];
    const nodes = new Map();
    const document = {
        createElement() {
            const node = { style: {}, dataset: new Proxy({}, { set(target, key, value) { target[key] = String(value); return true; } }), setAttribute() {}, remove() { nodes.delete(this.id); } };
            Object.defineProperty(node, "textContent", { set(text) {
                this.text = text;
                history.push({ text, ...this.dataset });
            }, get() { return this.text; } });
            return node;
        },
        getElementById: key => nodes.get(key),
        body: { appendChild(node) { nodes.set(node.id, node); } }
    };
    const original = vm.runInNewContext;
    let app;
    try {
        vm.runInNewContext = (code, context, ...args) => original(code, { ...context, document }, ...args);
        app = loadPlugin(options);
    } finally { vm.runInNewContext = original; }
    return { ...app, history, panel: () => [...nodes.values()][0] };
}
const guild = { id: id(100), name: "SECRET-GUILD" };
const channels = [1, 2].map(n => ({ id: id(n), guild_id: guild.id, name: `SECRET-CHANNEL-${n}`, type: 0 }));
function options(extra = {}) {
    return { channels, guilds: [guild], rest: ({ url, query }) => ({ body: url.endsWith("/messages")
        ? url.includes(channels[0].id) ? query?.before ? [message(1)] : Array.from({ length: 100 }, (_, n) => message(200 - n)) : [message(300)]
        : { threads: [], has_more: false } }), ...extra };
}
function snapshot(app) { return { ...app.panel()?.dataset }; }
function cancel(app) {
    const children = [];
    app.plugin.contextMenus["guild-context"](children, { guild });
    children.find(item => item?.props?.id === "vc-cancel-guild-export").props.action();
}

test("manual acquisition progress stays at the top and uses top notifications", async () => {
    const app = fixture(options());
    await app.hooks.exportGuild(guild);
    assert.equal(app.panel().style.top, "16px", "progress belongs at the top, not the bottom");
    assert.ok(!app.panel().style.bottom);
    const notices = app.toasts.filter(([text]) => text.includes("取得"));
    assert.ok(notices.length > 0);
    assert.ok(notices.every(([, , options]) => options?.position === 0), "acquisition notices must explicitly use TOP");
    assert.ok(app.toasts.some(([text, , options]) => /保存.*102/.test(text) && options?.position === 0), "durably stored message count is visible at the top");
});

test("background acquisition emits top progress only for confirmed pages", async () => {
    const dm = { id: id(400), type: 1 };
    const app = fixture({ channels: [dm], rest: () => ({ body: [message(401)] }) });
    await app.hooks.crawlAllHistory();
    assert.ok(app.toasts.some(([text, , options]) => /自動履歴収集.*保存.*1.*メッセージ/.test(text) && options?.position === 0));
    const failed = fixture({ channels: [dm], rest: () => ({ body: [message(401)] }), native: { saveHistoryPage: async () => { throw new Error("disk unavailable"); } } });
    await failed.hooks.crawlAllHistory();
    assert.ok(!failed.toasts.some(([text]) => /自動履歴収集.*保存.*1.*メッセージ/.test(text)), "failed page cannot appear as saved progress");
});

test("discovery cancellation and startup storage failure are explicit terminal states", async () => {
    const stopped = fixture(options());
    const load = stopped.native.loadPendingExport;
    stopped.native.loadPendingExport = async (...args) => { cancel(stopped); return load(...args); };
    await stopped.hooks.exportGuild(guild);
    assert.equal(snapshot(stopped).phase, "cancelled");
    const failed = fixture(options({ native: { loadPendingExport: async () => { throw new Error("disk unavailable"); } } }));
    await failed.hooks.exportGuild(guild);
    assert.equal(snapshot(failed).phase, "failed");
    assert.equal(snapshot(failed).percent, "0");
});

for (const boundary of ["appendExport", "publishExport"]) {
    test(`failure during ${boundary} never reports completion or advances failed page`, async () => {
        const app = fixture(options());
        const original = app.native[boundary];
        app.native[boundary] = async (...args) => {
            if (boundary === "publishExport" || args[2].txt?.includes("fixture message")) throw new Error("storage failure");
            return original(...args);
        };
        await app.hooks.exportGuild(guild);
        assert.equal(snapshot(app).phase, "failed");
        assert.notEqual(snapshot(app).percent, "100");
        if (boundary === "appendExport") assert.equal(snapshot(app).processedPages, "0");
    });
}

test("permission rebuild resets actual page counts and excludes revoked pages", async () => {
    let allowed = true;
    const app = fixture(options({ can: (_bit, channel) => channel.id !== channels[1].id || allowed }));
    const starts = [];
    const start = app.native.startExportFiles;
    app.native.startExportFiles = async (...args) => { starts.push(snapshot(app)); return start(...args); };
    const publish = app.native.publishExport;
    app.native.publishExport = async (...args) => { const result = await publish(...args); allowed = false; return result; };
    await app.hooks.exportGuild(guild);
    assert.deepEqual(starts.map(state => [state.processedPages, state.totalPages]), [["0", "3"], ["0", "2"]]);
    assert.equal(snapshot(app).phase, "incomplete");
    assert.equal(snapshot(app).processedPages, "2");
    assert.equal(snapshot(app).totalPages, "2");
    assert.equal(snapshot(app).fetchedMessages, "101");
    assert.ok(!app.history.some(state => state.percent === "100"));
});

test("cancellation during publication retries assembly without false completion", async () => {
    const app = fixture(options());
    let once = false;
    const publish = app.native.publishExport;
    app.native.publishExport = async (...args) => {
        const result = await publish(...args);
        if (!once) { once = true; cancel(app); }
        return result;
    };
    await app.hooks.exportGuild(guild);
    assert.equal(snapshot(app).phase, "cancelled");
    assert.ok(!app.history.some(state => state.percent === "100"));
    assert.equal(app.history.filter(state => state.phase === "assembling" && state.processedPages === "0").length, 2);
});

test("DOM-less existing harness continues exporting", async () => {
    const app = loadPlugin(options());
    await app.hooks.exportGuild(guild);
    assert.ok(app.toasts.some(([, type]) => type === "success"));
});

test("persistent counts-only DOM progress uses actual successful pages and waits for publication", async () => {
    const app = fixture(options());
    const beforeAppend = [], beforeRead = [];
    let beforePublish;
    const append = app.native.appendExport;
    app.native.appendExport = async (...args) => {
        if (args[2].txt?.includes("fixture message")) beforeAppend.push(snapshot(app));
        return append(...args);
    };
    const read = app.native.readHistoryPage;
    app.native.readHistoryPage = async (...args) => { beforeRead.push(snapshot(app)); return read(...args); };
    const publish = app.native.publishExport;
    app.native.publishExport = async (...args) => { beforePublish = snapshot(app); return publish(...args); };
    await app.hooks.exportGuild(guild);
    assert.ok(app.panel(), "export status panel remains after completion");
    assert.deepEqual(beforeAppend.map(p => p.processedPages), ["0", "1", "2"]);
    assert.deepEqual(beforeRead.map(p => p.percent), ["0", "33", "66"]);
    assert.equal(beforePublish.phase, "publishing");
    assert.equal(beforePublish.totalPages, "3");
    assert.equal(beforePublish.processedPages, "3");
    assert.equal(beforePublish.percent, "99", "assembly is not publication completion");
    assert.equal(beforePublish.completedChannels, "2");
    assert.equal(beforePublish.totalChannels, "2");
    assert.equal(beforePublish.fetchedMessages, "102");
    assert.equal(snapshot(app).phase, "complete");
    assert.equal(snapshot(app).percent, "100");
    assert.match(app.panel().textContent, /取得.*2\/2.*102.*組み立て.*3\/3.*100%/s);
    for (const state of app.history) {
        assert.ok(!state.text.includes("SECRET"));
        assert.ok(!state.text.includes("fixture message"));
        assert.ok(!state.text.includes(id(1)));
    }
});
