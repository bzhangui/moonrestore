import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, call, snapshot, tree } from "./helpers.mjs";
import { Host } from "../platform/adapter.mjs";
import { RecoverySession } from "../platform/recovery-target.mjs";
import {
  rescuePlan,
  rescueToNewTarget,
  rebuildCopy,
  recoveryChecklist,
  scrub,
  recoveryHealth,
} from "../platform/recovery.mjs";
import { replicate } from "../platform/maintenance.mjs";
import { withCredentials } from "../platform/activity.mjs";

async function owned(work) {
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
test("independent target readback rejects disk changes and never replaces a racing target", () =>
  owned(async (f) => {
    const before = tree(f.repo);
    for (const mode of ["readback", "race"]) {
      const target = path.join(f.base, mode),
        session = new RecoverySession({ repository: f.repo, target });
      try {
        session.write("begin_restore", { target });
        session.write("restore_open", { path: "file" });
        session.write("restore_write", {}, Buffer.from("expected"));
        session.write("restore_close", {});
        if (mode === "readback")
          fs.writeFileSync(path.join(session.stage, "file"), "tampered");
        else {
          fs.mkdirSync(target);
          fs.writeFileSync(path.join(target, "keep"), "original");
        }
        assert.throws(
          () => session.write("finish_restore", {}),
          /readback|publication/,
        );
        if (mode === "readback") assert.equal(fs.existsSync(target), false);
        else
          assert.equal(
            fs.readFileSync(path.join(target, "keep"), "utf8"),
            "original",
          );
      } finally {
        session.clean();
      }
    }
    assert.deepEqual(tree(f.repo), before);
  }));
function corrupt(f, s, name) {
  const part = snapshot(f, s).entries.find((e) => e.path === name).chunks[0];
  fs.writeFileSync(
    path.join(f.repo, "objects", part.id.slice(0, 2), part.id),
    Buffer.from("broken"),
  );
}
test("strict read-only capability rejects all repository and restore writes", () =>
  owned(async (f) => {
    put(f.source, "a", "healthy");
    const b = backup(f),
      before = tree(f.repo);
    const ro = new Host({
      environment: { ...process.env, MOONRESTORE_READ_ONLY: "1" },
    });
    try {
      ro.operation("open", { path: f.repo });
      ro.lock();
      assert.ok(ro.operation("list").includes(b.snapshot));
      for (const op of [
        "init",
        "put",
        "commit",
        "recover",
        "begin_restore",
        "restore_write",
        "finish_restore",
      ])
        assert.throws(
          () =>
            ro.operation(
              op,
              { target: path.join(f.base, "never") },
              Buffer.from("x"),
            ),
          /Read-only/,
        );
      assert.throws(
        () => ro.store("0".repeat(64), Buffer.from("x")),
        /Read-only/,
      );
    } finally {
      ro.clean();
    }
    assert.deepEqual(tree(f.repo), before);
    assert.equal(fs.existsSync(path.join(f.repo, ".lock")), false);
  }));
test("explicit rescue saves healthy files from damaged snapshot without source writes", () =>
  owned(async (f) => {
    put(f.source, "folder/good.txt", "recover me");
    put(f.source, "bad.txt", "damaged unique content");
    const b = backup(f);
    corrupt(f, b.snapshot, "bad.txt");
    const before = tree(f.repo),
      target = path.join(f.base, "rescued");
    call(["restore", f.repo, b.snapshot, target], { status: 1 });
    assert.equal(fs.existsSync(target), false);
    const request = { repository: f.repo, snapshot: b.snapshot, target },
      preview = await rescuePlan(request);
    assert.equal(preview.failed_files, 1);
    assert.equal(preview.verified_files, 1);
    await assert.rejects(() =>
      rescueToNewTarget({
        ...request,
        confirmation: preview.confirmation,
        acceptPartial: false,
      }),
    );
    await assert.rejects(() =>
      rescueToNewTarget({
        ...request,
        confirmation: "wrong",
        acceptPartial: true,
      }),
    );
    const report = await rescueToNewTarget({
      ...request,
      confirmation: preview.confirmation,
      acceptPartial: true,
    });
    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.equal(report.post_restore_readback, true);
    assert.equal(
      fs.readFileSync(path.join(target, "folder/good.txt"), "utf8"),
      "recover me",
    );
    assert.equal(fs.existsSync(path.join(target, "bad.txt")), false);
    assert.deepEqual(tree(f.repo), before);
    assert.ok(!fs.readFileSync(report.files.json, "utf8").includes("bad.txt"));
  }));
test("rescue rechecks changed previews and never overwrites an existing target", () =>
  owned(async (f) => {
    put(f.source, "good", "content");
    const b = backup(f),
      target = path.join(f.base, "output");
    const request = { repository: f.repo, snapshot: b.snapshot, target },
      plan = await rescuePlan(request);
    corrupt(f, b.snapshot, "good");
    await assert.rejects(() =>
      rescueToNewTarget({
        ...request,
        confirmation: plan.confirmation,
        acceptPartial: true,
      }),
    );
    assert.equal(fs.existsSync(target), false);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "original");
    await assert.rejects(() => rescuePlan(request));
    assert.equal(
      fs.readFileSync(path.join(target, "keep"), "utf8"),
      "original",
    );
    assert.throws(
      () =>
        new RecoverySession({
          repository: f.repo,
          target: path.join(f.repo, "inside"),
        }),
    );
  }));
