import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import path from "node:path";
import { buildSync } from "esbuild";
import * as fs from "node:fs/promises";
import { loadPlugin, id, message } from "./harness.mjs";
const require = createRequire(import.meta.url);
const source = path.resolve("src/plugins/vesktopChatExporter/native.ts");

async function fixture(overrides = {}) {
    const dir = await fs.mkdtemp(path.join(process.env.TMPDIR, "vesktop-disk-failure-"));
    const code = buildSync({ entryPoints: [source], bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"] }).outputFiles[0].text;
    const context = { module: { exports: {} }, require: name => name === "electron"
        ? { app: { getPath: () => dir }, shell: { openPath: async () => "" } }
        : name === "fs/promises" ? { ...require(name), ...overrides } : require(name) };
    vm.runInNewContext(code, context);
    const native = Object.fromEntries(Object.entries(context.module.exports).map(([name, fn]) => [name, (...args) => fn(null, ...args)]));
    return { dir, native };
}

for (const failure of ["list EACCES", "HTML append EIO"]) {
    test(`${failure} never publishes torn TXT/HTML and keeps recoverable pages plus a failed manifest`, async () => {
        const disk = await fixture(failure === "list EACCES" ? { readdir: async (...args) => {
            if (String(args[0]).includes(".parts")) throw Object.assign(new Error("fixture"), { code: "EACCES" });
            return fs.readdir(...args);
        } } : { appendFile: async (file, ...args) => {
            if (String(file).endsWith(".html.partial")) throw Object.assign(new Error("fixture"), { code: "EIO" });
            return fs.appendFile(file, ...args);
        } });
        try {
            const dm = { id: id(1), type: 3, name: "Fixture" };
            const app = loadPlugin({ channels: [dm], native: disk.native, rest: () => ({ body: [message(20)] }) });
            await app.hooks.exportDm(dm);
            const root = path.join(disk.dir, "VesktopChatLogs", "DMs");
            const files = await fs.readdir(root);
            assert.ok(!files.some(file => /\.(?:txt|html)(?:\.partial)?$/.test(file)), "do not publish partial or mismatched aggregate");
            const record = JSON.parse(await fs.readFile(path.join(root, files.find(file => file.endsWith(".manifest.json"))), "utf8"));
            assert.equal(record.outcome, "failed");
            assert.equal(record.progress[0].messages, 1);
            const partDir = files.find(file => file.endsWith(".parts"));
            assert.equal((await fs.readdir(path.join(root, partDir, dm.id))).length, 1);
            assert.ok(!app.toasts.some(t => t[1] === "success"));
        } finally { await fs.rm(disk.dir, { recursive: true, force: true }); }
    });
}

test("real native resume survives a fresh plugin instance and a group DM rename", async () => {
    const disk = await fixture();
    try {
        const channel = { id: id(1), type: 3, name: "Before" };
        const base = 400000000000000000n;
        const requests = [];
        const rest = ({ query }) => {
            const before = query.before ? Number(BigInt(query.before) - base) : 251;
            requests.push(query.before ?? null);
            const end = Math.min(250, before - 1), start = Math.max(1, end - 99);
            return { body: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => ({ ...message(end - i), id: String(base + BigInt(end - i)) })) };
        };
        const first = loadPlugin({ channels: [channel], native: disk.native, rest });
        const write = disk.native.writeHistoryPageJson;
        let once = true;
        first.native.writeHistoryPageJson = async (...args) => {
            const out = await write(...args);
            if (once) { once = false; first.plugin.stop(); }
            return out;
        };
        await first.hooks.exportDm(channel);
        first.native.writeHistoryPageJson = write;
        channel.name = "After";
        const second = loadPlugin({ channels: [channel], native: disk.native, rest });
        await second.hooks.exportDm(channel);
        assert.deepEqual(requests, [null, String(base + 151n), String(base + 51n)]);
        const root = path.join(disk.dir, "VesktopChatLogs", "DMs");
        const files = await fs.readdir(root);
        assert.equal(files.filter(file => file.endsWith(".manifest.json")).length, 1);
        const summary = JSON.parse(await fs.readFile(path.join(root, files.find(file => file.endsWith(".manifest.json"))), "utf8"));
        assert.equal(summary.outcome, "complete");
        assert.equal(summary.messages, 250);
        assert.ok(second.toasts.some(t => t[1] === "success"));
    } finally { await fs.rm(disk.dir, { recursive: true, force: true }); }
});

test("purging a revoked channel deletes orphan pages from a crash before its checkpoint", async () => {
    const disk = await fixture();
    try {
        const run = "fixture-orphan";
        const channel = id(1);
        const entry = { guildId: id(100), guildName: "fixture", channelId: channel, channelName: "private",
            messageId: id(20), timestamp: "2026-01-01T00:00:00.000Z", author: "fixture", authorId: id(999), content: "fixture", attachments: [] };
        await disk.native.writeHistoryPageJson(undefined, run, channel, "private", [entry]);
        assert.equal(typeof disk.native.purgeChannelPages, "function", "revocation must purge untracked crash parts too");
        await disk.native.purgeChannelPages(undefined, run, channel);
        assert.deepEqual(await fs.readdir(path.join(disk.dir, "VesktopChatLogs", `${run}.parts`)), []);
    } finally { await fs.rm(disk.dir, { recursive: true, force: true }); }
});

test("partial page write plus permission revocation removes untracked private data", async () => {
    let managed = true, injected = false;
    const disk = await fixture({ writeFile: async (file, data, ...args) => {
        if (!injected && String(file).replaceAll('\\', '/').includes(`/${id(2)}/`) && String(file).endsWith('.jsonl.tmp')) {
            injected = true;
            await fs.writeFile(file, String(data).slice(0, 200), ...args);
            managed = false;
            throw Object.assign(new Error('fixture ENOSPC'), { code: 'ENOSPC' });
        }
        return fs.writeFile(file, data, ...args);
    } });
    try {
        const guild = { id: id(100), name: 'fixture' };
        const parent = { id: id(1), guild_id: guild.id, name: 'parent', type: 0 };
        const thread = { id: id(2), guild_id: guild.id, parent_id: parent.id, name: 'PRIVATE-PARTIAL-FIXTURE', type: 12 };
        const app = loadPlugin({ channels: [parent, thread], guilds: [guild], native: disk.native,
            can: bit => bit !== 4n || managed,
            rest: ({ url }) => ({ body: url.endsWith('/messages') ? [message(20)] : { threads: [], has_more: false } }) });
        await app.hooks.exportGuild(guild);
        assert.ok(injected);
        const root = path.join(disk.dir, 'VesktopChatLogs');
        const files = await fs.readdir(root);
        const record = JSON.parse(await fs.readFile(path.join(root, files.find(file => file.endsWith('.manifest.json'))), 'utf8'));
        assert.equal(record.outcome, 'incomplete');
        assert.ok(!JSON.stringify(record).includes(thread.id));
        const parts = files.find(file => file.endsWith('.parts'));
        assert.ok(!(await fs.readdir(path.join(root, parts))).includes(thread.id));
    } finally { await fs.rm(disk.dir, { recursive: true, force: true }); }
});

test("a fresh instance retries orphaned revoked-page deletion after storage recovers", async () => {
    let managed = true, deny = true, purges = 0;
    const guild = { id: id(100), name: 'fixture' };
    const parent = { id: id(1), guild_id: guild.id, name: 'parent', type: 0 };
    const thread = { id: id(2), guild_id: guild.id, parent_id: parent.id, name: 'ORPHAN-PRIVATE-FIXTURE', type: 12 };
    const disk = await fixture({ rm: async (file, ...args) => {
        if (String(file).replaceAll('\\', '/').endsWith(`.parts/${thread.id}`)) {
            purges++;
            if (deny) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
        }
        return fs.rm(file, ...args);
    } });
    try {
        const options = { channels: [parent, thread], guilds: [guild], native: disk.native,
            can: bit => bit !== 4n || managed,
            rest: ({ url }) => ({ body: url.endsWith('/messages') ? [{ ...message(20), content: url.includes(thread.id) ? 'orphan-private-fixture' : 'public-fixture' }]
                : { threads: [], has_more: false } }) };
        const first = loadPlugin(options);
        const publish = first.native.publishExport;
        first.native.publishExport = async (...args) => { const out = await publish(...args); managed = false; return out; };
        await first.hooks.exportGuild(guild);
        const root = path.join(disk.dir, 'VesktopChatLogs');
        const files = await fs.readdir(root);
        const manifestPath = path.join(root, files.find(file => file.endsWith('.manifest.json')));
        const partsPath = path.join(root, files.find(file => file.endsWith('.parts')));
        const failed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        assert.equal(failed.outcome, 'failed');
        assert.ok(!JSON.stringify(failed).includes(thread.id));
        assert.ok((await fs.readdir(partsPath)).includes(thread.id), 'exercise genuine failed physical deletion');
        const prior = purges;
        deny = false;
        const second = loadPlugin(options);
        await second.hooks.exportGuild(guild);
        assert.ok(purges > prior, 'restart must recover deletion work no longer in progress');
        assert.ok(!(await fs.readdir(partsPath)).includes(thread.id));
        const finished = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        assert.notEqual(finished.outcome, 'failed');
        assert.ok(!JSON.stringify(finished).includes(thread.id));
    } finally { deny = false; await fs.rm(disk.dir, { recursive: true, force: true }); }
});
