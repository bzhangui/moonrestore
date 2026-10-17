import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put } from "./helpers.mjs";
import {
  savePlan,
  runPlan,
  planStatus,
  assertCleanupGuard,
  setCleanupGuard,
} from "../platform/plans.mjs";
test("versioned file plan records separate backup/verify/drill/replica evidence and gates anomalies and cleanup", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    put(f.source, "a", "kept");
    put(f.source, "b", "other");
    const saved = savePlan({
      name: "受控资料",
      type: "files",
      repository: f.repo,
      source: f.source,
      replica: path.join(f.base, "copy"),
      reserveBytes: 0,
    });
    assert.throws(() => assertCleanupGuard(f.repo), /guard/);
    let result = await runPlan(saved.id);
    assert.equal(result.ok, true);
    assert.ok(result.evidence.replica);
    assertCleanupGuard(f.repo);
    assert.equal(result.production_rto_guaranteed, false);
    const previous = result.evidence.backup.snapshot;
    fs.unlinkSync(path.join(f.source, "b"));
    await assert.rejects(() => runPlan(saved.id), /anomaly/);
    assert.equal(planStatus(saved.id).evidence.backup.snapshot, previous);
    assert.throws(() => assertCleanupGuard(f.repo));
    result = await runPlan(saved.id, { acceptAnomaly: true });
    assert.equal(result.ok, true);
    assert.throws(
      () => assertCleanupGuard(f.repo, Date.now() - 86400000),
      /clock/,
    );
    assert.throws(
      () => assertCleanupGuard(f.repo, Date.now() + 90000000),
      /stale/,
    );
    setCleanupGuard(
      f.repo,
      { blocked: true, updated: Date.now() },
      "second-plan",
    );
    setCleanupGuard(f.repo, { blocked: false, updated: Date.now() }, saved.id);
    assert.throws(() => assertCleanupGuard(f.repo));
    assert.throws(
      () =>
        savePlan({
          name: "bad",
          type: "files",
          repository: f.repo,
          source: f.source,
          password: "secret",
        }),
      /credential/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
