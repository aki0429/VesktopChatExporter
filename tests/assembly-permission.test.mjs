import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message, exportHtml, exportJson, exportManifest, exportText } from "./harness.mjs";

const guild = { id: id(100), name: "Assembly fixture" };
const parent = { id: id(1), guild_id: guild.id, name: "parent", type: 0 };
const thread = { id: id(2), guild_id: guild.id, parent_id: parent.id, name: "private fixture", type: 12 };
const secret = "PRIVATE-ASSEMBLY-FIXTURE";

// Native IPC awaits let Discord's stores change even after the phase-2 check. A snapshot of
// permissions is not authority for the rest of the disk read / aggregate write phase.
for (const boundary of ["startExportFiles", "listHistoryPages", "readHistoryPage", "appendExport", "finishExport", "publishExport"]) {
    test(`private access lost during ${boundary} removes its content and identity from the entire run`, async () => {
        let managed = true;
        let revoked = false;
        const app = loadPlugin({
            channels: [parent, thread], guilds: [guild], can: bit => bit !== 4n || managed,
            rest: ({ url }) => ({ body: url.endsWith("/messages")
                ? [url === `/channels/${thread.id}/messages` ? { ...message(20), content: secret } : message(21)]
                : { threads: [], has_more: false } })
        });
        const helpers = app.native;
        assert.ok(helpers, "test harness must expose its actual native boundary");
        const original = helpers[boundary];
        helpers[boundary] = async (...args) => {
            const result = await original(...args);
            if (!revoked && (boundary !== "readHistoryPage" && boundary !== "listHistoryPages" || args[2] === thread.id)) {
                revoked = true;
                managed = false;
            }
            return result;
        };
        await app.hooks.exportGuild(guild);
        assert.ok(revoked, "exercise the specific post-check IPC boundary");
        for (const out of [exportText(app), exportHtml(app), exportJson(app), exportManifest(app)]) {
            assert.ok(!out.includes(secret), "no revoked private message may survive");
            assert.ok(!out.includes(thread.id), "no revoked private identity may survive");
            assert.ok(!out.includes(thread.name), "no revoked private name may survive");
        }
        assert.ok(exportText(app).includes("fixture message 21"), "keep authorized public messages");
        assert.ok(!app.toasts.some(t => t[1] === "success"), "revocation makes the export incomplete");
    });
}