test("healthy donor rebuilds an exact snapshot into a NEW verified repository", () =>
  owned(async (f) => {
    put(f.source, "a", "first content");
    put(f.source, "b", "second content");
    const b = backup(f);
    const donor = path.join(f.base, "donor");
    await replicate(f.repo, donor);
    corrupt(f, b.snapshot, "a");
    const before = tree(f.repo),
      donorBefore = tree(donor),
      dest = path.join(f.base, "rebuilt");
    const report = await rebuildCopy(f.repo, b.snapshot, donor, dest);
    assert.equal(report.ok, true);
    assert.ok(report.donor_objects > 0);
    call(["verify", dest, b.snapshot]);
    const restored = path.join(f.base, "restored");
    call(["restore", dest, b.snapshot, restored]);
    assert.deepEqual(tree(restored), tree(f.source));
    assert.deepEqual(tree(f.repo), before);
    assert.deepEqual(tree(donor), donorBefore);
    await assert.rejects(() => rebuildCopy(f.repo, b.snapshot, donor, dest));
  }));
test("failed donor rebuild preserves both sources and publishes no destination", () =>
  owned(async (f) => {
    put(f.source, "a", "unique");
    const b = backup(f),
      donor = path.join(f.base, "donor");
    await replicate(f.repo, donor);
    corrupt(f, b.snapshot, "a");
    corrupt({ ...f, repo: donor }, b.snapshot, "a");
    const before = tree(f.repo),
      dest = path.join(f.base, "failed-rebuild");
    await assert.rejects(
      () => rebuildCopy(f.repo, b.snapshot, donor, dest),
      /No verified source/,
    );
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(tree(f.repo), before);
  }));
test("donor can supply a corrupted primary manifest only for the exact pinned ID", () =>
  owned(async (f) => {
    put(f.source, "a", "manifest recovery content");
    const b = backup(f),
      donor = path.join(f.base, "donor");
    await replicate(f.repo, donor);
    fs.writeFileSync(
      path.join(f.repo, "snapshots", b.snapshot + ".json"),
      "broken manifest",
    );
    const before = tree(f.repo),
      destination = path.join(f.base, "manifest-rebuilt");
    const report = await rebuildCopy(f.repo, b.snapshot, donor, destination);
    assert.equal(report.manifest_from_donor, true);
    call(["verify", destination, b.snapshot]);
    assert.deepEqual(tree(f.repo), before);
    await assert.rejects(
      () =>
        rebuildCopy(
          f.repo,
          "0".repeat(64),
          donor,
          path.join(f.base, "missing"),
        ),
      /pinned snapshot/,
    );
  }));
