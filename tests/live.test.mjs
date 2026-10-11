import test from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, id, message } from "./harness.mjs";

const dm = { id: id(1), type: 1, recipients: [id(2)], rawRecipients: [] };

// The client dispatches an optimistic local echo for own sends before the server confirms the
// message. Both dispatches carry a different snowflake id, so saving both duplicates own messages.
test("an optimistic local echo is not saved and the confirmed message is saved once", async () => {
    const app = loadPlugin({ channels: [dm] });
    await app.hooks.saveLiveMessage({ optimistic: true, message: { ...message(10), channel_id: dm.id } });
    assert.equal(app.saved.length, 0, "the optimistic local echo must not be written");
    await app.hooks.saveLiveMessage({ message: { ...message(11), channel_id: dm.id } });
    assert.equal(app.saved.length, 1, "only the confirmed message is written");
    assert.equal(app.saved[0].args[0].messageId, message(11).id);
});

test("a live message without a timestamp falls back to its snowflake time", async () => {
    const app = loadPlugin({ channels: [dm] });
    const m = { ...message(12), channel_id: dm.id, timestamp: undefined };
    await app.hooks.saveLiveMessage({ message: m });
    const expected = new Date(Number((BigInt(m.id) >> 22n) + 1420070400000n)).toISOString();
    assert.equal(app.saved[0].args[0].timestamp, expected, "the log must not record the save time as the message time");
});
