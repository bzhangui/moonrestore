import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  requesterProcess,
  NativeVssProvider,
  isNativeVssProvider,
} from "../platform/vss-native.mjs";
const script = fileURLToPath(
  new URL("./fixtures/vss-requester-controlled.mjs", import.meta.url),
);
test("controlled requester transport requires matching set, writers and an exact cleanup receipt", async () => {
  const before = process.env.MOONRESTORE_TEST_VSS_PROTOCOL;
  try {
    for (const mode of [
      "normal",
      "wrong-set",
      "no-writers",
      "cleanup-unknown",
    ]) {
      process.env.MOONRESTORE_TEST_VSS_PROTOCOL = mode;
      let intents = 0;
      const session = requesterProcess(
        process.execPath,
        script,
        () => intents++,
      );
      if (["wrong-set", "no-writers"].includes(mode)) {
        await assert.rejects(session.ready, /protocol/);
        await assert.rejects(session.finish(false), /unconfirmed/);
      } else {
        const r = await session.ready;
        assert.equal(r.writers, 1);
        if (mode === "cleanup-unknown")
          await assert.rejects(session.finish(true), /unconfirmed/);
        else assert.equal((await session.finish(true)).removed, true);
      }
      assert.equal(intents, 1);
    }
    assert.equal(isNativeVssProvider({ kind: "windows_vss" }), false);
    assert.throws(() => new NativeVssProvider(), /permission/);
  } finally {
    if (before === undefined) delete process.env.MOONRESTORE_TEST_VSS_PROTOCOL;
    else process.env.MOONRESTORE_TEST_VSS_PROTOCOL = before;
  }
});
