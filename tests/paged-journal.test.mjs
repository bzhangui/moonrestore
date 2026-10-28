import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, put, call, cli, randomBytes, tree } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  createPagedOperation,
  runPagedOperation,
  pagedOperationStatus,
} from "../platform/paged-journal.mjs";
import { restorePaged } from "../platform/paged-operations.mjs";
async function setup(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    await work({ ...f, paged: repo });
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("format4 operation performs verified backup and idempotent completion without claiming a restore", () =>
  setup(async (f) => {
    put(f.source, "a", "stateful source");
    const op = await createPagedOperation(f.paged, f.source),
      result = await runPagedOperation(f.paged, op.operation);
    assert.equal(result.state, "completed");
    assert.equal(result.post_commit_verified, true);
    assert.equal(result.post_restore_readback, false);
    assert.equal(
      (await runPagedOperation(f.paged, op.operation)).idempotent,
      true,
    );
    await restorePaged(f.paged, result.snapshot, path.join(f.base, "restore"));
    assert.deepEqual(tree(path.join(f.base, "restore")), tree(f.source));
  }));
test("an actual terminated worker resumes authenticated written chunks and refuses blind dead-lease takeover", () =>
  setup(async (f) => {
    put(f.source, "large", randomBytes(2097152));
    const op = await createPagedOperation(f.paged, f.source),
      crash = spawnSync(
        process.execPath,
        [cli, "paged-operation-run", f.paged, op.operation],
        {
          env: { ...process.env, MOONRESTORE_TEST_CRASH: "paged-checkpoint" },
          encoding: "utf8",
          timeout: 30000,
        },
      );
    assert.equal(crash.status, 86, crash.stderr);
    assert.equal(fs.readdirSync(path.join(f.paged, "snapshots")).length, 0);
    const status = await pagedOperationStatus(f.paged, op.operation);
    assert.ok(status.checkpoint_chunks > 0);
    await assert.rejects(runPagedOperation(f.paged, op.operation), /recovery/);
    const result = await runPagedOperation(f.paged, op.operation, {
      recover: true,
    });
    assert.equal(result.state, "completed");
    assert.ok(Number(result.reused_bytes) > 0);
    await restorePaged(f.paged, result.snapshot, path.join(f.base, "restore"));
    assert.deepEqual(tree(path.join(f.base, "restore")), tree(f.source));
  }));
test("source changes and altered journal receipts never authorize resuming a different snapshot", () =>
  setup(async (f) => {
    put(f.source, "a", "before");
    const op = await createPagedOperation(f.paged, f.source);
    put(f.source, "a", "after");
    await assert.rejects(
      runPagedOperation(f.paged, op.operation),
      /source changed/,
    );
    assert.equal(fs.readdirSync(path.join(f.paged, "snapshots")).length, 0);
    const another = await createPagedOperation(f.paged, f.source),
      file = path.join(
        process.env.MOONRESTORE_HOME,
        "paged-operations-v1",
        another.operation,
        "control.json",
      ),
      record = JSON.parse(fs.readFileSync(file));
    record.mac = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(
      runPagedOperation(f.paged, another.operation),
      /authentication/,
    );
  }));
