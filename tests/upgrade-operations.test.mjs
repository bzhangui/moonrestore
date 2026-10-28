import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, call } from "./helpers.mjs";
import { initWalArchive, archiveWal } from "../platform/postgres-physical.mjs";
import { bindWalArchive, walHealth } from "../platform/wal-health.mjs";
import { runPlanLoop } from "../platform/plan-runner.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { backupPaged } from "../platform/paged-operations.mjs";
import { runEngine } from "../platform/engine-client.mjs";
import { withSignal } from "../platform/activity.mjs";
async function setup(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    await work(f);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("WAL coverage detects gaps/corruption/backlog and never infers wall-clock recovery or cluster identity from filenames", () =>
  setup(async (f) => {
    const wal = path.join(f.base, "wal"),
      segment = path.join(f.base, "segment"),
      base = path.join(f.base, "physical.json"),
      status = path.join(f.base, "archive-status");
    initWalArchive(wal);
    fs.mkdirSync(status);
    fs.writeFileSync(path.join(status, "000000010000000000000003.ready"), "");
    bindWalArchive(wal, {
      systemIdentifier: "123456789",
      segmentBytes: 1048576,
      confirmation: wal,
    });
    fs.writeFileSync(segment, Buffer.alloc(1048576, 1));
    archiveWal(wal, "000000010000000000000000", segment);
    archiveWal(wal, "000000010000000000000002", segment);
    fs.writeFileSync(
      base,
      JSON.stringify({
        format: 1,
        kind: "postgresql_physical",
        system_identifier: "123456789",
        wal_ranges: [
          { Timeline: 1, "Start-LSN": "0/0", "End-LSN": "0/100000" },
        ],
      }),
    );
    const config = {
      baseMetadata: base,
      timeline: 1,
      expectedEndLsn: "0/300000",
      archiveStatusDirectory: status,
    };
    const missing = walHealth(wal, config);
    assert.equal(missing.ok, false);
    assert.equal(missing.missing_segments, 1);
    assert.equal(missing.backlog_ready, 1);
    assert.equal(missing.recoverable_until_time, null);
    assert.equal(missing.wal_deletions_permitted, false);
    archiveWal(wal, "000000010000000000000001", segment);
    assert.equal(walHealth(wal, config).ok, true);
    assert.equal(walHealth(wal, config).wal_header_identity_verified, false);
    assert.equal(walHealth(wal, { baseMetadata: base, timeline: 1 }).ok, false);
    fs.writeFileSync(path.join(wal, "000000010000000000000001"), "corrupt");
    assert.equal(walHealth(wal, config).invalid_members, 1);
    assert.throws(
      () =>
        bindWalArchive(wal, {
          systemIdentifier: "987",
          segmentBytes: 1048576,
          confirmation: wal,
        }),
      /another cluster/,
    );
    assert.throws(
      () => walHealth(wal, { ...config, timeline: 2 }),
      /not present/,
    );
    fs.writeFileSync(segment, "START WAL LOCATION: synthetic test");
    assert.equal(
      archiveWal(wal, "000000010000000000000000.00000028.backup", segment).ok,
      true,
    );
    assert.throws(() => archiveWal(wal, "../escape.backup", segment));
  }));
test("supervised runner is singleton, cancellation-aware and never claims logout service installation", () =>
  setup(async (f) => {
    let release;
    const gate = new Promise((r) => (release = r)),
      pending = runPlanLoop({
        cycles: 1,
        controlledSimulation: true,
        runner: async () => {
          await gate;
          return { ok: true };
        },
      });
    await assert.rejects(runPlanLoop({ cycles: 1 }), /Runner active/);
    release();
    const r = await pending;
    assert.equal(r.os_service_installed, false);
    assert.equal(r.logout_execution_verified, false);
    assert.equal(r.controlled_simulation, true);
    const controller = new AbortController();
    const stopped = withSignal(controller.signal, () =>
      runPlanLoop({
        cycles: 2,
        controlledSimulation: true,
        runner: async () => {
          controller.abort();
          return { ok: true };
        },
      }),
    );
    await assert.rejects(stopped);
    assert.equal(
      fs.existsSync(
        path.join(process.env.MOONRESTORE_HOME, "runner-v1", ".lock"),
      ),
      false,
    );
  }));
test("public CLI exposes explicit capabilities, selected restore and resource limits without converting legacy repositories", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "a.txt", "text");
    const b = await backupPaged(repo, f.source);
    const c = call(["paged-capabilities", repo]);
    assert.equal(c.protocol, 1);
    assert.equal(c.budgets_not_scale_certification, true);
    assert.ok(c.not_preserved.includes("ADS"));
    const dest = path.join(f.base, "cli-output"),
      preview = call(["paged-selected-preview", repo, b.snapshot, dest]);
    assert.equal(
      call([
        "paged-selected-restore",
        repo,
        b.snapshot,
        dest,
        "--confirm",
        preview.confirmation,
      ]).post_restore_readback,
      true,
    );
    const target = path.join(f.base, "fault");
    const p = await runEngine("restore-preview", {
      repository: repo,
      snapshot: b.snapshot,
      target,
    });
    await assert.rejects(
      runEngine(
        "restore",
        {
          repository: repo,
          snapshot: b.snapshot,
          target,
          confirmation: p.confirmation,
        },
        { env: { MOONRESTORE_TEST_IO: "ENOSPC:selected-before-publish" } },
      ),
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(
      fs.readFileSync(path.join(f.repo, "moonrestore"), "utf8"),
      "moonrestore-repository-v1\n",
    );
  }));
