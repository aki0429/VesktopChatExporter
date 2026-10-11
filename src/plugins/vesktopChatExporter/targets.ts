export type MessageTarget = { id: string; type: number; name?: string; guild_id?: string; parent_id?: string; };
export type DiscoveryIssue = { scope: string; status?: number; message: string; };

type DiscoveryOptions = {
    guildId: string;
    parents: MessageTarget[];
    cachedThreads: MessageTarget[];
    scanActive: (parent: MessageTarget) => boolean;
    canRead: (target: MessageTarget) => boolean;
    isBlocked: (target: MessageTarget) => boolean;
    canManage: (parent: MessageTarget) => boolean;
    get: (url: string, query?: Record<string, string | number | boolean>) => Promise<unknown>;
    isStopped: () => boolean;
};

type ThreadPage = { threads: unknown[]; has_more?: boolean; };

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
    return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}

function statusOf(error: unknown): number | undefined {
    if (!record(error)) return;
    const status = error.status ?? error.statusCode ?? (record(error.response) ? error.response.status : undefined);
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function archiveCursor(tail: unknown, joined: boolean): string | undefined {
    if (!record(tail)) return;
    if (joined) return isId(tail.id) ? tail.id : undefined;
    const value = record(tail.thread_metadata) ? tail.thread_metadata.archive_timestamp : undefined;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    return typeof value === "string" && iso.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalize(target: MessageTarget): MessageTarget {
    return {
        id: target.id, type: target.type,
        ...(target.name === undefined ? {} : { name: target.name }),
        ...(target.guild_id === undefined ? {} : { guild_id: target.guild_id }),
        ...(target.parent_id === undefined ? {} : { parent_id: target.parent_id })
    };
}

// Parents whose own messages get exported: text, voice, announcement and stage channels.
// Voice and stage channels carry a text chat, so "全チャンネルのログを保存" must include them.
const LEAF_TYPES = [0, 2, 5, 13];
// Only these parents support threads; voice/stage text has no thread list to enumerate.
const THREAD_PARENT_TYPES = [0, 5, 15, 16];

// get returns a response body and owns pacing/429 retries; no membership is changed here.
// canRead must check VIEW_CHANNEL/READ_MESSAGE_HISTORY without assuming Channel methods.
export async function discoverGuildTargets(options: DiscoveryOptions): Promise<{ channels: MessageTarget[]; issues: DiscoveryIssue[]; }> {
    const { parents, cachedThreads, canRead, isBlocked, isStopped } = options;
    const targets = new Map<string, MessageTarget>();
    const issues: DiscoveryIssue[] = [];
    if (!isId(options.guildId)) return { channels: [], issues: [{ scope: "guild", message: "Invalid guild ID" }] };
    const parentMap = new Map<string, MessageTarget>();
    for (const parent of parents) {
        if (!record(parent) || !isId(parent.id) || (parent.guild_id !== undefined && parent.guild_id !== options.guildId)) {
            issues.push({ scope: `/guilds/${options.guildId}/channels`, message: "Invalid parent channel" });
        } else if ([...LEAF_TYPES, 15, 16].includes(parent.type)) {
            parentMap.set(parent.id, parent);
        }
    }
    const readPage = (body: unknown, scope: string, archived: boolean): ThreadPage | undefined => {
        if (!record(body) || !Array.isArray(body.threads) || (archived && typeof body.has_more !== "boolean")) {
            issues.push({ scope, message: "Invalid thread response" });
            return;
        }
        return body as ThreadPage;
    };
    const request = async (url: string, permitted: () => boolean, query?: Record<string, string | number | boolean>) => {
        const check = () => {
            if (permitted()) return true;
            issues.push({ scope: url, message: "Thread discovery interrupted" });
            return false;
        };
        if (!check()) return;
        try {
            const body = await options.get(url, query);
            if (check()) return readPage(body, url, query !== undefined);
        } catch (error) {
            const status = statusOf(error);
            if (status === 401) throw error;
            issues.push({ scope: url, ...(status === undefined ? {} : { status }), message: "Thread discovery request failed" });
        }
    };
    const allowed = (target: MessageTarget) => !isStopped() && canRead(target) && !isBlocked(target);
    for (const parent of parentMap.values()) {
        if (LEAF_TYPES.includes(parent.type) && allowed(parent)) targets.set(parent.id, normalize(parent));
    }
    const addThreads = (threads: unknown[], scope: string, expectedParent?: MessageTarget, privateRoute?: boolean) => {
        let valid = true;
        const invalid = () => {
            valid = false;
            issues.push({ scope, message: "Invalid thread entry" });
        };
        for (const raw of threads) {
            if (!record(raw) || !isId(raw.id) || !isId(raw.parent_id) || parentMap.has(raw.id)
                || typeof raw.type !== "number" || ![10, 11, 12].includes(raw.type)
                || (raw.guild_id !== undefined && raw.guild_id !== options.guildId)
                || (expectedParent && raw.parent_id !== expectedParent.id)
                || (privateRoute !== undefined && (raw.type === 12) !== privateRoute)) {
                invalid();
                continue;
            }
            const parent = parentMap.get(raw.parent_id);
            if (!parent) continue; // Active responses can include parents outside this export's scope.
            const types = parent.type === 5 ? [10] : parent.type === 0 ? [11, 12] : [11];
            const previous = targets.get(raw.id);
            if (!types.includes(raw.type) || (previous && (previous.type !== raw.type || previous.parent_id !== raw.parent_id))) {
                invalid();
                continue;
            }
            const thread: MessageTarget = { id: raw.id, type: raw.type, parent_id: raw.parent_id, guild_id: options.guildId };
            if (typeof raw.name === "string") thread.name = raw.name;
            if (!allowed(parent) || isStopped() || isBlocked(thread)) continue;
            if (canRead(thread)) targets.set(thread.id, thread);
            else if (thread.type === 12) {
                issues.push({ scope, message: "Private thread access could not be verified (current membership or MANAGE_THREADS required)" });
            }
        }
        return valid;
    };
    addThreads(cachedThreads, `/guilds/${options.guildId}/threads/cache`);
    // The guild-level active-thread route is bot-only (HTTP 403/20002 for user accounts);
    // per-channel search is the user-account equivalent. Page it by offset and bound the
    // loop so one busy parent cannot stall a discovery cycle.
    const search = async (parent: MessageTarget) => {
        const url = `/channels/${parent.id}/threads/search`;
        let offset = 0;
        while (allowed(parent)) {
            const body = await request(url, () => allowed(parent), { limit: 25, archived: false, ...(offset ? { offset } : {}) });
            if (!body) break;
            if (!addThreads(body.threads, url, parent)) break;
            if (!body.has_more) break;
            if (!body.threads.length) {
                issues.push({ scope: url, message: "Active thread search did not advance" });
                break;
            }
            offset += body.threads.length;
            if (offset > 2500) {
                issues.push({ scope: url, message: "Active thread search limit reached" });
                break;
            }
        }
    };
    for (const parent of parentMap.values()) {
        if (THREAD_PARENT_TYPES.includes(parent.type) && options.scanActive(parent)) await search(parent);
    }
    const archive = async (parent: MessageTarget, kind: "public" | "private" | "joined") => {
        const url = `/channels/${parent.id}/${kind === "joined" ? "users/@me/" : ""}threads/archived/${kind === "public" ? "public" : "private"}`;
        const permitted = () => allowed(parent) && (kind !== "private" || options.canManage(parent));
        let before: string | undefined;
        const cursors = new Set<string>();
        while (allowed(parent)) {
            const body = await request(url, permitted, { limit: 100, ...(before ? { before } : {}) });
            if (!body) break;
            if (!addThreads(body.threads, url, parent, kind !== "public")) break;
            if (!body.has_more) break;
            // The cursor belongs to the raw page, never the permission/block-filtered targets.
            before = archiveCursor(body.threads[body.threads.length - 1], kind === "joined");
            if (!before) {
                issues.push({ scope: url, message: "Missing or invalid archive cursor" });
                break;
            }
            if (cursors.has(before)) {
                issues.push({ scope: url, message: "Repeated archive cursor" });
                break;
            }
            cursors.add(before);
        }
    };
    for (const parent of parentMap.values()) {
        if (!THREAD_PARENT_TYPES.includes(parent.type) || !allowed(parent)) continue;
        await archive(parent, "public");
        if (parent.type === 0 && allowed(parent)) await archive(parent, options.canManage(parent) ? "private" : "joined");
    }
    const channels = [...targets.values()].filter(target => {
        const thread = [10, 11, 12].includes(target.type);
        const parent = parentMap.get(thread ? target.parent_id! : target.id);
        return parent && allowed(parent) && (!thread || allowed(target));
    });
    return { channels, issues };
}
