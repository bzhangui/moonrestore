import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, call, tree, backup, sha } from "./helpers.mjs";
import {
  createOperation,
  runOperation,
  DurableRecoverySession,
} from "../platform/operations.mjs";
import { Journal, atomicPrivate } from "../platform/journal.mjs";
import { exportArchive, importArchive } from "../platform/archive.mjs";
import { RecoverySession } from "../platform/recovery-target.mjs";

test("unexpected extra files in restore staging are not silently published", () => {
  const f = fixture(),
    target = path.join(f.base, "target"),
    writer = new RecoverySession({ repository: f.repo, target });
  try {
    writer.write("begin_restore", { target });
    writer.write("restore_open", { path: "expected" });
    writer.write("restore_write", {}, Buffer.from("data"));
    writer.write("restore_close", {});
    put(writer.stage, "unexpected", "untrusted");
    assert.throws(() => writer.write("finish_restore", {}), /tree mismatch/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    writer.clean();
    f.cleanup();
  }
});
test("simulated ENOSPC/EACCES/EROFS preserves the last atomic control file and original source", () => {
  const f = fixture();
  try {
    const file = path.join(f.base, "control");
    atomicPrivate(file, Buffer.from("original"));
    const original = fs.writeFileSync;
    for (const code of ["ENOSPC", "EACCES", "EROFS"]) {
      try {
        fs.writeFileSync = () => {
          throw Object.assign(new Error("synthetic disk error"), { code });
        };
        assert.throws(
          () => atomicPrivate(file, Buffer.from("changed")),
          (e) => e.code === code,
        );
      } finally {
        fs.writeFileSync = original;
      }
      assert.equal(fs.readFileSync(file, "utf8"), "original");
    }
  } finally {
    f.cleanup();
  }
});
test("encrypted journal and archive hide private file names; wrong keys and substituted repository identities fail closed", async () => {
  const f = fixture(),
    oldHome = process.env.MOONRESTORE_HOME,
    oldPassword = process.env.MOONRESTORE_PASSWORD;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  process.env.MOONRESTORE_PASSWORD = "synthetic-source-password";
  try {
    const repo = path.join(f.base, "encrypted");
    call(["init-encrypted", repo]);
    put(f.source, "private-name-secret", "sensitive synthetic content");
    const id = await createOperation({ repository: repo, source: f.source });
    await runOperation(repo, id);
    const j = new Journal(repo, id);
    try {
      assert.equal(JSON.parse(fs.readFileSync(j.controlFile)).digest, null);
      assert.equal(
        fs.readFileSync(j.controlFile, "utf8").includes(f.source),
        false,
      );
      const cache = fs.readdirSync(path.join(j.root, "files"));
      assert.notEqual(cache[0], sha("private-name-secret") + ".json");
      assert.equal(
        fs
          .readFileSync(path.join(j.root, "files", cache[0]), "utf8")
          .includes("private-name-secret"),
        false,
      );
    } finally {
      j.close();
    }
    const archive = path.join(f.base, "archive"),
      r = await exportArchive(repo, archive),
      dest = path.join(f.base, "import");
    await importArchive(archive, r.checksum, dest);
    process.env.MOONRESTORE_PASSWORD = "wrong-synthetic-password";
    assert.throws(() => new Journal(repo, id));
    process.env.MOONRESTORE_PASSWORD = "synthetic-source-password";
    fs.writeFileSync(path.join(repo, "repository-id"), "different-repository");
    const replacement = new Journal(repo, id);
    try {
      assert.throws(() => replacement.load(), /identity/);
    } finally {
      replacement.close();
    }
  } finally {
    if (oldHome === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = oldHome;
    if (oldPassword === undefined) delete process.env.MOONRESTORE_PASSWORD;
    else process.env.MOONRESTORE_PASSWORD = oldPassword;
    f.cleanup();
  }
});
test("recovery writer disk failure retains unpublished prefix and can safely resume without modifying repository", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    put(f.source, "a", "synthetic data");
    const b = backup(f),
      before = tree(f.repo),
      target = path.join(f.base, "restore"),
      id = await createOperation({
        repository: f.repo,
        snapshot: b.snapshot,
        target,
      }),
      j = new Journal(f.repo, id);
    try {
      const c = j.load();
      c.state = "running";
      j.save(c);
    } finally {
      j.close();
    }
    const writer = new DurableRecoverySession(f.repo, id);
    writer.write("begin_restore", { target });
    writer.write("restore_open", { path: "a" });
    const original = fs.writeSync;
    try {
      fs.writeSync = () => {
        throw Object.assign(new Error("synthetic full disk"), {
          code: "ENOSPC",
        });
      };
      assert.throws(
        () => writer.write("restore_write", {}, Buffer.from("synthetic data")),
        (e) => e.code === "ENOSPC",
      );
    } finally {
      fs.writeSync = original;
      writer.clean();
    }
    assert.equal(fs.existsSync(target), false);
    const reset = new Journal(f.repo, id);
    try {
      const c = reset.load();
      c.state = "failed";
      reset.save(c);
    } finally {
      reset.close();
    }
    assert.equal((await runOperation(f.repo, id)).ok, true);
    assert.deepEqual(tree(f.repo), before);
    assert.deepEqual(tree(f.source), tree(target));
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
