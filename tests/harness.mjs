import { buildSync } from "esbuild";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
const filename = path.join(root, "src/plugins/vesktopChatExporter/index.tsx");

// Run the real plugin, substituting only Discord/Electron boundaries.
export function loadPlugin({ channels = [], guilds = [], users = [], privateChannels, groups, can, hasJoined = () => false, rest, native, settings: overrides = {} } = {}) {
    const channelMap = Object.fromEntries(channels.map(c => [c.id, c]));
    const guildMap = Object.fromEntries(guilds.map(g => [g.id, g]));
    const userMap = Object.fromEntries(users.map(u => [u.id, u]));
    const requests = [], saved = [], toasts = [], errors = [], waits = [], timers = [];
    const store = {
        getChannel: id => channelMap[id],
        getSortedPrivateChannels: () => privateChannels ?? channels.filter(c => [1, 3].includes(c.type)),
        getMutablePrivateChannels: () => Object.fromEntries(channels.filter(c => [1, 3].includes(c.type)).map(c => [c.id, c])),
        getDMFromUserId: id => channels.find(c => c.type === 1 && c.recipients?.includes(id))?.id,
        getAllThreadsForGuild: id => channels.filter(c => c.guild_id === id && [10, 11, 12].includes(c.type))
    };
    const common = {
        Constants: { Endpoints: { MESSAGES: id => `/channels/${id}/messages` } },
        Forms: {}, Menu: { MenuItem: "item", MenuSeparator: "separator" },
        ChannelStore: store, UserStore: { getUser: id => userMap[id] },
        GuildStore: { getGuilds: () => guildMap, getGuild: id => guildMap[id] },
        GuildChannelStore: { getChannels: id => groups ?? { SELECTABLE: channels.filter(c => c.guild_id === id && ![10, 11, 12].includes(c.type)).map(channel => ({ channel })) } },
        JoinedThreadsStore: hasJoined === null ? undefined : { hasJoined },
        PermissionStore: { can: can ?? (() => true) },
        PermissionsBits: { VIEW_CHANNEL: 1n, READ_MESSAGE_HISTORY: 2n, MANAGE_THREADS: 4n },
        SelectedChannelStore: { getChannelId: () => undefined },
        SelectedGuildStore: { getGuildId: () => undefined },
        RestAPI: { get: async options => { requests.push(options); return rest ? rest(options) : { body: [] }; } },
        FluxDispatcher: { subscribe() {}, unsubscribe() {} },
        showToast: (...args) => toasts.push(args), Toasts: { Type: { MESSAGE: "message", SUCCESS: "success", FAILURE: "failure" }, Position: { TOP: 0, BOTTOM: 1 } }
    };
    // An in-memory disk: helpers write into it exactly like the native side does on real files, so
    // tests can read back what a run actually stored instead of one final buffered value.
    const files = new Map();
    const pages = new Map();
    const dirOf = category => `fixture/${category ?? "logs"}`;
    // Mirrors native.ts: a channel folder name is sanitised before it becomes a path segment.
    const safeName = value => String(value ?? "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "server";
    const partsDir = (category, baseName, channelId, channelName) => `${dirOf(category)}/${safeName(baseName)}.parts/${channelId}`;
    const pageStore = (category, baseName, channelId) => {
        const key = `${category ?? ""}|${baseName}|${channelId}`;
        if (!pages.has(key)) pages.set(key, new Map());
        return pages.get(key);
    };
    const append = (file, text) => { files.set(file, (files.get(file) ?? "") + text); };
    const byId = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    const helpers = {
        loadCrawlState: async () => ({}), saveCrawlState: async () => {},
        checkpointExport: async (category, baseName, record) => {
            files.set(`${dirOf(category)}/${baseName}.manifest.json`, record);
        },
        loadPendingExport: async (category, targetId) => {
            const candidates = [...files].filter(([file]) => file.startsWith(`${dirOf(category)}/`) && file.endsWith(".manifest.json"))
                .map(([file, record]) => ({ base: file.slice(`${dirOf(category)}/`.length, -".manifest.json".length), manifest: JSON.parse(record) }))
                .filter(({ manifest }) => manifest.version === 2 && manifest.targetId === targetId && manifest.outcome !== "complete" && Array.isArray(manifest.progress));
            return candidates.at(-1) ?? null;
        },
        abortExportFiles: async (category, baseName) => {
            for (const ext of [".txt", ".html", ".txt.partial", ".html.partial", ".summary.pending.json"])
                files.delete(`${dirOf(category)}/${baseName}${ext}`);
        },
        saveLogs: async (...args) => { saved.push({ kind: "export", args }); return { directory: "fixture" }; },
        appendLiveMessage: async (...args) => { saved.push({ kind: "live", args }); },
        // The background crawler stores one finished page per call, like the native side.
        saveHistoryPage: async (category, guildId, guildName, channelId, channelName, messages) => {
            saved.push({ kind: "history", channelId, args: [category, guildId, guildName, channelId, channelName, messages] });
            const base = `${messages[0].messageId}_${messages[messages.length - 1].messageId}`;
            pageStore(category, guildId, channelId).set(base, messages);
            return { directory: dirOf(category), count: messages.length };
        },
        // The run stub is opened before the first request; the aggregate files are opened only after
        // the phase-2 re-check, so their header can be built from the surviving channels.
        beginExport: async (category, baseName, manifest) => {
            files.set(`${dirOf(category)}/${baseName}.manifest.json`, manifest);
            saved.push({ kind: "export-begin", args: [category, baseName, manifest] });
            return {
                directory: dirOf(category), base: baseName,
                txtPath: `${dirOf(category)}/${baseName}.txt`,
                htmlPath: `${dirOf(category)}/${baseName}.html`,
                manifestPath: `${dirOf(category)}/${baseName}.manifest.json`
            };
        },
        startExportFiles: async (category, baseName, txtHeader, htmlHeader) => {
            saved.push({ kind: "export-files", args: [category, baseName, txtHeader, htmlHeader] });
            await helpers.abortExportFiles(category, baseName);
            files.set(`${dirOf(category)}/${baseName}.txt.partial`, txtHeader);
            files.set(`${dirOf(category)}/${baseName}.html.partial`, htmlHeader);
            return {
                directory: dirOf(category), base: baseName,
                txtPath: `${dirOf(category)}/${baseName}.txt`,
                htmlPath: `${dirOf(category)}/${baseName}.html`,
                manifestPath: `${dirOf(category)}/${baseName}.manifest.json`
            };
        },
        appendExport: async (category, baseName, fragment) => {
            saved.push({ kind: "export", args: [category, baseName, fragment] });
            if (fragment.txt) append(`${dirOf(category)}/${baseName}.txt.partial`, fragment.txt);
            if (fragment.html) append(`${dirOf(category)}/${baseName}.html.partial`, fragment.html);
            return { written: (fragment.txt ? 1 : 0) + (fragment.html ? 1 : 0) };
        },
        finishExport: async (category, baseName, summary, txtFooter, htmlFooter) => {
            saved.push({ kind: "export-finish", args: [category, baseName, txtFooter, htmlFooter] });
            append(`${dirOf(category)}/${baseName}.txt.partial`, txtFooter);
            append(`${dirOf(category)}/${baseName}.html.partial`, htmlFooter);
            const manifestPath = `${dirOf(category)}/${baseName}.manifest.json`;
            const started = JSON.parse(files.get(manifestPath));
            files.set(`${dirOf(category)}/${baseName}.summary.pending.json`, JSON.stringify({ ...started, ...JSON.parse(summary) }));
            return { directory: dirOf(category), bytes: { txt: 1, html: 1, manifest: 1 } };
        },
        publishExport: async (category, baseName) => {
            for (const ext of [".txt", ".html"]) {
                const file = `${dirOf(category)}/${baseName}${ext}`;
                files.set(file, files.get(`${file}.partial`));
                files.delete(`${file}.partial`);
            }
            const pending = `${dirOf(category)}/${baseName}.summary.pending.json`;
            files.set(`${dirOf(category)}/${baseName}.manifest.json`, files.get(pending));
            files.delete(pending);
            return { directory: dirOf(category) };
        },
        discardExport: async (category, baseName) => {
            saved.push({ kind: "export-discard", args: [category, baseName] });
            await helpers.abortExportFiles(category, baseName);
            for (const name of [`${baseName}.txt`, `${baseName}.html`, `${baseName}.manifest.json`])
                files.delete(`${dirOf(category)}/${name}`);
            // Like the native side, a discarded run takes this run's per-page parts with it.
            for (const file of [...files.keys()])
                if (file.startsWith(`${dirOf(category)}/${safeName(baseName)}.parts/`)) files.delete(file);
            for (const key of [...pages.keys()])
                if (key.startsWith(`${category ?? ""}|${baseName}|`)) pages.delete(key);
            return { removed: 3 };
        },
        // Per-page JSON: stored the moment a page arrives, read back to assemble the aggregate.
        writeHistoryPageJson: async (category, baseName, channelId, channelName, messages) => {
            if (!/^\d{17,20}$/.test(channelId) || !messages.length) return null;
            const ordered = [...messages].sort((left, right) => byId(left.messageId, right.messageId));
            const base = `${ordered[0].messageId}_${ordered[ordered.length - 1].messageId}`;
            pageStore(category, baseName, channelId).set(base, ordered);
            saved.push({ kind: "history", channelId, args: [category, baseName, channelId, channelName, messages] });
            const file = `${partsDir(category, baseName, channelId, channelName)}/${base}.jsonl`;
            files.set(file, `${ordered.map(message => JSON.stringify(message)).join("\n")}\n`);
            return { base, path: file, count: ordered.length };
        },
        listHistoryPages: async (category, baseName, channelId, channelName) =>
            !/^\d{17,20}$/.test(channelId) ? []
                : [...pageStore(category, baseName, channelId).keys()].sort((left, right) => byId(left.split("_")[0], right.split("_")[0])),
        readHistoryPage: async (category, baseName, channelId, channelName, base) =>
            !/^\d{17,20}$/.test(channelId) || !/^\d{17,20}_\d{17,20}$/.test(base) ? []
                : pageStore(category, baseName, channelId).get(base) ?? [],
        discardHistoryPages: async (category, baseName, channelId, channelName, bases) => {
            saved.push({ kind: "history-discard", channelId, args: [category, baseName, channelId, channelName, bases] });
            if (!/^\d{17,20}$/.test(channelId)) return { removed: 0 };
            const store = pageStore(category, baseName, channelId);
            for (const base of bases) {
                store.delete(base);
                files.delete(`${partsDir(category, baseName, channelId, channelName)}/${base}.jsonl`);
            }
            return { removed: bases.length };
        },
        listExportChannelIds: async (category, baseName) => [...pages.keys()]
            .filter(key => key.startsWith(`${category ?? ""}|${baseName}|`)).map(key => key.split('|').at(-1)),
        purgeChannelPages: async (category, baseName, channelId) => {
            saved.push({ kind: "history-discard", operation: "purge", channelId, args: [category, baseName, channelId] });
            pages.delete(`${category ?? ""}|${baseName}|${channelId}`);
            const prefix = `${partsDir(category, baseName, channelId, "")}/`;
            for (const file of [...files.keys()]) if (file.startsWith(prefix)) files.delete(file);
        },
        openLogFolder: async () => "fixture", ...native
    };
    const imports = {
        "@utils/types": { __esModule: true, default: p => p, OptionType: {} },
        "@api/Settings": { definePluginSettings: schema => {
            const settings = { store: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.default])) };
            Object.assign(settings.store, overrides);
            settings.use = () => settings.store;
            return settings;
        } },
        "@webpack/common": common
    };
    const code = buildSync({
        stdin: { contents: readFileSync(filename, "utf8") + "\nexport const testHooks = { getDmChannels, channelLabel, buildActiveScan, buildContainers, crawlAllHistory, exportGuild, exportDm, saveLiveMessage, retryAfterMs, getGuildParents, nextDelay, baseDelay, DELAY_FLOOR, DELAY_CEILING };", loader: "tsx", resolveDir: path.dirname(filename) },
        bundle: true, write: false, platform: "node", format: "cjs", external: ["@api/*", "@utils/*", "@webpack/*", "@vencord/*"],
        jsxFactory: "React.createElement"
    }).outputFiles[0].text;
    const context = {
        module: { exports: {} }, require: name => {
            if (!(name in imports)) throw Error(`Unstubbed import: ${name}`);
            return imports[name];
        },
        React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
        VencordNative: { pluginHelpers: { VesktopChatExporter: helpers } },
        console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
        // Waits are deterministic; do not launch the recurring five-minute crawl.
        setTimeout: (fn, ms) => {
            waits.push(ms);
            const timer = { fn, ms, cleared: false };
            timers.push(timer);
            if (fn.name !== "crawlAllHistory") queueMicrotask(fn);
            return timer;
        }, clearTimeout(timer) { if (timer) timer.cleared = true; },
    };
    vm.runInNewContext(code, context, { filename });
    return { plugin: context.module.exports.default, hooks: context.module.exports.testHooks, requests, saved, toasts, errors, waits, timers, store, channelMap, files, pages, native: helpers };
}

export const id = n => `100000000000000${String(n).padStart(3, "0")}`;
export const message = n => ({ id: id(n), content: `fixture message ${n}`, timestamp: "2026-01-01T00:00:00.000Z", author: { id: id(999), username: "fixture" } });
export const items = children => children.filter(x => x?.type === "item");

// Streaming export helpers: a run writes into its own files, so tests read what it really stored
// (and in which order) instead of a single buffered save.
export const exportFiles = app => app.files;
export const exportWrites = app => app.saved.filter(s => s.kind === "export");
export const exportStarted = app => app.saved.some(s => s.kind === "export-begin");
export const exportFilesOpened = app => app.saved.some(s => s.kind === "export-files");
export const exportFinished = app => app.saved.some(s => s.kind === "export-finish");
export const exportDiscarded = app => app.saved.some(s => s.kind === "export-discard");
const exportFile = (app, extension) => [...app.files].filter(([file]) => file.endsWith(extension)).map(([, text]) => text).join("\n");
export const exportText = app => exportFile(app, ".txt");
export const exportHtml = app => exportFile(app, ".html");
export const exportJson = app => exportFile(app, ".jsonl");
export const exportManifest = app => exportFile(app, ".manifest.json");
