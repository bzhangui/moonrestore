import test from "node:test";
import assert from "node:assert/strict";
import { storageCore } from "../platform/paged-store.mjs";
test("MoonBit page writer follows exact JSON page boundaries and retains decimal byte totals", async () => {
  const core = await storageCore(),
    session = "page-differential";
  core("page-writer-new", { session });
  let page = [],
    pages = 0,
    entries = 0;
  try {
    for (let i = 0; i < 3000; i++) {
      const record = {
        kind: "dir",
        path: "资料/" + i + "x".repeat(i % 200),
        id: "",
        size: "0",
        pack: "",
        offset: 0,
        mtime_ms: "0",
        mode: 448,
      };
      const count = Buffer.byteLength(JSON.stringify(record)),
        flush =
          page.length === 128 ||
          Buffer.byteLength(JSON.stringify(page)) + count > 250000;
      assert.equal(core("page-writer-needs", { session, count }), flush);
      if (flush) {
        core("page-writer-seal", { session, previous: "a".repeat(64) });
        page = [];
        pages++;
      }
      core("page-writer-record", { session, count, record });
      page.push(record);
      entries++;
      const summary = core("page-writer-state", { session });
      assert.equal(summary.pages, pages);
      assert.equal(summary.records, page.length);
      assert.equal(summary.entries, String(entries));
    }
  } finally {
    core("close", { session });
  }
});
test("failed writers and GC planners release all bridge sessions and reject narrowing overflow", async () => {
  const core = await storageCore();
  for (let i = 0; i < 40; i++) {
    const session = "failed-" + i;
    core("page-writer-new", { session });
    assert.throws(() =>
      core("page-writer-seal", { session, previous: "b".repeat(64) }),
    );
    core("close", { session });
    core("gc-planner-new", { session, sequence: 0, count: 2, total: "1" });
    assert.throws(() => core("gc-planner-finish", { session }));
    core("close", { session });
  }
  assert.throws(() =>
    core("gc-planner-new", {
      session: "overflow",
      sequence: 0,
      count: 1,
      total: "1099511627777",
    }),
  );
});
