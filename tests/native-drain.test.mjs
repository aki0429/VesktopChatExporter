import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
async function fixture(overrides) {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR, "vesktop-drain-"));
    const code = buildSync({ entryPoints: [path.resolve("src/plugins/vesktopChatExporter/native.ts")], bundle: true, write: false, platform: "node", format: "cjs", external: ["electron"] }).outputFiles[0].text;
    const ctx = { module: { exports: {} }, require: n => n === "electron" ? { app: { getPath: () => root }, shell: {} } : n === "fs/promises" ? { ...fs, ...overrides } : require(n) };
    vm.runInNewContext(code, ctx);
    return { root, native: ctx.module.exports };
}
for (const boundary of ["start", "finish"]) {
    test(`${boundary} drains a delayed sibling write before returning rejection`, async () => {
        let release, started;
        const gate = new Promise(r => { release = r; });
        const entered = new Promise(r => { started = r; });
        let inject = false;
        const method = boundary === "start" ? "writeFile" : "appendFile";
        const disk = await fixture({ [method]: async (file, ...args) => {
            if (inject && String(file).endsWith(".txt.partial")) throw Object.assign(new Error("fixture"), { code: "EIO" });
            if (inject && String(file).endsWith(".html.partial")) { started(); await gate; }
            return fs[method](file, ...args);
        } });
        try {
            const N = disk.native, run = "fixture-drain";
            await N.beginExport(null, undefined, run, '{}');
            if (boundary === "finish") await N.startExportFiles(null, undefined, run, "HEADER", "<html>");
            inject = true;
            let settled = false;
            const operation = (boundary === "start" ? N.startExportFiles(null, undefined, run, "HEADER", "<html>") : N.finishExport(null, undefined, run, '{}', "FOOT", "</html>"))
                .then(() => { settled = true; }, () => { settled = true; });
            await entered;
            await new Promise(r => setImmediate(r));
            const early = settled;
            release(); await operation;
            await N.abortExportFiles(null, undefined, run);
            assert.equal(early, false, "failure cannot escape while its sibling can still recreate a deleted file");
        } finally { release(); await fs.rm(disk.root, { recursive: true, force: true }); }
    });
}

test("post-publication summary cleanup failure cannot delete complete final files", async () => {
    let deny = false;
    const disk = await fixture({ rm: async (file, ...args) => {
        if (deny && String(file).endsWith('.summary.pending.json')) throw Object.assign(new Error('fixture'), { code: 'EACCES' });
        return fs.rm(file, ...args);
    } });
    try {
        const N = disk.native, run = 'fixture-summary';
        const paths = await N.beginExport(null, undefined, run, '{}');
        await N.startExportFiles(null, undefined, run, 'HEADER', '<html>');
        await N.finishExport(null, undefined, run, '{"outcome":"complete"}', 'FOOT', '</html>');
        deny = true;
        await N.publishExport(null, undefined, run);
        assert.equal(JSON.parse(await fs.readFile(paths.manifestPath, 'utf8')).outcome, 'complete');
        assert.equal(await fs.readFile(paths.txtPath, 'utf8'), 'HEADERFOOT');
        assert.equal(await fs.readFile(paths.htmlPath, 'utf8'), '<html></html>');
    } finally { deny = false; await fs.rm(disk.root, { recursive: true, force: true }); }
});
