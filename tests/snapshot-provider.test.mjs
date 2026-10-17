import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, call } from "./helpers.mjs";
import {
  backupWithSnapshotProvider,
  providerRehearsal,
} from "../platform/snapshot-provider.mjs";
import { TaskManager } from "../platform/activity.mjs";
test("synthetic snapshot provider exercises backup/audit/drill/release without claiming VSS", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    const r = await providerRehearsal(f.repo);
    assert.equal(r.ok, true);
    assert.equal(r.lease_released, true);
    assert.equal(r.application_consistency_verified, false);
    assert.equal(r.real_vss_verified, false);
    assert.equal(r.synthetic_data_only, true);
    assert.deepEqual(
      fs.readdirSync(path.join(f.base, "state/provider-rehearsals")),
      [],
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("writer rejection and failed backup always release the exact acquired lease", async () => {
  const f = fixture();
  try {
    const point = path.join(f.base, "point");
    fs.mkdirSync(point);
    put(point, "file", "point data");
    let releases = 0;
    const lease = { id: "owned-lease", path: point, writersReady: false },
      provider = {
        kind: "controlled_simulation",
        async create() {
          return lease;
        },
        async release(got) {
          assert.equal(got, lease);
          releases++;
        },
      };
    await assert.rejects(
      () => backupWithSnapshotProvider(f.repo, f.source, provider),
      /writers/,
    );
    assert.equal(releases, 1);
    assert.equal(call(["list", f.repo]).snapshots.length, 0);
    lease.writersReady = true;
    lease.path = f.source;
    await assert.rejects(
      () => backupWithSnapshotProvider(f.repo, f.source, provider),
      /isolated/,
    );
    assert.equal(releases, 2);
    provider.kind = "windows_vss";
    await assert.rejects(
      () => backupWithSnapshotProvider(f.repo, f.source, provider),
      /not installed/,
    );
    assert.equal(releases, 2);
  } finally {
    f.cleanup();
  }
});
test("release failure cannot report a successful application backup", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    const point = path.join(f.base, "point");
    fs.mkdirSync(point);
    put(point, "a", "synthetic snapshot");
    await assert.rejects(
      () =>
        backupWithSnapshotProvider(f.repo, f.source, {
          kind: "controlled_simulation",
          async create() {
            return { id: "owned", path: point, writersReady: true };
          },
          async release() {
            throw new Error("simulated release failure");
          },
        }),
      /release failed/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("cancellation after acquiring a snapshot still releases its lease", async () => {
  const f = fixture();
  try {
    const point = path.join(f.base, "cancel-point");
    fs.mkdirSync(point);
    put(point, "data", "synthetic point");
    const manager = new TaskManager(),
      lease = { id: "owned-cancel-lease", path: point, writersReady: true };
    let releases = 0;
    manager.start(() =>
      backupWithSnapshotProvider(f.repo, f.source, {
        kind: "controlled_simulation",
        async create() {
          queueMicrotask(() => manager.cancel(manager.current.id));
          return lease;
        },
        async release(value) {
          assert.equal(value, lease);
          releases++;
        },
      }),
    );
    await manager.current.promise;
    assert.equal(manager.state().status, "cancelled");
    assert.equal(releases, 1);
    assert.equal(call(["list", f.repo]).snapshots.length, 0);
  } finally {
    f.cleanup();
  }
});
