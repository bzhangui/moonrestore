import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, call, tree, randomBytes } from "./helpers.mjs";
import {
  createOperation,
  runOperation,
  operationStatus,
} from "../platform/operations.mjs";
import { Journal } from "../platform/journal.mjs";
import {
  providerCapabilities,
  requireCapabilities,
} from "../platform/contracts.mjs";
async function owned(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private");
  try {
    await work(f);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("durable backup and restore complete through validated core state transitions", () =>
  owned(async (f) => {
    put(f.source, "dir/中文.txt", "durable data");
    const id = await createOperation({ repository: f.repo, source: f.source });
    const b = await runOperation(f.repo, id);
    assert.equal(b.state, "completed");
    assert.equal((await runOperation(f.repo, id)).snapshot, b.snapshot);
    const before = tree(f.repo),
      target = path.join(f.base, "restored"),
      r = await createOperation({
        repository: f.repo,
        snapshot: b.snapshot,
        target,
      });
    assert.equal((await runOperation(f.repo, r)).post_restore_readback, true);
    assert.deepEqual(tree(target), tree(f.source));
    assert.deepEqual(tree(f.repo), before);
  }));
test("interrupted backup resumes verified files and explicitly recovers only its own dead lock", () =>
  owned(async (f) => {
    put(f.source, "a", randomBytes(100000));
    put(f.source, "b", "second");
    const id = await createOperation({ repository: f.repo, source: f.source });
    call(["operation-resume", f.repo, id], {
      env: { MOONRESTORE_TEST_CRASH: "checkpoint-file" },
      status: 1,
    });
    assert.equal(operationStatus(f.repo, id).state, "failed");
    await assert.rejects(() => runOperation(f.repo, id), /lock/);
    const b = await runOperation(f.repo, id, { recover: true });
    assert.equal(b.state, "completed");
    call(["verify", f.repo, b.snapshot]);
  }));
test("source changes and tampered journals refuse continuation without publishing a snapshot", () =>
  owned(async (f) => {
    put(f.source, "a", "original");
    const id = await createOperation({ repository: f.repo, source: f.source });
    call(["operation-resume", f.repo, id], {
      env: { MOONRESTORE_TEST_CRASH: "checkpoint-file" },
      status: 1,
    });
    put(f.source, "a", "modified");
    await assert.rejects(() => runOperation(f.repo, id, { recover: true }));
    assert.equal(call(["list", f.repo]).snapshots.length, 0);
    const j = new Journal(f.repo, id);
    try {
      const raw = JSON.parse(fs.readFileSync(j.controlFile));
      raw.payload = Buffer.from("{}").toString("base64");
      fs.writeFileSync(j.controlFile, JSON.stringify(raw));
      assert.throws(() => j.load(), /integrity/);
    } finally {
      j.close();
    }
  }));
test("restore interruption checks existing prefix and resolves publication uncertainty by inode and full readback", () =>
  owned(async (f) => {
    put(f.source, "a", randomBytes(180000));
    const b = backup(f),
      before = tree(f.repo);
    for (const point of ["checkpoint-prefix", "checkpoint-published"]) {
      const target = path.join(f.base, point),
        id = await createOperation({
          repository: f.repo,
          snapshot: b.snapshot,
          target,
        });
      call(["operation-resume", f.repo, id], {
        env: { MOONRESTORE_TEST_CRASH: point },
        status: 1,
      });
      assert.equal(
        (await runOperation(f.repo, id, { recover: true }))
          .post_restore_readback,
        true,
      );
      assert.deepEqual(tree(target), tree(f.source));
    }
    assert.deepEqual(tree(f.repo), before);
  }));
test("corrupted staged prefix is never overwritten and racing target is retained", () =>
  owned(async (f) => {
    put(f.source, "a", "content");
    const b = backup(f),
      target = path.join(f.base, "restore"),
      id = await createOperation({
        repository: f.repo,
        snapshot: b.snapshot,
        target,
      });
    call(["operation-resume", f.repo, id], {
      env: { MOONRESTORE_TEST_CRASH: "checkpoint-prefix" },
      status: 1,
    });
    const j = new Journal(f.repo, id);
    try {
      const c = j.load();
      fs.writeFileSync(path.join(c.stage, "a"), "TAMPER");
      await assert.rejects(() => runOperation(f.repo, id, { recover: true }));
      assert.equal(fs.existsSync(target), false);
      fs.mkdirSync(target);
      put(target, "keep", "keep");
      await assert.rejects(() => runOperation(f.repo, id));
      assert.equal(fs.readFileSync(path.join(target, "keep"), "utf8"), "keep");
    } finally {
      j.close();
    }
  }));
test("versioned capabilities fail closed, never load arbitrary providers", () => {
  assert.equal(providerCapabilities("s3").contract, 1);
  assert.throws(() => requireCapabilities("local", ["versioned_read"]));
  assert.throws(() => providerCapabilities("../plugin"));
  assert.throws(() => requireCapabilities("s3", ["constructor"]));
});

test("a surviving worker lease prevents a second writer even if coordinator recovery is requested", () =>
  owned(async (f) => {
    put(f.source, "a", "content");
    const id = await createOperation({ repository: f.repo, source: f.source }),
      worker = new Journal(f.repo, id);
    try {
      worker.acquire(false, { worker: true });
      await assert.rejects(
        () => runOperation(f.repo, id, { recover: true }),
        /still running/,
      );
      assert.equal(operationStatus(f.repo, id).state, "prepared");
    } finally {
      worker.close();
    }
    assert.equal((await runOperation(f.repo, id)).ok, true);
  }));
