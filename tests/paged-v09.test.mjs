import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, put, tree } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { PagedCache } from "../platform/paged-cache.mjs";
import {
  backupPaged,
  verifyPaged,
  restorePaged,
} from "../platform/paged-operations.mjs";
import { garbagePaged, purgePaged } from "../platform/paged-maintenance.mjs";
import { setCleanupGuard } from "../platform/plans.mjs";
import { storageCapabilities } from "../platform/storage-capabilities.mjs";
import { repositoryKind } from "../platform/repository-kind.mjs";
async function setup(work, { encrypted = false } = {}) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const env = encrypted
    ? { ...process.env, MOONRESTORE_PASSWORD: "controlled-v09-password-only" }
    : process.env;
  try {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo, { encrypted, environment: env });
    await work({ ...f, paged: repo, environment: env });
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("repository discriminator and capability probe are explicit and clean their exact synthetic directory", () =>
  setup(async (f) => {
    const before = fs.readdirSync(f.base).sort();
    const p = storageCapabilities(f.base);
    assert.equal(p.ok, true);
    assert.equal(p.hardware_power_loss_verified, false);
    assert.deepEqual(fs.readdirSync(f.base).sort(), before);
    assert.equal(repositoryKind(f.paged).format, 4);
    assert.equal(repositoryKind(f.repo).format, 1);
    const orphan = path.join(f.paged, "pages", "0".repeat(64));
    fs.writeFileSync(orphan, "synthetic unreachable member");
    const preview = await garbagePaged(f.paged),
      quarantined = await garbagePaged(f.paged, {
        confirmation: preview.confirmation,
      });
    setCleanupGuard(f.paged, { blocked: true, updated: Date.now() });
    await assert.rejects(garbagePaged(f.paged), /guard/);
    await assert.rejects(purgePaged(f.paged, quarantined.batch), /guard/);
  }));
test("authenticated persistent hints skip full historical content scans but never claim a new full audit", () =>
  setup(async (f) => {
    put(f.source, "a", "same payload");
    const first = await backupPaged(f.paged, f.source),
      second = await backupPaged(f.paged, f.source);
    assert.equal(first.post_commit_verified, true);
    assert.ok(second.history_audit.cached_roots >= 1);
    assert.equal(second.history_fully_healthy, false);
    assert.ok(Number(second.reused_bytes) > 0);
    assert.equal(second.stored_pack_bytes, "0");
    await verifyPaged(f.paged, second.snapshot);
    const full = await backupPaged(f.paged, f.source, { fullHistory: true });
    assert.equal(full.history_audit.cached_roots, 0);
    assert.ok(full.history_audit.fully_checked >= 2);
  }));
test("bad history never prevents a fresh verified backup and remains a hard GC barrier", () =>
  setup(async (f) => {
    put(f.source, "a", "same payload");
    const first = await backupPaged(f.paged, f.source),
      pack = path.join(
        f.paged,
        "packs",
        fs.readdirSync(path.join(f.paged, "packs"))[0],
      ),
      bad = fs.readFileSync(pack);
    bad[bad.length - 1] ^= 1;
    fs.writeFileSync(pack, bad);
    const second = await backupPaged(f.paged, f.source, { fullHistory: true });
    assert.equal(second.post_commit_verified, true);
    assert.equal(second.cleanup_blocked, true);
    assert.ok(second.history_audit.damaged_roots >= 1);
    assert.ok(second.damaged_reuse_candidates >= 1);
    assert.deepEqual(fs.readFileSync(pack), bad);
    await assert.rejects(verifyPaged(f.paged, first.snapshot));
    await verifyPaged(f.paged, second.snapshot);
    await restorePaged(f.paged, second.snapshot, path.join(f.base, "restored"));
    assert.deepEqual(tree(path.join(f.base, "restored")), tree(f.source));
    await assert.rejects(garbagePaged(f.paged));
  }));
test("damaged immutable page is preserved while a semantically equivalent new page can be published", () =>
  setup(async (f) => {
    put(f.source, "a", "data");
    const first = await backupPaged(f.paged, f.source),
      store = await PagedStore.open(f.paged);
    let file;
    try {
      file = store.file("page", store.root(first.snapshot).last_page);
    } finally {
      store.close();
    }
    const bad = Buffer.from("corrupted page");
    fs.writeFileSync(file, bad);
    const next = await backupPaged(f.paged, f.source, { fullHistory: true });
    assert.equal(next.cleanup_blocked, true);
    assert.deepEqual(fs.readFileSync(file), bad);
    await verifyPaged(f.paged, next.snapshot);
  }));
test("tampered cache locators are discarded and freshly verified objects remain authoritative", () =>
  setup(async (f) => {
    put(f.source, "a", "safe");
    await backupPaged(f.paged, f.source);
    const store = await PagedStore.open(f.paged),
      cache = new PagedCache(store);
    let file;
    try {
      file = path.join(cache.folder, "cache.sqlite");
      cache.close();
      const db = new DatabaseSync(file);
      db.prepare("UPDATE hints SET mac=? WHERE k LIKE 'object:%'").run(
        "0".repeat(64),
      );
      db.close();
    } finally {
      store.close();
    }
    const next = await backupPaged(f.paged, f.source);
    assert.equal(next.post_commit_verified, true);
    await verifyPaged(f.paged, next.snapshot);
  }));
test("encrypted persistent cache contains no business filenames or plaintext bodies", () =>
  setup(
    async (f) => {
      put(f.source, "private-name.txt", "PRIVATE-BUSINESS-PLAINTEXT");
      await backupPaged(f.paged, f.source, { environment: f.environment });
      const store = await PagedStore.open(f.paged, {
          environment: f.environment,
        }),
        cache = new PagedCache(store);
      try {
        for (const name of fs.readdirSync(cache.folder)) {
          const bytes = fs.readFileSync(path.join(cache.folder, name));
          assert.equal(bytes.includes(Buffer.from("private-name")), false);
          assert.equal(bytes.includes(Buffer.from("PRIVATE-BUSINESS")), false);
        }
      } finally {
        cache.close();
        store.close();
      }
    },
    { encrypted: true },
  ));
