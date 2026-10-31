import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, randomBytes, tree } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { backupPaged, verifyPaged } from "../platform/paged-operations.mjs";
import {
  createPagedRestore,
  runPagedRestore,
  pagedRestoreStatus,
} from "../platform/paged-restore.mjs";
import { withSignal } from "../platform/activity.mjs";
import { generatedTraces, shrinkTrace } from "./fault-trace-support.mjs";
async function replay(trace) {
  const f = fixture(),
    home = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "home");
  try {
    const repo = path.join(f.base, "paged"),
      target = path.join(f.base, "restored");
    await PagedStore.create(repo, { fidelity: trace.format5 });
    put(f.source, "中文/asset", randomBytes(131072, trace.index + 1));
    put(f.source, "empty", "");
    const b = await backupPaged(repo, f.source),
      before = tree(repo),
      op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
        permissions: trace.format5,
      });
    for (const step of trace.steps) {
      if (step.action === "io") {
        process.env.MOONRESTORE_TEST_IO = step.code + ":" + step.stage;
        try {
          await assert.rejects(
            runPagedRestore(repo, op.operation),
            (e) => e.code === step.code,
          );
        } finally {
          delete process.env.MOONRESTORE_TEST_IO;
        }
      } else if (step.action === "target-conflict") {
        fs.writeFileSync(target, "synthetic-foreign-file");
        try {
          await assert.rejects(runPagedRestore(repo, op.operation));
          assert.equal(
            fs.readFileSync(target, "utf8"),
            "synthetic-foreign-file",
          );
        } finally {
          fs.unlinkSync(target);
        }
      } else if (step.action === "damaged-pack") {
        const file = path.join(
            repo,
            "packs",
            fs.readdirSync(path.join(repo, "packs"))[0],
          ),
          original = fs.readFileSync(file);
        fs.writeFileSync(file, "synthetic-corruption");
        try {
          await assert.rejects(runPagedRestore(repo, op.operation));
        } finally {
          fs.writeFileSync(file, original);
        }
      } else if (step.action === "cancel") {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          withSignal(controller.signal, () =>
            runPagedRestore(repo, op.operation),
          ),
          /cancel/,
        );
      } else if (step.action === "resume") {
        const r = await runPagedRestore(repo, op.operation);
        assert.equal(r.complete, true);
        assert.deepEqual(tree(target), tree(f.source));
      } else throw new Error("Unknown finite fault action");
      if (step.action !== "resume") {
        assert.equal(
          (await pagedRestoreStatus(repo, op.operation)).complete,
          false,
        );
        assert.equal(fs.existsSync(target), false);
      }
    }
    await verifyPaged(repo, b.snapshot);
    assert.deepEqual(tree(repo), before);
    return "invariants-preserved";
  } finally {
    delete process.env.MOONRESTORE_TEST_IO;
    if (home === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = home;
    f.cleanup();
  }
}
test("fixed-seed combined faults replay IO/checkpoint/foreign-target/corruption/cancellation then recover without overwrites", async () => {
  for (const trace of generatedTraces(20261031, 8))
    assert.equal(
      await replay(trace),
      "invariants-preserved",
      JSON.stringify(trace),
    );
});
test("trace replay is deterministic and shrinker retains one failure fingerprint without claiming a global minimum", async () => {
  assert.deepEqual(generatedTraces(12), generatedTraces(12));
  const trace = generatedTraces(12, 1)[0],
    oracle = async (t) =>
      t.steps.some((s) => s.action === "io") &&
      t.steps.some((s) => s.action === "cancel")
        ? "controlled-oracle"
        : "other";
  const r = await shrinkTrace(trace, oracle, "controlled-oracle");
  assert.equal(r.trace.steps.length, 2);
  assert.equal(await oracle(r.trace), "controlled-oracle");
  assert.equal(r.global_minimum_proven, false);
});
