import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message, exportText } from "./harness.mjs";
const dm = { id: id(1), type: 1 };
test("a transient second-page 500 retries the same cursor instead of finishing with only the newest hundred", async () => {
    let calls = 0;
    const app = loadPlugin({ channels: [dm], rest: ({ query }) => {
        if (++calls === 2) throw { status: 500 };
        return { body: query.before ? [message(100)] : Array.from({ length: 100 }, (_, i) => message(200 - i)) };
    } });
    await app.hooks.exportDm(dm);
    assert.equal(calls, 3);
    assert.equal(app.requests[1].query.before, app.requests[2].query.before);
    assert.equal((exportText(app).match(/fixture message /g) ?? []).length, 101);
    assert.ok(app.toasts.some(t => t[1] === "success"));
});
test("persistent 500 retries are bounded and 403 is never retried", async () => {
    for (const [status, expected] of [[500, 3], [403, 1]]) {
        const app = loadPlugin({ channels: [dm], rest: () => { throw { status }; } });
        await app.hooks.exportDm(dm);
        assert.equal(app.requests.length, expected);
        assert.ok(!app.toasts.some(t => t[1] === "success"));
    }
});
