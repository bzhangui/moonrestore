import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fixture, put, call, tree, sha } from "./helpers.mjs";
import { S3Backend, signS3Request } from "../platform/s3.mjs";
import {
  pushSnapshot,
  restoreRemote,
  remoteDrill,
} from "../platform/remote.mjs";

// Published AWS documentation example, not account credentials.
test("SigV4 matches the independently published AWS GET/range example", () => {
  const signed = signS3Request({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    date: new Date("2013-05-24T00:00:00Z"),
    headers: { range: "bytes=0-9" },
  });
  assert.ok(
    signed.authorization.endsWith(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    ),
  );
});
const credentials = {
  accessKeyId: "synthetic-access",
  secretAccessKey: "synthetic-secret-not-real-12345",
};
async function server(work) {
  const objects = new Map(),
    calls = [],
    mode = { corrupt: false, retention: true, redirect: false };
  const app = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks),
      u = new URL(req.url, "http://localhost");
    calls.push({ method: req.method, path: u.pathname, headers: req.headers });
    if (mode.redirect) {
      res.writeHead(307, { location: "http://127.0.0.1:1/never" });
      return res.end();
    }
    assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
    assert.equal(req.headers["x-amz-content-sha256"], sha(body));
    if (req.method === "PUT") {
      if (req.headers["if-none-match"] !== "*") {
        res.writeHead(400);
        return res.end();
      }
      if (objects.has(u.pathname)) {
        res.writeHead(412);
        return res.end();
      }
      assert.equal(
        req.headers["x-amz-checksum-sha256"],
        Buffer.from(sha(body), "hex").toString("base64"),
      );
      objects.set(u.pathname, {
        body,
        version: "v-" + objects.size,
        until: req.headers["x-amz-object-lock-retain-until-date"],
      });
      res.writeHead(200);
      return res.end();
    }
    const o = objects.get(u.pathname);
    if (
      !o ||
      (u.searchParams.has("versionId") &&
        u.searchParams.get("versionId") !== o.version)
    ) {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader("x-amz-version-id", o.version);
    if (o.until && mode.retention) {
      res.setHeader("x-amz-object-lock-mode", "COMPLIANCE");
      res.setHeader("x-amz-object-lock-retain-until-date", o.until);
    }
    res.end(mode.corrupt ? Buffer.from("broken") : o.body);
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: "http://127.0.0.1:" + app.address().port,
    bucket: "controlled",
    ...credentials,
  };
  try {
    await work({
      objects,
      calls,
      mode,
      config,
      backend: new S3Backend(config),
    });
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
}
test("S3 configuration rejects implicit remote, insecure transport, unsafe keys and retention without consent", async () => {
  const config = {
    endpoint: "https://example.invalid",
    bucket: "controlled",
    ...credentials,
  };
  assert.throws(() => new S3Backend(config), /permission/);
  assert.throws(
    () =>
      new S3Backend({
        ...config,
        endpoint: "http://example.invalid",
        allowRemote: true,
      }),
  );
  assert.throws(
    () =>
      new S3Backend({
        ...config,
        endpoint: "https://user:pass@example.invalid",
        allowRemote: true,
      }),
  );
  assert.throws(
    () =>
      new S3Backend({
        ...config,
        endpoint: "http://127.0.0.1",
        retentionDays: 1,
      }),
    /authorization/,
  );
  const backend = new S3Backend({ ...config, endpoint: "http://127.0.0.1" });
  for (const key of ["../escape", "a//b", "a/./b", "/a", "a?token=x"])
    await assert.rejects(() => backend.get(key), /Invalid/);
  backend.deadline = Date.now() - 1;
  await assert.rejects(() => backend.get("safe/object"), /deadline/);
});
test("immutable upload checks existing content, version and requested retention; redirects never followed", () =>
  server(async ({ backend, objects, mode, config, calls }) => {
    const b = Buffer.from("original");
    assert.equal((await backend.putImmutable("safe/object", b)).version, "v-0");
    await backend.putImmutable("safe/object", b);
    await assert.rejects(
      () => backend.putImmutable("safe/object", Buffer.from("changed")),
      /checksum/,
    );
    assert.equal(
      objects.get("/controlled/safe/object").body.toString(),
      "original",
    );
    const locked = new S3Backend({
      ...config,
      retentionDays: 1,
      allowRetention: true,
    });
    assert.equal(
      (await locked.putImmutable("safe/locked", b)).server_retention_reported,
      true,
    );
    mode.retention = false;
    await assert.rejects(
      () => locked.putImmutable("safe/no-retention", b),
      /retention/,
    );
    mode.redirect = true;
    await assert.rejects(() => backend.get("safe/object"), /failed/);
    assert.ok(calls.every((c) => ["GET", "PUT"].includes(c.method)));
  }));