test("preparation checklist excludes keys and filenames and preserves its source", () =>
  owned(async (f) => {
    put(f.source, "private-filename.txt", "private-data");
    backup(f);
    const before = tree(f.repo);
    const output = path.join(f.base, "checklist.json"),
      result = await recoveryChecklist(f.repo, output);
    assert.equal(result.contains_keys, false);
    assert.equal(result.proof_of_recoverability, false);
    const text = fs.readFileSync(output, "utf8");
    assert.ok(
      !text.includes("private-filename") && !text.includes("private-data"),
    );
    assert.deepEqual(tree(f.repo), before);
    await assert.rejects(() => recoveryChecklist(f.repo, output));
    await assert.rejects(() =>
      recoveryChecklist(f.repo, path.join(f.repo, "checklist.json")),
    );
  }));
test("persistent scrub requires complete cycles and retains failure evidence", () =>
  owned(async (f) => {
    put(f.source, "a", "one");
    put(f.source, "b", "two");
    const b = backup(f),
      before = tree(f.repo);
    assert.equal((await recoveryHealth(f.repo)).ok, false);
    await assert.rejects(() => scrub(f.repo, { maxBytes: 100 }), /byte budget/);
    const first = await scrub(f.repo, { maxFiles: 1, maxBytes: "100" });
    assert.equal(first.checked_files, 1);
    assert.equal(first.completed_cycle, null);
    assert.equal((await recoveryHealth(f.repo)).ok, false);
    const last = await scrub(f.repo, { maxFiles: 1, maxBytes: "100" });
    assert.equal(last.completed_cycle.checked, 2);
    assert.equal((await recoveryHealth(f.repo)).ok, true);
    assert.deepEqual(tree(f.repo), before);
    corrupt(f, b.snapshot, "a");
    assert.equal(
      (await scrub(f.repo, { maxFiles: 1, maxBytes: "100" })).ok,
      false,
    );
    assert.equal((await recoveryHealth(f.repo)).snapshots[0].state, "failed");
  }));
test("replaced repositories cannot inherit prior green evidence at the same path", () =>
  owned(async (f) => {
    put(f.source, "a", "same data");
    backup(f);
    await scrub(f.repo);
    assert.equal((await recoveryHealth(f.repo)).ok, true);
    const previous = path.join(f.base, "previous");
    fs.renameSync(f.repo, previous);
    fs.cpSync(previous, f.repo, { recursive: true });
    assert.equal((await recoveryHealth(f.repo)).ok, false);
    assert.equal((await recoveryHealth(f.repo)).snapshots[0].state, "unknown");
  }));
test("undersized scrub budgets do not advance or report completion; stale/malformed evidence is not green", () =>
  owned(async (f) => {
    put(f.source, "a", "more than one byte");
    backup(f);
    const refused = await scrub(f.repo, { maxBytes: "1" });
    assert.equal(refused.ok, false);
    assert.equal(refused.completed_cycle, null);
    assert.equal((await recoveryHealth(f.repo)).ok, false);
    await scrub(f.repo);
    const dir = path.join(f.base, "state", "verification"),
      file = path.join(
        dir,
        fs.readdirSync(dir).find((n) => n.endsWith(".json")),
      );
    const evidence = JSON.parse(fs.readFileSync(file)),
      record = Object.values(evidence.snapshots)[0];
    record.last.started = "2020-01-01T00:00:00Z";
    record.last.finished = "2020-01-01T01:00:00Z";
    fs.writeFileSync(file, JSON.stringify(evidence));
    assert.equal((await recoveryHealth(f.repo)).snapshots[0].state, "stale");
    delete record.last.failed;
    fs.writeFileSync(file, JSON.stringify(evidence));
    await assert.rejects(
      () => recoveryHealth(f.repo),
      /Invalid verification evidence/,
    );
  }));
