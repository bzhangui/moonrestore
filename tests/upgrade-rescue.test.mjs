import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, project, sha, call, tree } from "./helpers.mjs";
import {
  createRescueKit,
  checkRescueKit,
  restoreWithRescueKit,
} from "../platform/rescue-kit.mjs";
import { verifyDistribution } from "../platform/distribution.mjs";
import { withSignal } from "../platform/activity.mjs";
import { Host } from "../platform/adapter.mjs";
function runtime(f) {
  const dir = path.join(f.base, "bundle");
  fs.mkdirSync(dir);
  const files = [
    "bin/moonrestore.mjs",
    "bin/sqlite-export.mjs",
    "_build/js/release/build/cmd/main/main.js",
    "LICENSE",
    "NOTICE",
    ...fs
      .readdirSync(path.join(project, "platform"))
      .filter((n) => n.endsWith(".mjs"))
      .map((n) => "platform/" + n),
  ];
  if (process.platform !== "win32") files.push("_build/host/rename_noreplace");
  const hashes = {};
  for (const rel of files) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(project, rel), dest);
    hashes[rel] = sha(fs.readFileSync(dest));
  }
  const pkg = JSON.stringify({ type: "module" });
  fs.writeFileSync(path.join(dir, "package.json"), pkg);
  hashes["package.json"] = sha(pkg);
  const bytes = JSON.stringify({
    format: 1,
    version: "0.6.0",
    platform: process.platform,
    arch: process.arch,
    files: hashes,
  });
  fs.writeFileSync(path.join(dir, "manifest.json"), bytes);
  return { dir, hash: sha(bytes) };
}
test("offline kit restores a moved repository using fresh state without original jobs/indexes and refuses tampering", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "original-state");
  try {
    put(f.source, "中文资料/a.txt", "recover independently");
    fs.mkdirSync(path.join(f.source, "empty"));
    const b = backup(f),
      bundle = runtime(f),
      kit = path.join(f.base, "rescue-kit"),
      r = await createRescueKit(
        f.repo,
        b.snapshot,
        bundle.dir,
        bundle.hash,
        kit,
      );
    assert.equal(r.key_included, false);
    const recipe = fs.readFileSync(path.join(kit, "recovery.json"), "utf8");
    assert.equal(recipe.includes(f.base), false);
    assert.throws(
      () => checkRescueKit(kit, "0".repeat(64), f.repo),
      /recipe hash/,
    );
    const copy = path.join(f.base, "moved-repository");
    fs.renameSync(f.repo, copy);
    process.env.MOONRESTORE_HOME = path.join(f.base, "new-computer-state");
    assert.equal(
      checkRescueKit(kit, r.recipe_sha256, copy).content_verified,
      false,
    );
    const target = path.join(f.base, "independent-restore"),
      sourceBefore = tree(copy);
    const restored = await restoreWithRescueKit(
      kit,
      r.recipe_sha256,
      copy,
      target,
    );
    assert.equal(restored.post_restore_readback, true);
    assert.deepEqual(tree(target), tree(f.source));
    assert.deepEqual(tree(copy), sourceBefore);
    await assert.rejects(
      () => restoreWithRescueKit(kit, r.recipe_sha256, copy, target),
      /must not exist/,
    );
    fs.appendFileSync(path.join(kit, "bin/moonrestore.mjs"), "\n// tampering");
    assert.throws(() => checkRescueKit(kit, r.recipe_sha256, copy), /checksum/);
    assert.throws(
      () => verifyDistribution(bundle.dir, "0".repeat(64)),
      /manifest hash/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("encrypted offline kit excludes passwords/keys and needs separately supplied unlock material", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME,
    previousPassword = process.env.MOONRESTORE_PASSWORD;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private-state");
  process.env.MOONRESTORE_PASSWORD = "synthetic-encrypted-rescue-only";
  try {
    const repo = path.join(f.base, "encrypted");
    call(["init-encrypted", repo]);
    put(f.source, "a", "secret synthetic contents");
    const b = call(["backup", repo, f.source]),
      bundle = runtime(f),
      kit = path.join(f.base, "kit"),
      r = await createRescueKit(repo, b.snapshot, bundle.dir, bundle.hash, kit);
    const recipe = fs.readFileSync(path.join(kit, "recovery.json"), "utf8");
    assert.equal(recipe.includes(process.env.MOONRESTORE_PASSWORD), false);
    process.env.MOONRESTORE_HOME = path.join(f.base, "clean-state");
    delete process.env.MOONRESTORE_PASSWORD;
    await assert.rejects(
      () =>
        restoreWithRescueKit(
          kit,
          r.recipe_sha256,
          repo,
          path.join(f.base, "missing-key"),
        ),
      /incomplete/,
    );
    process.env.MOONRESTORE_PASSWORD = "synthetic-encrypted-rescue-only";
    assert.equal(
      (
        await restoreWithRescueKit(
          kit,
          r.recipe_sha256,
          repo,
          path.join(f.base, "recovered"),
        )
      ).ok,
      true,
    );
    fs.appendFileSync(path.join(repo, "encryption.json"), " ");
    assert.throws(() => checkRescueKit(kit, r.recipe_sha256, repo), /identity/);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    if (previousPassword === undefined) delete process.env.MOONRESTORE_PASSWORD;
    else process.env.MOONRESTORE_PASSWORD = previousPassword;
    f.cleanup();
  }
});

test("distribution preflight rejects traversal, unknown digests, excess files, hardlinks and oversized members before execution", () => {
  const f = fixture();
  try {
    const b = runtime(f),
      manifestFile = path.join(b.dir, "manifest.json"),
      original = fs.readFileSync(manifestFile),
      m = JSON.parse(original);
    for (const [name, value] of [
      ["../outside", "0".repeat(64)],
      ["/absolute", "0".repeat(64)],
      ["a\\b", "0".repeat(64)],
      ["a", "not-a-hash"],
    ]) {
      fs.writeFileSync(
        manifestFile,
        JSON.stringify({ ...m, files: { ...m.files, [name]: value } }),
      );
      assert.throws(() => verifyDistribution(b.dir));
    }
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        ...m,
        files: {
          ...m.files,
          ...Object.fromEntries(
            Array.from({ length: 129 }, (_, i) => [
              "extra-" + i,
              "0".repeat(64),
            ]),
          ),
        },
      }),
    );
    assert.throws(() => verifyDistribution(b.dir), /manifest/);
    fs.writeFileSync(manifestFile, original);
    const member = path.join(b.dir, "NOTICE"),
      link = path.join(f.base, "hardlink");
    fs.linkSync(member, link);
    assert.throws(() => verifyDistribution(b.dir), /budget/);
    fs.unlinkSync(link);
    fs.truncateSync(member, 16777217);
    assert.throws(() => verifyDistribution(b.dir), /budget/);
  } finally {
    f.cleanup();
  }
});

