import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { S3Backend } from "../platform/s3.mjs";
test("S3 retries transient responses within budget but never retries authorization, checksum or conflicts", async () => {
  let calls = 0,
    mode = "transient";
  const app = http.createServer((req, res) => {
    calls++;
    req.resume();
    if (mode === "transient" && calls < 3) {
      res.writeHead(calls === 1 ? 429 : 503, { "retry-after": "0" });
      res.end();
    } else if (mode === "deny") {
      res.writeHead(403);
      res.end();
    } else if (mode === "conflict") {
      res.writeHead(409);
      res.end();
    } else if (mode === "down") {
      res.writeHead(503);
      res.end();
    } else res.end("content");
  });
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const config = {
    endpoint: "http://127.0.0.1:" + app.address().port,
    bucket: "synthetic",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic-not-a-secret",
    retryBaseMs: 1,
    maxAttempts: 3,
  };
  try {
    const b = new S3Backend(config);
    assert.equal((await b.get("a")).bytes.toString(), "content");
    assert.equal(b.retries, 2);
    for (const value of ["deny", "conflict", "checksum", "down"]) {
      mode = value;
      calls = 0;
      const c = new S3Backend(config);
      await assert.rejects(() =>
        value === "conflict"
          ? c.putImmutable("a", Buffer.from("a"))
          : c.get("a", {
              checksum: value === "checksum" ? "0".repeat(64) : undefined,
            }),
      );
      assert.equal(calls, value === "down" ? 3 : 1);
    }
    assert.throws(() => new S3Backend({ ...config, maxAttempts: 99 }));
    const c = new S3Backend({ ...config, totalMs: 100, retryBaseMs: 1000 });
    mode = "down";
    await assert.rejects(() => c.get("a"), /deadline/);
  } finally {
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  }
});