test("fresh-state recovery uses explicit independent key without persisting key material in evidence", () =>
  owned(async (f) => {
    const encrypted = path.join(f.base, "encrypted"),
      keyFile = path.join(f.base, "recovery-key.json"),
      password = "synthetic-only-password-not-real";
    call(["init-encrypted", encrypted], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    put(f.source, "paper.txt", "中文恢复内容");
    const b = call(["backup", encrypted, f.source], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    call(["key-export", encrypted, "--output", keyFile], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    const before = tree(encrypted),
      request = {
        repository: encrypted,
        snapshot: b.snapshot,
        target: path.join(f.base, "new-state-output"),
        recoveryKeyFile: keyFile,
      };
    const plan = await rescuePlan(request),
      result = await rescueToNewTarget({
        ...request,
        confirmation: plan.confirmation,
        acceptPartial: true,
      });
    assert.equal(result.complete, true);
    assert.equal(result.post_restore_readback, true);
    assert.equal(
      fs.readFileSync(path.join(request.target, "paper.txt"), "utf8"),
      "中文恢复内容",
    );
    assert.deepEqual(tree(encrypted), before);
    assert.ok(
      !fs
        .readFileSync(result.files.json, "utf8")
        .includes(JSON.parse(fs.readFileSync(keyFile)).key),
    );
    await assert.rejects(() =>
      rescuePlan({
        ...request,
        target: path.join(f.base, "wrong"),
        recoveryKeyFile: path.join(f.base, "missing-key"),
      }),
    );
  }));
test("encrypted donor rebuild uses a new destination key and refuses plaintext downgrade", () =>
  owned(async (f) => {
    const source = path.join(f.base, "encrypted-source"),
      donor = path.join(f.base, "encrypted-donor"),
      destination = path.join(f.base, "encrypted-rebuilt");
    const old = {
      password: process.env.MOONRESTORE_PASSWORD,
      donor: process.env.MOONRESTORE_DONOR_PASSWORD,
    };
    process.env.MOONRESTORE_PASSWORD = "synthetic-source-password";
    process.env.MOONRESTORE_DONOR_PASSWORD = "synthetic-donor-password";
    try {
      call(["init-encrypted", source]);
      put(f.source, "private-file.txt", "independent encrypted donor");
      const b = call(["backup", source, f.source]);
      await withCredentials(
        (repository) =>
          repository === donor
            ? { MOONRESTORE_PASSWORD: process.env.MOONRESTORE_DONOR_PASSWORD }
            : {},
        () => replicate(source, donor, { encrypted: true }),
      );
      const firstFolder = fs.readdirSync(path.join(source, "objects"))[0],
        object = path.join(
          source,
          "objects",
          firstFolder,
          fs.readdirSync(path.join(source, "objects", firstFolder))[0],
        );
      fs.writeFileSync(object, "broken");
      const before = tree(source),
        donorBefore = tree(donor);
      await assert.rejects(
        () =>
          rebuildCopy(
            source,
            b.snapshot,
            donor,
            path.join(f.base, "downgrade"),
            { encrypted: false },
          ),
        /downgrade/,
      );
      const result = await rebuildCopy(source, b.snapshot, donor, destination, {
        destinationPassword: "synthetic-destination-password",
      });
      assert.equal(result.ok, true);
      assert.equal(result.encrypted, true);
      assert.equal(result.donor_objects, 1);
      const target = path.join(f.base, "encrypted-output");
      call(["restore", destination, b.snapshot, target], {
        env: { MOONRESTORE_PASSWORD: "synthetic-destination-password" },
      });
      assert.deepEqual(tree(target), tree(f.source));
      assert.deepEqual(tree(source), before);
      assert.deepEqual(tree(donor), donorBefore);
      assert.notEqual(
        JSON.parse(fs.readFileSync(path.join(destination, "encryption.json")))
          .id,
        JSON.parse(fs.readFileSync(path.join(source, "encryption.json"))).id,
      );
    } finally {
      for (const [k, v] of Object.entries({
        MOONRESTORE_PASSWORD: old.password,
        MOONRESTORE_DONOR_PASSWORD: old.donor,
      }))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  }));
