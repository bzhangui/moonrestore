import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  physicalBackup,
  initWalArchive,
  archiveWal,
  fetchWal,
  validatePhysicalTools,
  pitrDrill,
  physicalClient,
} from "../platform/postgres-physical.mjs";
import { TaskManager } from "../platform/activity.mjs";

test("application cancellation does not suppress bounded owned-server cleanup", async () => {
  const manager = new TaskManager();
  let cleaned = false;
  manager.start(async () => {
    await Promise.resolve();
    manager.cancel(manager.current.id);
    await physicalClient(
      process.execPath,
      ["-e", 'process.stdout.write("controlled-cleanup")'],
      { cleanup: true, timeoutMs: 5000 },
    );
    cleaned = true;
  });
  await manager.current.promise;
  assert.equal(cleaned, true);
  assert.equal(manager.state().status, "cancelled");
});
test("physical backup uses table-space preflight, native manifest validation and MoonBit recovery; simulations remain labeled", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const repo = path.join(f.base, "paged");
  await PagedStore.create(repo);
  const tools = Object.fromEntries(
    ["psql", "pg_basebackup", "pg_verifybackup", "pg_ctl", "pg_waldump"].map(
      (n) => [n, n],
    ),
  );
  let tablespaces = 0,
    verified = false;
  const execute = async (exe, args) => {
    if (args[0] === "--version") return exe + " (PostgreSQL) 16.5";
    if (exe === "psql")
      return JSON.stringify({
        version: 160005,
        tablespaces,
        system_identifier: "123456789",
      });
    if (exe === "pg_basebackup") {
      assert.ok(args.includes("--no-slot"));
      assert.ok(args.includes("--wal-method=stream"));
      const target = args.find((v) => v.startsWith("--pgdata=")).slice(9);
      fs.mkdirSync(target);
      put(target, "PG_VERSION", "16\n");
      put(target, "base/synthetic", "fake-physical-for-lifecycle-only");
      put(
        target,
        "backup_manifest",
        JSON.stringify({
          "WAL-Ranges": [
            { Timeline: 1, "Start-LSN": "0/1000000", "End-LSN": "0/2000000" },
          ],
        }),
      );
      return "";
    }
    if (exe === "pg_verifybackup") {
      verified = true;
      return "";
    }
    throw new Error("Unexpected simulated tool");
  };
  try {
    const r = await physicalBackup(
      repo,
      { tools, user: "synthetic" },
      { execute, controlledSimulation: true },
    );
    assert.equal(r.controlled_simulation, true);
    assert.equal(r.native_client_executed, false);
    assert.equal(r.pitr_target_verified, false);
    assert.equal(verified, true);
    tablespaces = 1;
    await assert.rejects(
      physicalBackup(
        repo,
        { tools, user: "synthetic" },
        { execute, controlledSimulation: true },
      ),
      /tablespaces/,
    );
    await assert.rejects(
      physicalBackup(repo, { tools, user: "synthetic" }, { execute }),
      /simulation/,
    );
    await assert.rejects(
      pitrDrill(repo, r.snapshot, path.join(f.base, "target"), {}),
      /Explicit/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("WAL archive has immutable idempotence, complete segment budgets, checksummed fetch and timeline history", () => {
  const f = fixture();
  try {
    const archive = path.join(f.base, "wal");
    initWalArchive(archive);
    const source = path.join(f.base, "segment");
    fs.writeFileSync(source, Buffer.alloc(1048576, 17));
    const name = "000000010000000000000001";
    assert.equal(archiveWal(archive, name, source).idempotent, false);
    assert.equal(archiveWal(archive, name, source).idempotent, true);
    const restored = path.join(f.base, "fetched");
    assert.equal(fetchWal(archive, name, restored).restored, true);
    assert.deepEqual(fs.readFileSync(source), fs.readFileSync(restored));
    assert.throws(() => fetchWal(archive, name, restored), /not exist/);
    fs.writeFileSync(source, Buffer.alloc(1048576, 18));
    assert.throws(() => archiveWal(archive, name, source), /conflict/);
    assert.throws(() => archiveWal(archive, "../unsafe", source), /Canonical/);
    fs.writeFileSync(source, "short");
    assert.throws(
      () => archiveWal(archive, "000000010000000000000002", source),
      /complete/,
    );
    assert.equal(archiveWal(archive, "00000002.history", source).ok, true);
    fs.writeFileSync(path.join(archive, name), Buffer.alloc(1048576, 1));
    assert.throws(
      () => fetchWal(archive, name, path.join(f.base, "corrupt")),
      /checksum/,
    );
  } finally {
    f.cleanup();
  }
});
test("physical tool versions cannot mix database major versions", async () => {
  await assert.rejects(
    validatePhysicalTools(
      { a: "a", b: "b" },
      async (exe) => "(PostgreSQL) " + (exe === "a" ? "16.1" : "17.1"),
    ),
    /Matching/,
  );
});
