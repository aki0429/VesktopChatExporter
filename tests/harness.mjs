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
    const requests = [], saved = [], toasts = [], errors = [], waits = [];
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
        showToast: (...args) => toasts.push(args), Toasts: { Type: { MESSAGE: "message", SUCCESS: "success", FAILURE: "failure" } }
    };
    const helpers = {
        loadCrawlState: async () => ({}), saveCrawlState: async () => {},
        saveLogs: async (...args) => { saved.push({ kind: "export", args }); return { directory: "fixture" }; },
        appendLiveMessage: async (...args) => { saved.push({ kind: "live", args }); },
        saveHistoryPage: async (...args) => { saved.push({ kind: "history", args }); },
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
        stdin: { contents: readFileSync(filename, "utf8") + "\nexport const testHooks = { getDmChannels, channelLabel, buildActiveScan, buildContainers, crawlAllHistory, exportGuild, exportDm, saveLiveMessage, retryAfterMs };", loader: "tsx", resolveDir: path.dirname(filename) },
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
        setTimeout: (fn, ms) => { waits.push(ms); if (fn.name !== "crawlAllHistory") queueMicrotask(fn); return 1; }, clearTimeout() {},
    };
    vm.runInNewContext(code, context, { filename });
    return { plugin: context.module.exports.default, hooks: context.module.exports.testHooks, requests, saved, toasts, errors, waits, store, channelMap };
}

export const id = n => `100000000000000${String(n).padStart(3, "0")}`;
export const message = n => ({ id: id(n), content: `fixture message ${n}`, timestamp: "2026-01-01T00:00:00.000Z", author: { id: id(999), username: "fixture" } });
export const items = children => children.filter(x => x?.type === "item");
