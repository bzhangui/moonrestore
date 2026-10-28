import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, tree } from "./helpers.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  pageFrom,
} from "../platform/paged-store.mjs";
import { backupPaged } from "../platform/paged-operations.mjs";
import {
  previewPagedRestore,
  restorePagedSelection,
  catalogPaged,
} from "../platform/paged-selection.mjs";
import { core, drill } from "../platform/maintenance.mjs";
import { savePlan, runPlan, assertCleanupGuard } from "../platform/plans.mjs";
import { runEngine } from "../platform/engine-client.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
import { withSignal } from "../platform/activity.mjs";
import { sqliteBackup } from "../platform/applications.mjs";
import { DatabaseSync } from "node:sqlite";
test("SQLite online export into format4 is restored and reopened without raw live-file copy", () =>
  setup(async (f) => {
    const file = path.join(f.source, "db.sqlite"),
      db = new DatabaseSync(file);
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER); INSERT INTO t VALUES(1)",
    );
    try {
      const result = await sqliteBackup(f.paged, file);
      assert.equal(result.post_restore_readback, true);
      assert.equal(result.ok, true);
    } finally {
      db.close();
    }
  }));
async function setup(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    f.paged = path.join(f.base, "paged");
    await PagedStore.create(f.paged);
    await work(f);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("selected restore is complete for its scope; partial rescue never marks damaged files successful", () =>
  setup(async (f) => {
    put(f.source, "a.txt", "healthy");
    await backupPaged(f.paged, f.source);
    put(f.source, "b.txt", "damage-me");
    const b = await backupPaged(f.paged, f.source),
      store = await PagedStore.open(f.paged),
      index = new PagedIndex(store);
    let pack;
    try {
      const r = indexSnapshot(store, index, b.snapshot);
      let file;
      for (let i = 0; i < r.pages; i++)
        for (const row of pageFrom(store, index.get("pages", i).id).records) {
          if (row.kind === "file") file = row.path;
          if (row.kind === "chunk" && file === "b.txt")
            pack = store.file("pack", row.pack);
        }
    } finally {
      index.close();
      store.close();
    }
    const bytes = fs.readFileSync(pack);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(pack, bytes);
    const target = path.join(f.base, "partial");
    await assert.rejects(previewPagedRestore(f.paged, b.snapshot, target));
    assert.equal(fs.existsSync(target), false);
    const preview = await previewPagedRestore(f.paged, b.snapshot, target, {
      partial: true,
    });
    assert.equal(preview.damaged_files, 1);
    assert.equal(preview.complete, false);
    await assert.rejects(
      restorePagedSelection(f.paged, b.snapshot, target, {
        partial: true,
        confirmation: "0".repeat(64),
      }),
    );
    const restored = await restorePagedSelection(f.paged, b.snapshot, target, {
      partial: true,
      confirmation: preview.confirmation,
    });
    assert.equal(restored.ok, false);
    assert.equal(restored.complete, false);
    assert.equal(restored.post_restore_readback, true);
    assert.equal(
      fs.readFileSync(path.join(target, "a.txt"), "utf8"),
      "healthy",
    );
    assert.equal(fs.existsSync(path.join(target, "b.txt")), false);
    const selected = path.join(f.base, "selected"),
      p = await previewPagedRestore(f.paged, b.snapshot, selected, {
        prefixes: ["a.txt"],
      });
    assert.equal(p.complete, true);
    await restorePagedSelection(f.paged, b.snapshot, selected, {
      prefixes: ["a.txt"],
      confirmation: p.confirmation,
    });
    assert.equal(fs.readdirSync(selected).length, 1);
    const catalog = await catalogPaged(f.paged, b.snapshot);
    assert.equal(catalog.content_verified, false);
    assert.equal(catalog.total, 2);
    await assert.rejects(
      previewPagedRestore(f.paged, b.snapshot, path.join(f.base, "unsafe"), {
        prefixes: ["../escape"],
      }),
    );
  }));
test("shared CLI engine, plan verification/drill and background cancellation work for format4", () =>
  setup(async (f) => {
    put(f.source, "中文.txt", "中文读取不能损坏");
    const b = await core(["backup", f.paged, f.source]);
    assert.equal(b.post_commit_verified, true);
    assert.ok(b.started);
    assert.equal((await core(["list", f.paged])).snapshots.length, 1);
    assert.equal(
      (await drill(f.paged, b.snapshot)).post_restore_readback,
      true,
    );
    assert.equal(
      (
        await runEngine("text-preview", {
          repository: f.paged,
          snapshot: b.snapshot,
          path: "中文.txt",
        })
      ).text,
      "中文读取不能损坏",
    );
    const plan = savePlan({
      name: "synthetic paged plan",
      type: "files",
      repository: f.paged,
      source: f.source,
      reserveBytes: 0,
    });
    const done = await runPlan(plan.id);
    assert.ok(done);
    assert.doesNotThrow(() => assertCleanupGuard(f.paged));
    const controller = new AbortController(),
      pending = withSignal(controller.signal, () =>
        runEngine("backup", { repository: f.paged, source: f.source }),
      );
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(fs.existsSync(path.join(f.paged, ".lock")), false);
    assert.equal(
      fs.readdirSync(path.join(process.env.MOONRESTORE_HOME, "control")).length,
      0,
    );
  }));
test("workbench format4 initialization, unlock, preview, selected restore and key export use real HTTP", () =>
  setup(async (f) => {
    const app = await startWorkbench({ port: 0 }),
      repo = path.join(f.base, "secure"),
      password = "synthetic-v09-secret-only";
    const request = async (route, p) => {
      const r = await fetch(app.origin + "/api/" + route, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(p),
      });
      return { status: r.status, body: await r.json() };
    };
    try {
      assert.equal(
        (
          await request("init-encrypted", {
            repository: repo,
            format: 4,
            password,
            confirmation: repo,
          })
        ).status,
        200,
      );
      put(f.source, "a.txt", "private body");
      const b = await core(["backup", repo, f.source], {
        env: { MOONRESTORE_PASSWORD: password },
      });
      const h = await request("snapshots", { repository: repo });
      assert.equal(h.body.snapshots[0].id, b.snapshot);
      assert.equal(h.body.snapshots[0].content_verified, false);
      assert.equal(
        (await request("catalog", { repository: repo, snapshot: b.snapshot }))
          .body.entries.length,
        1,
      );
      const target = path.join(f.base, "http-restore"),
        preview = await request("restore-preview", {
          repository: repo,
          snapshot: b.snapshot,
          target,
          selections: ["a.txt"],
        });
      assert.equal(preview.status, 200);
      assert.equal(
        (
          await request("restore", {
            repository: repo,
            snapshot: b.snapshot,
            target,
            selections: ["a.txt"],
            confirmation: preview.body.confirmation,
          })
        ).body.ok,
        true,
      );
      assert.deepEqual(tree(target), tree(f.source));
      const output = path.join(f.base, "recovery.key");
      assert.equal(
        (
          await request("key-export", {
            repository: repo,
            output,
            confirmation: repo,
          })
        ).status,
        200,
      );
      assert.equal(fs.existsSync(output), true);
      assert.equal(
        (await request("unlock", { repository: repo, password })).status,
        200,
      );
      assert.equal(
        (
          await request("restore-preview", {
            repository: repo,
            snapshot: b.snapshot,
            target: path.join(f.base, "bad"),
            partial: "true",
          })
        ).status,
        400,
      );
    } finally {
      await app.close();
    }
  }));