test("encrypted S3 controlled copy restores a fully audited independent repository, with no source changes or plaintext names", () =>
  server(async ({ backend, objects, mode, calls }) => {
    const f = fixture(),
      old = {
        home: process.env.MOONRESTORE_HOME,
        password: process.env.MOONRESTORE_PASSWORD,
      };
    process.env.MOONRESTORE_HOME = path.join(f.base, "state");
    process.env.MOONRESTORE_PASSWORD = "controlled-password-12345";
    try {
      const repo = path.join(f.base, "encrypted");
      call(["init-encrypted", repo]);
      put(f.source, "private-name.txt", "private secret payload 中文");
      const b = call(["backup", repo, f.source]),
        before = tree(repo);
      const result = await pushSnapshot(repo, b.snapshot, backend);
      assert.equal(result.real_cloud_provider_verified, false);
      assert.equal(result.deletions_propagated, false);
      const total = objects.size;
      await pushSnapshot(repo, b.snapshot, backend);
      assert.equal(objects.size, total);
      for (const { body } of objects.values())
        assert.ok(
          !body.includes(Buffer.from("private-name")) &&
            !body.includes(Buffer.from("private secret")),
        );
      const dest = path.join(f.base, "downloaded");
      const restored = await restoreRemote(
        backend,
        result.receipt_key,
        result.receipt_checksum,
        dest,
        { version: result.receipt_version },
      );
      assert.equal(restored.full_snapshot_audit, true);
      const output = path.join(f.base, "output");
      call(["restore", dest, b.snapshot, output]);
      assert.deepEqual(tree(output), tree(f.source));
      const fullDrill = await remoteDrill(
        backend,
        result.receipt_key,
        result.receipt_checksum,
        path.join(f.base, "drill-copy"),
        { version: result.receipt_version },
      );
      assert.equal(fullDrill.plaintext_restored_and_read_back, true);
      assert.ok(fullDrill.total_recovery_ms > 0);
      assert.equal(fullDrill.real_cloud_provider_verified, false);
      const denied = path.join(f.base, "wrong-key");
      const originalPassword = process.env.MOONRESTORE_PASSWORD;
      process.env.MOONRESTORE_PASSWORD = "incorrect-controlled-password";
      await assert.rejects(() =>
        restoreRemote(
          backend,
          result.receipt_key,
          result.receipt_checksum,
          denied,
        ),
      );
      assert.equal(fs.existsSync(denied), false);
      process.env.MOONRESTORE_PASSWORD = originalPassword;
      const member = [...objects].find(
        ([key]) =>
          key.includes("/content/") &&
          objects.get(key).body.subarray(0, 4).toString() === "MRV2",
      );
      const saved = member[1].body;
      member[1].body = Buffer.from("corrupt encrypted member");
      const damaged = path.join(f.base, "damaged-download");
      await assert.rejects(
        () =>
          restoreRemote(
            backend,
            result.receipt_key,
            result.receipt_checksum,
            damaged,
          ),
        /checksum/,
      );
      assert.equal(fs.existsSync(damaged), false);
      member[1].body = saved;
      await assert.rejects(
        () =>
          restoreRemote(
            backend,
            result.receipt_key,
            "0".repeat(64),
            path.join(f.base, "bad"),
          ),
        /checksum/,
      );
      await assert.rejects(
        () =>
          restoreRemote(
            backend,
            result.receipt_key,
            result.receipt_checksum,
            dest,
          ),
        /NEW/,
      );
      mode.corrupt = true;
      const bad = path.join(f.base, "corrupted");
      await assert.rejects(
        () =>
          restoreRemote(
            backend,
            result.receipt_key,
            result.receipt_checksum,
            bad,
          ),
        /checksum/,
      );
      assert.equal(fs.existsSync(bad), false);
      assert.deepEqual(tree(repo), before);
      assert.ok(calls.every((c) => c.method !== "DELETE"));
    } finally {
      for (const [k, v] of Object.entries({
        MOONRESTORE_HOME: old.home,
        MOONRESTORE_PASSWORD: old.password,
      }))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      f.cleanup();
    }
  }));
test("even a pinned malformed receipt cannot write path traversal or bypass member budgets", () =>
  server(async ({ backend }) => {
    const f = fixture();
    try {
      for (const [n, member] of [
        { path: "../escape", key: "a", checksum: "0".repeat(64), size: "1" },
        {
          path: "moonrestore",
          key: "a",
          checksum: "0".repeat(64),
          size: "129",
        },
      ].entries()) {
        const receipt = Buffer.from(
          JSON.stringify({
            format: 1,
            kind: "moonrestore_encrypted_snapshot",
            encrypted: true,
            snapshot: "0".repeat(64),
            members: [member],
          }),
        );
        const key = "invalid/receipt-" + n;
        const stored = await backend.putImmutable(key, receipt),
          dest = path.join(f.base, "denied-" + n);
        await assert.rejects(
          () => restoreRemote(backend, key, stored.checksum, dest),
          /Invalid remote member|budgets/,
        );
        assert.equal(fs.existsSync(dest), false);
      }
      assert.equal(fs.existsSync(path.join(f.base, "escape")), false);
    } finally {
      f.cleanup();
    }
  }));
test("plaintext repositories cannot upload remote snapshots", () =>
  server(async ({ backend, objects }) => {
    const f = fixture();
    try {
      put(f.source, "a", "not-for-cloud");
      const b = call(["backup", f.repo, f.source]);
      await assert.rejects(
        () => pushSnapshot(f.repo, b.snapshot, backend),
        /encrypted/,
      );
      assert.equal(objects.size, 0);
    } finally {
      f.cleanup();
    }
  }));
