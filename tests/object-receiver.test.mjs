import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, randomBytes, tree, sha } from "./helpers.mjs";
import {
  initObjectReceiver,
  startObjectReceiver,
  ReceiverBackend,
} from "../platform/object-receiver.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { backupPaged, restorePaged } from "../platform/paged-operations.mjs";
import { pushPaged, restorePagedRemote } from "../platform/paged-remote.mjs";
const writer = "synthetic-writer-token-controlled-0001",
  admin = "synthetic-admin-token-controlled-00002";
async function controlled(
  fn,
  { maxBytes = 1073741824, maxObjects = 100000 } = {},
) {
  const f = fixture(),
    directory = path.join(f.base, "receiver");
  initObjectReceiver(directory, "owned", { maxBytes, maxObjects });
  let running = await startObjectReceiver({
    directory,
    writerToken: writer,
    adminToken: admin,
  });
  const context = {
    f,
    directory,
    get running() {
      return running;
    },
    backend: () =>
      new ReceiverBackend({
        endpoint: "http://127.0.0.1:" + running.port,
        namespace: "owned",
        credential: writer,
      }),
    restart: async () => {
      await running.close();
      running = await startObjectReceiver({
        directory,
        writerToken: writer,
        adminToken: admin,
      });
    },
  };
  try {
    await fn(context);
  } finally {
    await running.close();
    f.cleanup();
  }
}
test("receiver immutable writes survive restart, separate roles, reject overwrite/delete and authenticate reads", () =>
  controlled(async (c) => {
    const key = "owned/content/item",
      data = Buffer.from("opaque-encrypted-example"),
      b = c.backend(),
      stored = await b.putImmutable(key, data);
    assert.deepEqual((await b.get(key, stored)).bytes, data);
    assert.equal((await b.putImmutable(key, data)).version, stored.version);
    await assert.rejects(
      b.putImmutable(key, Buffer.from("replacement")),
      /409/,
    );
    const url = "http://127.0.0.1:" + c.running.port,
      object = "/v1/objects/" + sha(key);
    assert.equal((await fetch(url + object)).status, 401);
    assert.equal(
      (
        await fetch(url + object, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer " + writer,
            "x-moonrestore-namespace": "owned",
          },
        })
      ).status,
      405,
    );
    const readOnly = new ReceiverBackend({
      endpoint: url,
      namespace: "owned",
      credential: admin,
    });
    await assert.rejects(readOnly.putImmutable("owned/forbidden", data), /403/);
    assert.equal(
      (
        await fetch(url + "/v1/status", {
          headers: { Authorization: "Bearer " + writer },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await (
          await fetch(url + "/v1/status", {
            headers: { Authorization: "Bearer " + admin },
          })
        ).json()
      ).objects,
      1,
    );
    await assert.rejects(
      b.get(key, {
        checksum: "0".repeat(64),
        version: "sha256:" + "0".repeat(64),
      }),
      /verification/,
    );
    await c.restart();
    assert.deepEqual((await c.backend().get(key, stored)).bytes, data);
    fs.writeFileSync(path.join(c.directory, "objects", sha(key)), "corrupt");
    await assert.rejects(c.backend().get(key, stored), /409/);
  }));
test("receiver enforces namespace, quota, exclusive active lease and corrupt restart boundaries", () =>
  controlled(
    async (c) => {
      const b = c.backend();
      await assert.rejects(b.get("other/content"), /namespace/);
      await assert.rejects(b.get("owned/../escape"), /namespace/);
      await assert.rejects(
        startObjectReceiver({
          directory: c.directory,
          writerToken: writer,
          adminToken: admin,
          recover: true,
        }),
        /active/,
      );
      await b.putImmutable("owned/first", Buffer.alloc(600));
      await assert.rejects(
        b.putImmutable("owned/second", Buffer.alloc(600)),
        /507/,
      );
      assert.throws(
        () =>
          new ReceiverBackend({
            endpoint: "http://example.com",
            namespace: "owned",
            credential: writer,
          }),
      );
      await assert.rejects(
        startObjectReceiver({
          directory: c.directory,
          writerToken: writer,
          adminToken: writer,
        }),
        /Distinct/,
      );
    },
    { maxBytes: 1100 },
  ));
test("receiver transports encrypted format5 snapshot and restores authenticated content and archived metadata", () =>
  controlled(async (c) => {
    const old = process.env.MOONRESTORE_PASSWORD,
      home = process.env.MOONRESTORE_HOME;
    process.env.MOONRESTORE_PASSWORD = "synthetic-receiver-test-password";
    process.env.MOONRESTORE_HOME = path.join(c.f.base, "home");
    try {
      const repo = path.join(c.f.base, "paged");
      await PagedStore.create(repo, { encrypted: true, fidelity: true });
      put(c.f.source, "中文/asset", randomBytes(400000));
      const saved = await backupPaged(repo, c.f.source),
        before = tree(repo),
        r = await pushPaged(repo, saved.snapshot, c.backend(), {
          prefix: "owned",
        });
      await c.restart();
      const fetched = await c.backend().get(r.receipt_key, {
          checksum: r.receipt_checksum,
          version: r.receipt_version,
        }),
        destination = path.join(c.f.base, "download");
      const restored = await restorePagedRemote(
        c.backend(),
        JSON.parse(fetched.bytes),
        destination,
      );
      assert.equal(restored.full_snapshot_audit, true);
      const output = path.join(c.f.base, "output");
      await restorePaged(destination, saved.snapshot, output, {
        permissions: true,
      });
      assert.deepEqual(tree(output), tree(c.f.source));
      assert.deepEqual(tree(repo), before);
    } finally {
      if (old === undefined) delete process.env.MOONRESTORE_PASSWORD;
      else process.env.MOONRESTORE_PASSWORD = old;
      if (home === undefined) delete process.env.MOONRESTORE_HOME;
      else process.env.MOONRESTORE_HOME = home;
    }
  }));

test("receiver publication acknowledgement loss preserves immutable retry and conservatively accounts quota", () =>
  controlled(
    async (c) => {
      const link = fs.linkSync,
        b = c.backend(),
        key = "owned/uncertain",
        bytes = Buffer.from("synthetic uncertain acknowledgement");
      let injected = false;
      fs.linkSync = function (from, to) {
        const r = link.call(fs, from, to);
        if (
          typeof to === "string" &&
          to === path.join(c.directory, "objects", sha(key)) &&
          !injected
        ) {
          injected = true;
          throw Object.assign(new Error("controlled post-publication IO"), {
            code: "EIO",
          });
        }
        return r;
      };
      try {
        await assert.rejects(b.putImmutable(key, bytes), /409/);
      } finally {
        fs.linkSync = link;
      }
      assert.equal(injected, true);
      assert.equal((await b.putImmutable(key, bytes)).checksum, sha(bytes));
      await assert.rejects(b.putImmutable("owned/second", bytes), /507/);
      await c.restart();
      assert.deepEqual((await c.backend().get(key)).bytes, bytes);
    },
    { maxObjects: 1 },
  ));
