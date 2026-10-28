import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, tree, backup, sha } from "./helpers.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  bounded,
  pageFrom,
} from "../platform/paged-store.mjs";
import {
  backupPaged,
  verifyPaged,
  restorePaged,
  migratePaged,
  pagedCommand,
} from "../platform/paged-operations.mjs";
import {
  garbagePaged,
  recoverPaged,
  purgePaged,
} from "../platform/paged-maintenance.mjs";

async function setup(work, { encrypted = false } = {}) {
  const f = fixture(),
    repo = path.join(f.base, "paged"),
    environment = encrypted
      ? { ...process.env, MOONRESTORE_PASSWORD: "synthetic-password-only-0.8" }
      : process.env;
  try {
    await PagedStore.create(repo, { encrypted, environment });
    await work({ ...f, paged: repo, environment });
  } finally {
    f.cleanup();
  }
}

test("controlled disk errors never replace the old root or publish an incomplete restore", () =>
  setup(async (f) => {
    put(f.source, "value", "previous verified data");
    const first = await backupPaged(f.paged, f.source),
      roots = fs.readdirSync(path.join(f.paged, "snapshots")),
      before = process.env.MOONRESTORE_TEST_IO;
    try {
      for (const code of ["ENOSPC", "EIO", "EACCES", "EROFS"]) {
        put(f.source, "value", "new uncommitted data " + code);
        process.env.MOONRESTORE_TEST_IO = code + ":before-root";
        await assert.rejects(
          backupPaged(f.paged, f.source),
          (error) => error.code === code,
        );
        assert.deepEqual(
          fs.readdirSync(path.join(f.paged, "snapshots")),
          roots,
        );
        process.env.MOONRESTORE_TEST_IO = code + ":restore";
        const target = path.join(f.base, "restore-" + code);
        await assert.rejects(
          restorePaged(f.paged, first.snapshot, target),
          (error) => error.code === code,
        );
        assert.equal(fs.existsSync(target), false);
      }
    } finally {
      if (before === undefined) delete process.env.MOONRESTORE_TEST_IO;
      else process.env.MOONRESTORE_TEST_IO = before;
    }
    assert.equal(
      (await verifyPaged(f.paged, first.snapshot)).content_verified,
      true,
    );
  }));
test("correctly hashed but semantically forged pages cannot smuggle case-colliding paths", () =>
  setup(async (f) => {
    put(f.source, "a", "one");
    put(f.source, "b", "two");
    const first = await backupPaged(f.paged, f.source),
      store = await PagedStore.open(f.paged);
    let forged;
    try {
      const root = store.root(first.snapshot),
        page = pageFrom(store, root.last_page);
      assert.equal(root.pages, 1);
      page.records.find((r) => r.kind === "file" && r.path === "b").path = "A";
      store.lock();
      let raw = Buffer.from(JSON.stringify(page)),
        id = store.logical(raw);
      store.write("page", id, raw);
      root.last_page = id;
      raw = Buffer.from(JSON.stringify(root));
      forged = store.logical(raw);
      store.write("snapshot", forged, raw);
    } finally {
      store.close();
    }
    const target = path.join(f.base, "forged-target");
    await assert.rejects(restorePaged(f.paged, forged, target));
    assert.equal(fs.existsSync(target), false);
  }));
test("aged garbage purge is separately confirmed and preserves every published snapshot", () =>
  setup(async (f) => {
    put(f.source, "value", "old");
    const first = await backupPaged(f.paged, f.source);
    await orphan(f);
    const preview = await garbagePaged(f.paged),
      moved = await garbagePaged(f.paged, {
        confirmation: preview.confirmation,
      });
    const manifest = JSON.parse(
        fs.readFileSync(
          path.join(f.paged, "trash", moved.batch, "manifest.json"),
        ),
      ),
      now = manifest.created + 7 * 86400000;
    await assert.rejects(
      purgePaged(f.paged, moved.batch, { confirmation: "wrong", now }),
      /Confirm/,
    );
    assert.equal(
      (
        await purgePaged(f.paged, moved.batch, {
          confirmation: moved.batch,
          now,
        })
      ).snapshots_deleted,
      0,
    );
    assert.equal(
      (await verifyPaged(f.paged, first.snapshot)).content_verified,
      true,
    );
  }));
test("format 4 streams multiple pages, packs and restores directories and exact content", () =>
  setup(async (f) => {
    for (let i = 0; i < 150; i++)
      put(f.source, "folder/file-" + i + ".txt", "shared-content " + (i % 3));
    fs.mkdirSync(path.join(f.source, "empty"));
    put(f.source, "zero", Buffer.alloc(0));
    const result = await backupPaged(f.paged, f.source);
    assert.ok(result.pages >= 3);
    assert.equal(result.entries, 153);
    assert.equal(
      (await verifyPaged(f.paged, result.snapshot)).content_verified,
      true,
    );
    const target = path.join(f.base, "restored");
    const restored = await restorePaged(f.paged, result.snapshot, target);
    assert.equal(restored.independent_disk_readback, true);
    assert.deepEqual(tree(target), tree(f.source));
    await assert.rejects(
      restorePaged(f.paged, result.snapshot, target),
      /New isolated/,
    );
    const again = await backupPaged(f.paged, f.source);
    assert.ok(Number(again.reused_bytes) > 0);
    assert.equal(again.stored_pack_bytes, "0");
  }));