test("offline rescue cancellation reaches its inner worker and returns only after it stops", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "cancellation-state");
  try {
    put(f.source, "large.bin", Buffer.alloc(32 * 1024 * 1024, 6));
    const b = backup(f),
      bundle = runtime(f),
      kit = path.join(f.base, "cancel-kit"),
      r = await createRescueKit(
        f.repo,
        b.snapshot,
        bundle.dir,
        bundle.hash,
        kit,
      ),
      before = tree(f.repo),
      target = path.join(f.base, "cancelled-output"),
      controller = new AbortController();
    let observedWorker = false;
    const sessions = path.join(process.env.MOONRESTORE_HOME, "rescue-sessions");
    const watch = setInterval(() => {
      try {
        if (!fs.existsSync(sessions)) return;
        for (const session of fs.readdirSync(sessions)) {
          const operations = path.join(sessions, session, "operations");
          if (!fs.existsSync(operations)) continue;
          for (const op of fs.readdirSync(operations)) {
            if (fs.existsSync(path.join(operations, op, "worker.lock"))) {
              observedWorker = true;
              controller.abort();
              return;
            }
          }
        }
      } catch {
        /* Creation/removal races are rechecked on the next tick. */
      }
    }, 10);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      await assert.rejects(
        () =>
          withSignal(controller.signal, () =>
            restoreWithRescueKit(kit, r.recipe_sha256, f.repo, target),
          ),
        /incomplete|cancelled/,
      );
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
    }
    assert.equal(
      observedWorker,
      true,
      "must cancel a real inner worker, not only its parent startup",
    );
    assert.equal(fs.existsSync(target), false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(fs.existsSync(target), false); // Not published by an orphan after return.
    assert.deepEqual(tree(f.repo), before);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      () =>
        withSignal(cancelled.signal, () =>
          restoreWithRescueKit(kit, r.recipe_sha256, f.repo, target),
        ),
      /cancelled/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});

test("recovery worker fails closed on cancelled/missing control or dead coordinator identity", () => {
  const f = fixture();
  try {
    const control = path.join(
        f.base,
        "parent-control-12345678-1234-4123-8123-123456789abc.json",
      ),
      host = new Host({ environment: { MOONRESTORE_PARENT_CONTROL: control } });
    fs.writeFileSync(
      control,
      JSON.stringify({ cancel: false, parent_pid: process.pid }),
    );
    host.pulse("alive", true);
    host.parentPid = 2147483647;
    assert.throws(() => host.pulse("orphan", true), /parent/);
    host.parentPid = process.ppid;
    fs.writeFileSync(
      control,
      JSON.stringify({ cancel: true, parent_pid: process.pid }),
    );
    assert.throws(() => host.pulse("cancelled", true), /cancelled/);
    fs.unlinkSync(control);
    assert.throws(() => host.pulse("missing", true));
    host.clean();
  } finally {
    f.cleanup();
  }
});
