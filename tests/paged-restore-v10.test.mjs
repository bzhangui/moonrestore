import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fixture, put, randomBytes, tree, project, call } from "./helpers.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
} from "../platform/paged-store.mjs";
import { backupPaged, verifyPaged } from "../platform/paged-operations.mjs";
import {
  createPagedRestore,
  runPagedRestore,
  pagedRestoreStatus,
} from "../platform/paged-restore.mjs";
import { PrivateOperation } from "../platform/private-operation.mjs";
import { withSignal } from "../platform/activity.mjs";
import { restorePlan } from "../platform/explorer.mjs";
import {
  captureNative,
  validateFidelity,
  fidelityRecord,
  prepareSparse,
} from "../platform/fidelity.mjs";
import { copyPaged, rebuildPaged } from "../platform/paged-copy.mjs";
import { garbagePaged } from "../platform/paged-maintenance.mjs";
import {
  previewPagedRestore,
  restorePagedSelection,
} from "../platform/paged-selection.mjs";
test(
  "Windows effective ACL normalizer retains permissions, rejects deny-after-allow and never erases an extra grant",
  { skip: process.platform !== "win32" },
  () =>
    setup(async (f) => {
      put(f.source, "acl.txt", "synthetic");
      const file = path.join(f.source, "acl.txt"),
        helper = path.join(project, "_build/host/fidelity.exe");
      const norm = (acl) =>
        spawnSync(helper, [], {
          input: JSON.stringify({
            action: "acl-normalize",
            path: file,
            metadata: { acl },
          }),
          encoding: "utf8",
        });
      const a = norm("O:SYG:SYD:AI(A;ID;FR;;;WD)(A;ID;FW;;;SY)"),
        b = norm("O:SYG:SYD:P(A;;FW;;;SY)(A;;FR;;;WD)");
      assert.equal(a.status, 0);
      assert.equal(b.status, 0);
      assert.equal(JSON.parse(a.stdout).result, JSON.parse(b.stdout).result);
      const extra = norm("O:SYG:SYD:P(A;;FW;;;SY)(A;;FRFW;;;WD)");
      assert.equal(extra.status, 0);
      assert.notEqual(
        JSON.parse(extra.stdout).result,
        JSON.parse(a.stdout).result,
      );
      for (const sddl of ["O:SYG:SY", "O:SYG:SYD:P(A;;FR;;;WD)(D;;FW;;;WD)"])
        assert.notEqual(norm(sddl).status, 0);
    }),
);

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
function crash(repo, id, stage) {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {runPagedRestore} from './platform/paged-restore.mjs'; await runPagedRestore(process.argv[1],process.argv[2]);`,
      repo,
      id,
    ],
    {
      cwd: project,
      env: { ...process.env, MOONRESTORE_TEST_CRASH: "paged-" + stage },
      encoding: "utf8",
      timeout: 90000,
    },
  );
  assert.equal(r.status, 86, r.stdout + r.stderr);
}
async function state(repo, id) {
  const s = await PagedStore.open(repo),
    j = new PrivateOperation(s, id);
  try {
    return { head: j.read("head"), file: j.file("head") };
  } finally {
    j.close();
    s.close();
  }
}
test("format4 restore survives real worker exit before/after checkpoints, file move and root publication", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "folder/data.bin", randomBytes(524288));
    put(f.source, "empty", "");
    const b = await backupPaged(repo, f.source);
    for (const stage of [
      "restore-written",
      "restore-checkpoint",
      "restore-file-published",
      "restore-after-publish",
      "restore-before-publish",
      "restore-directory",
      "restore-work-created",
      "restore-receipt",
    ]) {
      const target = path.join(f.base, stage),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
        });
      crash(repo, op.operation, stage);
      await assert.rejects(runPagedRestore(repo, op.operation), /recovery/);
      const result = await runPagedRestore(repo, op.operation, {
        recover: true,
      });
      const after = await state(repo, op.operation);
      assert.deepEqual(
        fs.readdirSync(path.join(after.head.stage, "work")),
        [],
        stage,
      );
      assert.equal(result.post_restore_readback, true);
      assert.deepEqual(tree(target), tree(f.source));
      assert.equal((await runPagedRestore(repo, op.operation)).complete, true);
    }
  }));

test("durable uncheckpointed partial tail is verified/adopted; shorter-than-checkpoint or oversized work is refused", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(524288));
    const b = await backupPaged(repo, f.source);
    for (const fault of ["valid-tail", "short-checkpoint", "oversize"]) {
      const target = path.join(f.base, fault),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
        });
      crash(
        repo,
        op.operation,
        fault === "short-checkpoint" ? "restore-checkpoint" : "restore-written",
      );
      const { head } = await state(repo, op.operation),
        file = path.join(head.stage, "work", head.active.temporary),
        size = fs.statSync(file).size;
      fs.truncateSync(
        file,
        fault === "oversize" ? 524289 : Math.floor(size / 2),
      );
      if (fault === "valid-tail") {
        assert.equal(
          (await runPagedRestore(repo, op.operation, { recover: true }))
            .complete,
          true,
        );
        assert.deepEqual(tree(target), tree(f.source));
      } else {
        await assert.rejects(
          runPagedRestore(repo, op.operation, { recover: true }),
        );
        assert.equal(fs.existsSync(target), false);
      }
    }
  }));

test("IO failures at write/checkpoint/publication boundaries never publish false success and can safely retry", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(262144));
    const b = await backupPaged(repo, f.source);
    for (const code of ["ENOSPC", "EIO", "EACCES", "EROFS"]) {
      const target = path.join(f.base, code),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
        });
      process.env.MOONRESTORE_TEST_IO = code + ":restore-written";
      try {
        await assert.rejects(
          runPagedRestore(repo, op.operation),
          (e) => e.code === code,
        );
      } finally {
        delete process.env.MOONRESTORE_TEST_IO;
      }
      assert.equal(
        (await pagedRestoreStatus(repo, op.operation)).complete,
        false,
      );
      assert.equal(fs.existsSync(target), false);
      assert.equal((await runPagedRestore(repo, op.operation)).complete, true);
      assert.deepEqual(tree(target), tree(f.source));
    }
  }));

test("a short write followed by real adapter error leaves a verifiable prefix; checkpoint persistence error is recoverable", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    const bytes = randomBytes(262144);
    put(f.source, "data", bytes);
    const b = await backupPaged(repo, f.source);
    const target = path.join(f.base, "short"),
      op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
      }),
      original = fs.writeSync;
    let hit = false;
    fs.writeSync = function (fd, buffer, offset, length, position) {
      if (
        Buffer.isBuffer(buffer) &&
        buffer.length > 10000 &&
        buffer.subarray(0, 16).equals(bytes.subarray(0, 16))
      ) {
        if (hit)
          throw Object.assign(new Error("synthetic disk failure"), {
            code: "ENOSPC",
          });
        hit = true;
        return original.call(
          fs,
          fd,
          buffer,
          offset,
          Math.min(length, 1234),
          position,
        );
      }
      return original.apply(fs, arguments);
    };
    try {
      await assert.rejects(runPagedRestore(repo, op.operation), /disk failure/);
    } finally {
      fs.writeSync = original;
    }
    assert.equal(hit, true);
    assert.equal((await runPagedRestore(repo, op.operation)).complete, true);
    assert.deepEqual(tree(target), tree(f.source));
    const target2 = path.join(f.base, "journal"),
      op2 = await createPagedRestore(repo, b.snapshot, target2, {
        confirmation: target2,
      }),
      save = PrivateOperation.prototype.save;
    let failed = false;
    PrivateOperation.prototype.save = function (name, value) {
      if (name === "head" && BigInt(value.active?.offset ?? "0") > 0n) {
        failed = true;
        throw new Error("synthetic checkpoint failure");
      }
      return save.call(this, name, value);
    };
    try {
      await assert.rejects(
        runPagedRestore(repo, op2.operation),
        /checkpoint failure/,
      );
    } finally {
      PrivateOperation.prototype.save = save;
    }
    assert.equal(failed, true);
    assert.equal(fs.existsSync(target2), false);
    assert.equal((await runPagedRestore(repo, op2.operation)).complete, true);
  }));

test("work inode replacement, active/foreign leases, changed parent, and post-publication corruption fail closed", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(131072));
    const b = await backupPaged(repo, f.source);
    for (const fault of ["inode", "active", "foreign", "parent", "published"]) {
      const parent = path.join(f.base, "parent-" + fault);
      fs.mkdirSync(parent);
      const target = path.join(parent, "new"),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
        });
      if (fault === "published") {
        await runPagedRestore(repo, op.operation);
        fs.writeFileSync(path.join(target, "data"), "changed");
        await assert.rejects(runPagedRestore(repo, op.operation));
        assert.equal(
          fs.readFileSync(path.join(target, "data"), "utf8"),
          "changed",
        );
        continue;
      }
      crash(repo, op.operation, "restore-checkpoint");
      const { head } = await state(repo, op.operation);
      if (fault === "inode") {
        const file = path.join(head.stage, "work", head.active.temporary);
        fs.renameSync(file, file + ".old");
        fs.copyFileSync(file + ".old", file);
      }
      if (fault === "parent") {
        fs.renameSync(parent, parent + "-old");
        fs.mkdirSync(parent);
      }
      if (fault === "active" || fault === "foreign") {
        const s = await PagedStore.open(repo),
          j = new PrivateOperation(s, op.operation);
        try {
          const file = path.join(j.folder, ".lock", "owner.json"),
            owner = JSON.parse(fs.readFileSync(file));
          owner.pid = process.pid;
          if (fault === "foreign") owner.host = "foreign-test-host";
          fs.writeFileSync(file, JSON.stringify(owner));
        } finally {
          j.close();
          s.close();
        }
      }
      await assert.rejects(
        runPagedRestore(repo, op.operation, { recover: true }),
      );
      assert.equal(fs.existsSync(target), false);
    }
  }));

test("cooperative cancellation retains a verified private prefix and a later explicit run completes", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(262144));
    const b = await backupPaged(repo, f.source),
      target = path.join(f.base, "cancelled"),
      op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
      }),
      abort = new AbortController(),
      fail = PagedStore.prototype.fail;
    PagedStore.prototype.fail = function (stage) {
      if (stage === "restore-checkpoint") abort.abort();
      return fail.call(this, stage);
    };
    try {
      await assert.rejects(
        withSignal(abort.signal, () => runPagedRestore(repo, op.operation)),
        /cancelled/,
      );
    } finally {
      PagedStore.prototype.fail = fail;
    }
    assert.equal(fs.existsSync(target), false);
    assert.equal(
      (await pagedRestoreStatus(repo, op.operation)).complete,
      false,
    );
    assert.equal((await runPagedRestore(repo, op.operation)).complete, true);
    assert.deepEqual(tree(target), tree(f.source));
  }));

test("normal CLI format5 backup, native restore and operation replay run through the shared worker", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "fidelity"),
      target = path.join(f.base, "native");
    call(["fidelity-init", repo]);
    put(f.source, "file.txt", "shared-worker synthetic bytes");
    const b = call(["backup", repo, f.source]);
    assert.equal(b.format, 5);
    const r = call([
      "restore-resumable",
      repo,
      b.snapshot,
      target,
      "--permissions",
    ]);
    assert.equal(r.metadata_profile_verified, true);
    assert.equal(call(["paged-restore-run", repo, r.operation]).complete, true);
    assert.deepEqual(tree(target), tree(f.source));
  }));
test("tampering with staged prefix, authentication, identity or target never authorizes overwriting", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(524288));
    const b = await backupPaged(repo, f.source),
      target = path.join(f.base, "restored"),
      op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
      });
    crash(repo, op.operation, "restore-checkpoint");
    const { head, file } = await state(repo, op.operation),
      partial = path.join(head.stage, "work", head.active.temporary),
      bad = fs.readFileSync(partial);
    bad[0] ^= 1;
    fs.writeFileSync(partial, bad);
    await assert.rejects(
      runPagedRestore(repo, op.operation, { recover: true }),
      /prefix/,
    );
    assert.deepEqual(fs.readFileSync(partial), bad);
    assert.equal(fs.existsSync(target), false);
    const r = JSON.parse(fs.readFileSync(file));
    r.mac = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(r));
    await assert.rejects(
      runPagedRestore(repo, op.operation, { recover: true }),
      /authentication/,
    );
  }));
test("unplanned entries, external hardlinks and source corruption block continuation", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "data", randomBytes(262144));
    const b = await backupPaged(repo, f.source);
    for (const fault of ["unexpected", "hardlink", "target", "source"]) {
      const target = path.join(f.base, fault + "-target"),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
        });
      crash(repo, op.operation, "restore-checkpoint");
      const { head } = await state(repo, op.operation),
        part = path.join(head.stage, "work", head.active.temporary);
      if (fault === "unexpected")
        put(path.join(head.stage, "tree"), "foreign", "must retain");
      if (fault === "hardlink")
        fs.linkSync(part, path.join(f.base, "external-link"));
      if (fault === "target") fs.mkdirSync(target);
      if (fault === "source") {
        const pack = path.join(
          repo,
          "packs",
          fs.readdirSync(path.join(repo, "packs"))[0],
        );
        fs.writeFileSync(pack, "broken");
      }
      await assert.rejects(
        runPagedRestore(repo, op.operation, { recover: true }),
      );
      if (fault === "hardlink")
        fs.unlinkSync(path.join(f.base, "external-link"));
    }
  }));
test("native format5 captures and restores attributes, streams/xattrs, hardlinks and precise times without changing format4", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "fidelity");
    await PagedStore.create(repo, { fidelity: true });
    put(f.source, "文本.txt", "exact content");
    fs.mkdirSync(path.join(f.source, "empty-dir"));
    const file = path.join(f.source, "文本.txt");
    fs.linkSync(file, path.join(f.source, "alias.txt"));
    if (process.platform === "win32")
      fs.writeFileSync(
        file + ":Zone.Identifier",
        "[ZoneTransfer]\r\nZoneId=3\r\n",
      );
    else {
      const helper = path.join(project, "_build/host/fidelity");
      assert.equal(
        spawnSync(helper, [
          "xattr",
          file,
          Buffer.from(
            process.platform === "darwin"
              ? "com.moonrestore.test"
              : "user.moonrestore",
          ).toString("hex"),
          Buffer.from("synthetic attribute").toString("hex"),
        ]).status,
        0,
      );
    }
    const original = captureNative(file),
      b = await backupPaged(repo, f.source);
    await verifyPaged(repo, b.snapshot);
    const target = path.join(f.base, "native");
    await assert.rejects(
      createPagedRestore(repo, b.snapshot, target, { confirmation: target }),
      /permissions/,
    );
    const op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
        metadataMode: "native",
        permissions: true,
      }),
      r = await runPagedRestore(repo, op.operation);
    assert.equal(r.metadata_profile_verified, true);
    assert.equal(r.all_filesystem_metadata_preserved, false);
    assert.deepEqual(tree(target), tree(f.source));
    assert.equal(
      fs.statSync(path.join(target, "文本.txt")).ino,
      fs.statSync(path.join(target, "alias.txt")).ino,
    );
    const actual = captureNative(path.join(target, "文本.txt"));
    if (process.platform === "win32") {
      assert.ok(
        r.metadata_losses.includes(
          "windows_acl_inheritance_frozen_original_descriptor_archived",
        ),
      );
      assert.match(actual.acl, /D:P/);
      // Effective ACL/owner/group equality is verified by the trusted helper;
      // inheritance provenance is explicitly normalized, not claimed identical.
      actual.acl = original.acl;
    }
    assert.deepEqual(actual, original);
  }));

test(
  "macOS descriptor security distinguishes absent ACL from populated ACL and restores explicit entries",
  { skip: process.platform !== "darwin" },
  () =>
    setup(async (f) => {
      const repo = path.join(f.base, "fidelity");
      await PagedStore.create(repo, { fidelity: true });
      put(f.source, "explicit.txt", "ACL synthetic fixture");
      const file = path.join(f.source, "explicit.txt"),
        empty = captureNative(file).acl;
      assert.equal(typeof empty, "string");
      assert.match(empty, /^!#acl /);
      const change = spawnSync(
        "/bin/chmod",
        ["+a", `user:${os.userInfo().username} allow read,write`, file],
        { encoding: "utf8" },
      );
      assert.equal(
        change.status,
        0,
        "Cannot set an explicit ACL on owned synthetic fixture",
      );
      const populated = captureNative(file).acl;
      assert.notEqual(populated, empty);
      const b = await backupPaged(repo, f.source),
        target = path.join(f.base, "native-acl"),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
          permissions: true,
        });
      assert.equal(
        (await runPagedRestore(repo, op.operation)).metadata_profile_verified,
        true,
      );
      assert.equal(
        captureNative(path.join(target, "explicit.txt")).acl,
        populated,
      );
      assert.equal(spawnSync("/bin/chmod", ["-N", file]).status, 0);
      assert.equal(captureNative(file).acl, empty);
    }),
);

test("format5 native interruption, sparse holes, read-only attributes, empty source and selected hardlink subset", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "fidelity");
    await PagedStore.create(repo, { fidelity: true });
    put(f.source, "hole.bin", "x");
    const file = path.join(f.source, "hole.bin");
    const sparse = { native: { sparse: true } };
    prepareSparse(file, sparse);
    const fd = fs.openSync(file, "r+");
    fs.ftruncateSync(fd, 4 * 1024 * 1024 + 19);
    fs.writeSync(fd, Buffer.from("tail"), 0, 4, 4 * 1024 * 1024);
    fs.closeSync(fd);
    const sourceSparse = captureNative(file).sparse;
    if (process.platform === "darwin" && !sourceSparse)
      console.log(
        "macOS sparse API reported conservative data ranges; content/reported extents checked, not physical hole preservation",
      );
    put(f.source, "nested/readonly.txt", "read only");
    if (process.platform === "win32")
      assert.equal(
        spawnSync("attrib", ["+R", path.join(f.source, "nested/readonly.txt")])
          .status,
        0,
      );
    else fs.chmodSync(path.join(f.source, "nested/readonly.txt"), 0o440);
    fs.linkSync(file, path.join(f.source, "alias.bin"));
    const b = await backupPaged(repo, f.source);
    for (const stage of [
      "restore-checkpoint",
      "restore-metadata-applied",
      "restore-after-publish",
    ]) {
      const target = path.join(f.base, stage),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
          permissions: true,
        });
      crash(repo, op.operation, stage);
      const restored = await runPagedRestore(repo, op.operation, {
        recover: true,
      });
      assert.equal(restored.metadata_profile_verified, true);
      assert.deepEqual(tree(target), tree(f.source));
      assert.equal(
        captureNative(path.join(target, "hole.bin")).sparse,
        sourceSparse,
      );
    }
    const target = path.join(f.base, "subset"),
      op = await createPagedRestore(repo, b.snapshot, target, {
        confirmation: target,
        permissions: true,
        prefixes: ["alias.bin"],
      });
    await runPagedRestore(repo, op.operation);
    assert.equal(fs.statSync(path.join(target, "alias.bin")).nlink, 1);
    assert.deepEqual(fs.readdirSync(target), ["alias.bin"]);
    const empty = path.join(f.base, "empty-source");
    fs.mkdirSync(empty);
    const eb = await backupPaged(repo, empty),
      et = path.join(f.base, "empty-target"),
      eo = await createPagedRestore(repo, eb.snapshot, et, {
        confirmation: et,
        permissions: true,
      });
    assert.equal(
      (await runPagedRestore(repo, eo.operation)).metadata_profile_verified,
      true,
    );
    assert.deepEqual(fs.readdirSync(et), []);
  }));

test("format5 is encrypted, copies retain metadata pages, GC keeps all live metadata, and lossy fallback must be explicit", () =>
  setup(async (f) => {
    const saved = process.env.MOONRESTORE_PASSWORD;
    process.env.MOONRESTORE_PASSWORD = "synthetic-fidelity-password-123";
    try {
      const repo = path.join(f.base, "encrypted");
      await PagedStore.create(repo, { fidelity: true, encrypted: true });
      put(f.source, "private-name.txt", "private synthetic contents");
      const b = await backupPaged(repo, f.source);
      assert.equal(b.format, 5);
      const target = path.join(f.base, "restored"),
        op = await createPagedRestore(repo, b.snapshot, target, {
          confirmation: target,
          metadataMode: "portable",
        });
      const { file } = await state(repo, op.operation);
      assert.equal(
        fs.readFileSync(file, "utf8").includes("private-name"),
        false,
      );
      for (const name of fs.readdirSync(path.join(repo, "pages")))
        assert.equal(
          fs
            .readFileSync(path.join(repo, "pages", name))
            .includes(Buffer.from("private-name")),
          false,
        );
      const before = fs.readdirSync(path.join(repo, "pages")).sort(),
        gc = await garbagePaged(repo);
      assert.equal(gc.candidates, 0);
      assert.deepEqual(fs.readdirSync(path.join(repo, "pages")).sort(), before);
      const replica = path.join(f.base, "replica");
      await copyPaged(repo, replica);
      assert.equal((await verifyPaged(replica, b.snapshot)).format, 5);
      const rebuilt = await rebuildPaged(repo, path.join(f.base, "rebuild"), {
        encrypted: false,
      });
      assert.equal(rebuilt.archived_metadata_bytes_preserved, true);
      assert.equal(rebuilt.plaintext_staging_used, false);
      await verifyPaged(path.join(f.base, "rebuild"), rebuilt.mapping[0].to);
      const p = await previewPagedRestore(replica, b.snapshot, target, {
        metadataMode: "portable",
      });
      await assert.rejects(
        restorePagedSelection(replica, b.snapshot, target, {
          metadataMode: "native",
          permissions: true,
          confirmation: p.confirmation,
        }),
        /re-preview/,
      );
      const rr = await runPagedRestore(repo, op.operation);
      assert.equal(rr.complete, true);
      assert.equal(rr.metadata_profile_verified, false);
      assert.ok(rr.metadata_losses.length > 0);
      assert.deepEqual(tree(target), tree(f.source));
      const cliTarget = path.join(f.base, "cli-restored");
      assert.equal(
        call([
          "restore-resumable",
          replica,
          b.snapshot,
          cliTarget,
          "--metadata",
          "portable",
        ]).complete,
        true,
      );
    } finally {
      if (saved === undefined) delete process.env.MOONRESTORE_PASSWORD;
      else process.env.MOONRESTORE_PASSWORD = saved;
    }
  }));

test("metadata validation rejects unbounded/ambiguous payloads and manifest semantic corruption even with valid new hashes", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "fidelity");
    await PagedStore.create(repo, { fidelity: true });
    put(f.source, "one", "one");
    const b = await backupPaged(repo, f.source),
      store = await PagedStore.open(repo),
      index = new PagedIndex(store);
    try {
      const root = indexSnapshot(store, index, b.snapshot),
        sample = fidelityRecord(index, "one");
      for (const mutate of [
        (r) => (r.path = "../escape"),
        (r) => (r.mode = 4096),
        (r) => (r.uid = -1),
        (r) => (r.atime_ns = "NaN"),
        (r) => (r.atime_ns = "-0"),
        (r) => (r.native.sparse = "true"),
        (r) => (r.native.unrecognized = true),
        (r) =>
          (r.native.ranges = [
            ["2", "1"],
            ["1", "1"],
          ]),
        (r) => (r.native.ranges = [["0", "68719476737"]]),
        (r) => (r.native.acl = "x".repeat(65537)),
        (r) => {
          const values =
            r.native.platform === "win32" ? r.native.streams : r.native.xattrs;
          values.push({
            name:
              r.native.platform === "win32"
                ? "bad:stream"
                : Buffer.from("test").toString("base64"),
            data: "not-base64",
          });
        },
      ]) {
        const r = structuredClone(sample);
        mutate(r);
        assert.throws(() => validateFidelity(store, r));
      }
      const page = JSON.parse(store.read("page", root.fidelity.last_page));
      store.lock();
      for (const mutation of [
        "missing",
        "orphan",
        "kind",
        "range",
        "chain",
        "total",
        "extension",
      ]) {
        const r = structuredClone(root),
          p = structuredClone(page);
        if (mutation === "missing") p.records.pop();
        if (mutation === "orphan") p.records[0].path = "absent";
        if (mutation === "kind")
          p.records.find((v) => v.path === "one").kind = "dir";
        if (mutation === "range")
          p.records.find((v) => v.path === "one").native.ranges = [
            ["0", "999"],
          ];
        if (mutation === "chain") p.previous = "a".repeat(64);
        if (mutation === "extension") p.unknown = 1;
        const raw = Buffer.from(JSON.stringify(p)),
          pid = store.logical(raw);
        store.write("page", pid, raw);
        r.fidelity.last_page = pid;
        r.fidelity.entries = p.records.length;
        r.fidelity.bytes = String(
          p.records.reduce(
            (n, v) => n + Buffer.byteLength(JSON.stringify(v)),
            0,
          ),
        );
        if (mutation === "total") r.fidelity.bytes = "0";
        const rb = Buffer.from(JSON.stringify(r)),
          rid = store.logical(rb);
        store.write("snapshot", rid, rb);
        await assert.rejects(verifyPaged(repo, rid), undefined, mutation);
      }
    } finally {
      index.close();
      store.close();
    }
  }));

test("native metadata budget overflow does not publish a root, and legacy stores are never rewritten", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "fidelity");
    await PagedStore.create(repo, { fidelity: true });
    put(f.source, "data", "x");
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(f.source, "data") + ":too-large",
        Buffer.alloc(65537),
      );
      await assert.rejects(backupPaged(repo, f.source));
      assert.deepEqual(fs.readdirSync(path.join(repo, "snapshots")), []);
    }
    const magic = fs.readFileSync(path.join(f.repo, "moonrestore"));
    const legacy = call(["backup", f.repo, f.source]);
    assert.equal(call(["verify", f.repo, legacy.snapshot]).ok, true);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, "moonrestore")), magic);
    await assert.rejects(
      restorePlan({
        repository: f.repo,
        snapshot: legacy.snapshot,
        target: path.join(f.base, "invalid-metadata"),
        metadataMode: "native",
      }),
      /format5/,
    );
  }));
