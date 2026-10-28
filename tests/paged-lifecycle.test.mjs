import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, tree, sha } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  backupPaged,
  restorePaged,
  verifyPaged,
} from "../platform/paged-operations.mjs";
import { copyPaged, rebuildPaged } from "../platform/paged-copy.mjs";
import {
  retirementPreview,
  requestRetirement,
  finalizeRetirement,
} from "../platform/paged-retention.mjs";
import {
  protectionPreview,
  applyProtection,
} from "../platform/recovery-policy.mjs";
import { S3Backend } from "../platform/s3.mjs";
import { pushSnapshot, restoreRemote } from "../platform/remote.mjs";
async function setup(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME,
    pass = process.env.MOONRESTORE_PASSWORD;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  process.env.MOONRESTORE_PASSWORD = "synthetic-v09-password";
  try {
    f.paged = path.join(f.base, "paged");
    await PagedStore.create(f.paged, { encrypted: true });
    await work(f);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    if (pass === undefined) delete process.env.MOONRESTORE_PASSWORD;
    else process.env.MOONRESTORE_PASSWORD = pass;
    f.cleanup();
  }
}
class ControlledBackend extends S3Backend {
  constructor() {
    super({
      endpoint: "http://127.0.0.1:1",
      bucket: "synthetic",
      accessKeyId: "synthetic",
      secretAccessKey: "synthetic-secret-only",
    });
    this.items = new Map();
  }
  async putImmutable(k, b) {
    const existing = this.items.get(k);
    if (existing && sha(existing) !== sha(b))
      throw new Error("immutable collision");
    this.items.set(k, Buffer.from(b));
    return {
      checksum: sha(b),
      size: String(b.length),
      version: "v1",
      server_retention_reported: false,
    };
  }
  async get(k, { checksum, version } = {}) {
    const b = this.items.get(k);
    if (!b || sha(b) !== checksum || (version && version !== "v1"))
      throw new Error("Pinned checksum/version mismatch");
    return { bytes: Buffer.from(b) };
  }
}
test("format4 clone and key-rotating rebuild audit all selected roots and preserve old roots", () =>
  setup(async (f) => {
    put(f.source, "one.txt", "important");
    const b = await backupPaged(f.paged, f.source);
    const prior = fs.readdirSync(path.join(f.paged, "snapshots"));
    const clone = path.join(f.base, "clone");
    await copyPaged(f.paged, clone);
    const again = await copyPaged(f.paged, clone);
    assert.equal(again.append_only_existing_replica, true);
    await verifyPaged(clone, b.snapshot);
    const rebuilt = path.join(f.base, "rebuilt"),
      password = "replacement-synthetic-secret";
    const r = await rebuildPaged(f.paged, rebuilt, {
      snapshots: [b.snapshot],
      destinationPassword: password,
    });
    assert.equal(r.new_master_key, true);
    assert.equal(r.old_copies_revoked, false);
    assert.deepEqual(fs.readdirSync(path.join(f.paged, "snapshots")), prior);
    const env = {
      ...process.env,
      MOONRESTORE_PASSWORD: password,
      MOONRESTORE_KEY_FILE: "",
    };
    await verifyPaged(rebuilt, r.mapping[0].to, { environment: env });
    await restorePaged(rebuilt, r.mapping[0].to, path.join(f.base, "out"), {
      environment: env,
    });
    assert.deepEqual(tree(path.join(f.base, "out")), tree(f.source));
    await assert.rejects(verifyPaged(rebuilt, r.mapping[0].to));
  }));