test("encrypted paged records and disk index do not persist names or business plaintext", () =>
  setup(
    async (f) => {
      put(f.source, "private-business-file.txt", "PRIVATE-BUSINESS-BODY");
      const first = await backupPaged(f.paged, f.source, {
        environment: f.environment,
      });
      const store = await PagedStore.open(f.paged, {
          environment: f.environment,
        }),
        index = new PagedIndex(store);
      try {
        indexSnapshot(store, index, first.snapshot);
        for (const folder of ["pages", "packs", "snapshots"])
          for (const name of fs.readdirSync(path.join(f.paged, folder))) {
            const bytes = fs.readFileSync(path.join(f.paged, folder, name));
            assert.equal(
              bytes.includes(Buffer.from("private-business")),
              false,
            );
            assert.equal(
              bytes.includes(Buffer.from("PRIVATE-BUSINESS")),
              false,
            );
          }
        const db = fs.readFileSync(path.join(index.folder, "index.sqlite"));
        assert.equal(db.includes(Buffer.from("private-business-file")), false);
      } finally {
        index.close();
        store.close();
      }
      await restorePaged(
        f.paged,
        first.snapshot,
        path.join(f.base, "restored"),
        { environment: f.environment },
      );
      await assert.rejects(
        PagedStore.open(f.paged, {
          environment: { MOONRESTORE_PASSWORD: "wrong-password-000000" },
        }),
        /unlock/,
      );
    },
    { encrypted: true },
  ));
test("failed new backup never replaces earlier snapshot or publishes an incomplete root", () =>
  setup(async (f) => {
    put(f.source, "a", "first");
    const first = await backupPaged(f.paged, f.source);
    const before = fs.readdirSync(path.join(f.paged, "snapshots"));
    put(f.source, "a", "second");
    const previous = process.env.MOONRESTORE_TEST_FAILURE;
    process.env.MOONRESTORE_TEST_FAILURE = "paged-before-root";
    try {
      await assert.rejects(backupPaged(f.paged, f.source), /Injected/);
    } finally {
      if (previous === undefined) delete process.env.MOONRESTORE_TEST_FAILURE;
      else process.env.MOONRESTORE_TEST_FAILURE = previous;
    }
    assert.deepEqual(fs.readdirSync(path.join(f.paged, "snapshots")), before);
    assert.equal(
      (await verifyPaged(f.paged, first.snapshot)).content_verified,
      true,
    );
  }));
test("bad pack or changed page rejects restore before creating a target", () =>
  setup(async (f) => {
    put(f.source, "a", "must verify before restore");
    const result = await backupPaged(f.paged, f.source),
      pack = path.join(
        f.paged,
        "packs",
        fs.readdirSync(path.join(f.paged, "packs"))[0],
      );
    const bytes = fs.readFileSync(pack);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(pack, bytes);
    const target = path.join(f.base, "must-not-exist");
    await assert.rejects(restorePaged(f.paged, result.snapshot, target));
    assert.equal(fs.existsSync(target), false);
  }));
test("legacy migration reads old snapshots without changing the original repository", async () => {
  const f = fixture();
  try {
    put(f.source, "paper.md", "original legacy data");
    const legacy = backup(f),
      before = tree(f.repo),
      target = path.join(f.base, "new-format");
    const result = await migratePaged(f.repo, legacy.snapshot, target);
    assert.equal(result.legacy_modified, false);
    assert.deepEqual(tree(f.repo), before);
    const restored = path.join(f.base, "recovered");
    await restorePaged(target, result.snapshot, restored);
    assert.deepEqual(tree(restored), tree(f.source));
  } finally {
    f.cleanup();
  }
});

async function fault(stage, work) {
  const previous = process.env.MOONRESTORE_TEST_FAILURE;
  process.env.MOONRESTORE_TEST_FAILURE = "paged-" + stage;
  try {
    await assert.rejects(work, /Injected/);
  } finally {
    if (previous === undefined) delete process.env.MOONRESTORE_TEST_FAILURE;
    else process.env.MOONRESTORE_TEST_FAILURE = previous;
  }
}
async function orphan(f) {
  put(f.source, "value", "uncommitted orphan " + Date.now());
  await fault("before-root", () => backupPaged(f.paged, f.source));
}
test("unreachable packs are quarantined only after a fresh full-root audit; old snapshots remain restorable", () =>
  setup(async (f) => {
    put(f.source, "value", "old protected");
    const first = await backupPaged(f.paged, f.source);
    await orphan(f);
    const preview = await garbagePaged(f.paged);
    assert.ok(preview.candidates >= 2);
    assert.equal(preview.snapshot_pruning, false);
    const moved = await garbagePaged(f.paged, {
      confirmation: preview.confirmation,
    });
    assert.ok(moved.quarantined >= 2);
    assert.equal(moved.permanently_deleted, 0);
    const status = await purgePaged(f.paged, moved.batch);
    assert.equal(status.eligible, false);
    await assert.rejects(
      purgePaged(f.paged, moved.batch, { confirmation: moved.batch }),
      /grace/,
    );
    await restorePaged(f.paged, first.snapshot, path.join(f.base, "restored"));
    assert.equal(
      fs.readFileSync(path.join(f.base, "restored/value"), "utf8"),
      "old protected",
    );
  }));
