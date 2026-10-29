import test from "node:test";
import assert from "node:assert/strict";
import { storageCore } from "../platform/paged-store.mjs";

test("MoonBit restore plans agree with former dense/sparse arithmetic for every checkpoint boundary", async () => {
  const core = await storageCore();
  let count = 0;
  for (const size of [0, 1, 7, 16, 129]) {
    for (let prefix = 0; prefix <= size; prefix++) {
      for (const sparse of [
        null,
        [],
        [{ start: "0", length: String(Math.max(1, size)) }],
      ].filter((x) => size > 0 || x === null || !x.length)) {
        const session = "differential";
        core(
          "restore-writer-new",
          {
            session,
            entries: String(prefix),
            total: String(size),
            chunks: String(Math.floor(prefix / 2)),
          },
          Buffer.from(JSON.stringify(sparse)),
        );
        let position = 0;
        while (position < size) {
          const length = Math.min(5, size - position);
          const already = Math.max(0, Math.min(length, prefix - position));
          const writes = [];
          if (already < length) {
            for (const range of sparse ?? [
              {
                start: String(position + already),
                length: String(length - already),
              },
            ]) {
              const start = Math.max(position + already, Number(range.start));
              const end = Math.min(
                position + length,
                Number(range.start) + Number(range.length),
              );
              if (end > start) writes.push({ start, length: end - start });
            }
          }
          const plan = core("restore-writer-chunk", { session, count: length });
          assert.equal(plan.verify, already);
          assert.equal(Number(plan.offset), position);
          assert.equal(Number(plan.end), position + length);
          assert.equal(plan.checkpoint, already < length);
          assert.deepEqual(
            plan.writes.map((r) => ({
              start: Number(r.start),
              length: Number(r.length),
            })),
            writes,
          );
          position += length;
          count++;
        }
        core("restore-writer-finish", { session });
        core("close", { session });
      }
    }
  }
  assert.ok(count > 10000);
});

test("failed restore streams release all MoonBit writer slots; malformed spans never authorize writing", async () => {
  const core = await storageCore();
  for (let i = 0; i < 40; i++) {
    const session = "failed-" + i;
    core("restore-writer-new", { session, total: "4" }, Buffer.from("null"));
    assert.throws(() => core("restore-writer-finish", { session }));
    core("close", { session });
  }
  assert.throws(() =>
    core(
      "restore-writer-new",
      { session: "bad", total: "4" },
      Buffer.from('[{"start":"3","length":"2"}]'),
    ),
  );
  assert.throws(() =>
    core("restore-publication", { previous: "running", count: 1 }),
  );
  core("restore-publication", { previous: "publishing", count: 1 });
});