test("retirement holds roots live through grace, refuses wrong confirmation and preserves pins", () =>
  setup(async (f) => {
    put(f.source, "a", "old");
    const old = await backupPaged(f.paged, f.source, {
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    put(f.source, "a", "new");
    const fresh = await backupPaged(f.paged, f.source, {
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    const now = Date.parse("2026-02-01T00:00:00.000Z"),
      config = {
        keepLast: 1,
        minimumDays: 1,
        pins: [],
        graceDays: 7,
        acknowledgeLocalOnly: true,
      },
      p = await retirementPreview(f.paged, config, { now });
    assert.deepEqual(p.candidate_snapshots, [old.snapshot]);
    const requested = await requestRetirement(f.paged, config, p.confirmation, {
      now,
      uptimeSeconds: 1000,
    });
    assert.equal(fs.readdirSync(path.join(f.paged, "snapshots")).length, 2);
    put(f.source, "during-grace.txt", "new backup must remain possible");
    const duringGrace = await backupPaged(f.paged, f.source, {
      startedAt: "2026-02-03T00:00:00.000Z",
    });
    await assert.rejects(
      finalizeRetirement(f.paged, requested.request, requested.confirmation, {
        now: now + 86400000,
        uptimeSeconds: 1000 + 86400,
      }),
      /grace/,
    );
    await assert.rejects(
      finalizeRetirement(f.paged, requested.request, requested.confirmation, {
        now: now + 8 * 86400000,
        uptimeSeconds: 1001,
      }),
      /grace/,
    );
    await assert.rejects(
      finalizeRetirement(f.paged, requested.request, "wrong", {
        now: now + 8 * 86400000,
        uptimeSeconds: 1000 + 8 * 86400,
      }),
      /confirmation/,
    );
    const result = await finalizeRetirement(
      f.paged,
      requested.request,
      requested.confirmation,
      { now: now + 8 * 86400000, uptimeSeconds: 1000 + 8 * 86400 },
    );
    assert.equal(result.permanently_deleted, 1);
    assert.equal(result.objects_deleted, 0);
    await verifyPaged(f.paged, fresh.snapshot);
    await verifyPaged(f.paged, duringGrace.snapshot);
    assert.equal(fs.readdirSync(path.join(f.paged, "snapshots")).length, 2);
    assert.equal(
      (
        await finalizeRetirement(
          f.paged,
          requested.request,
          requested.confirmation,
          { now: now + 9 * 86400000, uptimeSeconds: 1000 + 9 * 86400 },
        )
      ).idempotent,
      true,
    );
  }));
test("new protection pins and altered request authentication block retirement", () =>
  setup(async (f) => {
    put(f.source, "a", "old");
    const old = await backupPaged(f.paged, f.source, {
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    put(f.source, "a", "new");
    await backupPaged(f.paged, f.source, {
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    const now = Date.now(),
      config = { keepLast: 1, minimumDays: 1, acknowledgeLocalOnly: true },
      p = await retirementPreview(f.paged, config, { now }),
      request = await requestRetirement(f.paged, config, p.confirmation, {
        now,
        uptimeSeconds: 1000,
      });
    const protect = { minimumDays: 1, pins: [old.snapshot] },
      preview = protectionPreview(f.paged, protect);
    await applyProtection(f.paged, protect, preview.confirmation);
    await assert.rejects(
      finalizeRetirement(f.paged, request.request, request.confirmation, {
        now: now + 8 * 86400000,
        uptimeSeconds: 1000 + 8 * 86400,
      }),
      /Protection changed/,
    );
    await verifyPaged(f.paged, old.snapshot);
    const base = path.join(process.env.MOONRESTORE_HOME, "paged-retirement-v1"),
      folder = path.join(base, fs.readdirSync(base)[0]),
      file = path.join(folder, request.request + ".json"),
      r = JSON.parse(fs.readFileSync(file));
    r.mac = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(r));
    await assert.rejects(
      finalizeRetirement(f.paged, request.request, request.confirmation, {
        now: now + 8 * 86400000,
        uptimeSeconds: 1000 + 8 * 86400,
      }),
      /authentication/,
    );
  }));
test("paged remote ciphertext receipts survive fresh-state recovery; missing/corrupt pages fail closed", () =>
  setup(async (f) => {
    put(f.source, "private-name.txt", "UNIQUE-PRIVATE-BODY");
    const b = await backupPaged(f.paged, f.source),
      backend = new ControlledBackend(),
      upload = await pushSnapshot(f.paged, b.snapshot, backend);
    assert.equal(upload.real_cloud_provider_verified, false);
    for (const raw of backend.items.values()) {
      assert.equal(raw.includes(Buffer.from("private-name")), false);
      assert.equal(raw.includes(Buffer.from("UNIQUE-PRIVATE-BODY")), false);
    }
    const old = process.env.MOONRESTORE_HOME;
    process.env.MOONRESTORE_HOME = path.join(f.base, "fresh-state");
    try {
      const dest = path.join(f.base, "download");
      const r = await restoreRemote(
        backend,
        upload.receipt_key,
        upload.receipt_checksum,
        dest,
        { version: upload.receipt_version },
      );
      assert.equal(r.full_snapshot_audit, true);
      await restorePaged(dest, b.snapshot, path.join(f.base, "out"));
      assert.deepEqual(tree(path.join(f.base, "out")), tree(f.source));
    } finally {
      process.env.MOONRESTORE_HOME = old;
    }
    const root = JSON.parse(backend.items.get(upload.receipt_key)),
      key = root.pages[0].key;
    backend.items.set(key, Buffer.from("corrupt"));
    const dest = path.join(f.base, "bad");
    await assert.rejects(
      restoreRemote(backend, upload.receipt_key, upload.receipt_checksum, dest),
    );
    assert.equal(fs.existsSync(dest), false);
  }));
test("unreadable encrypted historical root does not block a fresh verified backup", () =>
  setup(async (f) => {
    put(f.source, "a", "body");
    await backupPaged(f.paged, f.source);
    const file = path.join(
      f.paged,
      "snapshots",
      fs.readdirSync(path.join(f.paged, "snapshots"))[0],
    );
    fs.writeFileSync(file, "corrupt");
    const fresh = await backupPaged(f.paged, f.source);
    assert.equal(fresh.cleanup_blocked, true);
    assert.ok(fresh.history_audit.damaged_roots > 0);
    await verifyPaged(f.paged, fresh.snapshot);
  }));