test("GC crash between link and unlink is rolled back precisely and never resumes a writer blindly", () =>
  setup(async (f) => {
    put(f.source, "value", "old");
    const first = await backupPaged(f.paged, f.source);
    await orphan(f);
    const preview = await garbagePaged(f.paged);
    await fault("gc-linked", () =>
      garbagePaged(f.paged, { confirmation: preview.confirmation }),
    );
    await assert.rejects(backupPaged(f.paged, f.source), /Interrupted/);
    const repoId = fs.readFileSync(path.join(f.paged, "repository-id"), "utf8");
    const recovered = await recoverPaged(f.paged, repoId);
    assert.equal(recovered.maintenance_rolled_back, true);
    assert.equal(fs.existsSync(path.join(f.paged, ".gc-pending.json")), false);
    assert.equal(
      (await verifyPaged(f.paged, first.snapshot)).content_verified,
      true,
    );
    assert.equal(fs.readdirSync(path.join(f.paged, "trash")).length, 0);
  }));
test("GC tokens expire after a new snapshot and active writer locks cannot be stolen", () =>
  setup(async (f) => {
    put(f.source, "value", "old");
    await backupPaged(f.paged, f.source);
    await orphan(f);
    const preview = await garbagePaged(f.paged);
    await backupPaged(f.paged, f.source);
    await assert.rejects(
      garbagePaged(f.paged, { confirmation: preview.confirmation }),
      /expired/,
    );
    const store = await PagedStore.open(f.paged);
    try {
      store.lock();
      await assert.rejects(recoverPaged(f.paged, store.repoId), /still active/);
    } finally {
      store.close();
    }
  }));
test("interrupted immutable publication repairs only an exact owned hardlink alias", () =>
  setup(async (f) => {
    put(f.source, "value", "owned alias");
    await fault("stored-linked", () => backupPaged(f.paged, f.source));
    const temp = path.join(
      f.paged,
      "tmp",
      fs.readdirSync(path.join(f.paged, "tmp"))[0],
    );
    assert.equal(fs.statSync(temp).nlink, 2);
    assert.throws(() => bounded(temp, 8388704), /bounded/);
    const repoId = fs.readFileSync(path.join(f.paged, "repository-id"), "utf8");
    assert.equal(
      (await recoverPaged(f.paged, repoId)).owned_aliases_removed,
      1,
    );
    assert.equal(
      (await backupPaged(f.paged, f.source)).post_commit_verified,
      true,
    );
  }));
test("explicit prefix exclusions are recorded, empty sources work and ignored command options are rejected", () =>
  setup(async (f) => {
    const empty = await backupPaged(f.paged, f.source);
    assert.equal(empty.entries, 0);
    await verifyPaged(f.paged, empty.snapshot);
    put(f.source, "cache/secret", "omit");
    put(f.source, "keep", "keep");
    const snapshot = await backupPaged(f.paged, f.source, {
      excludes: ["cache"],
    });
    const store = await PagedStore.open(f.paged);
    try {
      assert.deepEqual(store.root(snapshot.snapshot).excludes, ["cache"]);
    } finally {
      store.close();
    }
    const target = path.join(f.base, "restored");
    await restorePaged(f.paged, snapshot.snapshot, target);
    assert.deepEqual(Object.keys(tree(target)), ["keep"]);
    await assert.rejects(
      pagedCommand([
        "paged-init",
        path.join(f.base, "ignored"),
        "--exclude",
        "cache",
      ]),
      /Invalid/,
    );
    await assert.rejects(
      backupPaged(f.paged, f.source, { excludes: ["../unsafe"] }),
    );
  }));
test("cached packs are invalidated on disk changes and expansion limits fail closed", () =>
  setup(async (f) => {
    put(f.source, "value", "cache-check");
    const snapshot = await backupPaged(f.paged, f.source),
      store = await PagedStore.open(f.paged),
      index = new PagedIndex(store);
    try {
      indexSnapshot(store, index, snapshot.snapshot);
      const row = index.db.prepare("SELECT k FROM objects LIMIT 1").get(),
        record = index.get("objects", row.k);
      store.chunk(record);
      const file = store.file("pack", record.pack),
        bytes = fs.readFileSync(file);
      bytes.writeUInt32LE(8388609, 5);
      fs.writeFileSync(file, bytes);
      assert.throws(() => store.chunk(record), /expansion/);
    } finally {
      index.close();
      store.close();
    }
  }));
