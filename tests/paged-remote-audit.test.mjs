import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fixture, sha } from "./helpers.mjs";
import { S3Backend } from "../platform/s3.mjs";
import { auditRemote, auditRemoteCycle } from "../platform/remote-audit.mjs";
function controlled() {
  const map = new Map(),
    prefix = "owned/" + randomUUID(),
    now = Date.now(),
    calls = [];
  const put = (key, bytes) => {
    const r = {
      key,
      checksum: sha(bytes),
      size: String(bytes.length),
      version: "v-" + sha(bytes),
    };
    map.set(key, { bytes, ...r });
    return r;
  };
  const paths = [
    "moonrestore",
    "repository-id",
    "encryption.json",
    "snapshots/" + sha("snapshot"),
    ...Array.from({ length: 127 }, (_, i) => "pages/" + sha(String(i))),
  ];
  const members = paths.map((p) => {
    const bytes = Buffer.from(p);
    return { path: p, ...put(prefix + "/content/" + sha(bytes), bytes) };
  });
  const pages = [];
  for (let i = 0; i < members.length; i += 128) {
    const bytes = Buffer.from(JSON.stringify(members.slice(i, i + 128)));
    pages.push(put(prefix + "/receipt-pages/" + sha(bytes), bytes));
  }
  const record = {
    format: 2,
    kind: "moonrestore_paged_encrypted_snapshot",
    encrypted: true,
    snapshot: sha("snapshot"),
    pages,
    members: members.length,
    bytes: String(members.reduce((a, b) => a + Number(b.size), 0)),
  };
  const root = Buffer.from(JSON.stringify(record)),
    pin = put(prefix + "/receipts/" + sha(root) + ".json", root);
  class Controlled extends S3Backend {
    async get(key, { version, checksum } = {}) {
      calls.push(key);
      const item = map.get(key);
      if (!item || item.version !== version || sha(item.bytes) !== checksum)
        throw new Error("Pinned controlled object unavailable");
      return {
        ...item,
        headers: new Headers({
          "x-amz-object-lock-mode": "COMPLIANCE",
          "x-amz-object-lock-retain-until-date": new Date(
            now + 10 * 86400000,
          ).toISOString(),
        }),
      };
    }
  }
  const backend = new Controlled({
    endpoint: "http://127.0.0.1:1",
    bucket: "controlled",
    accessKeyId: "synthetic",
    secretAccessKey: "synthetic-not-a-real-secret",
  });
  return { map, calls, backend, pin, record, now };
}
test("paged remote audits only necessary metadata pages, pins versions and distinguishes content from ciphertext observations", async () => {
  const c = controlled(),
    r = await auditRemote(c.backend, c.pin.key, c.pin.checksum, {
      version: c.pin.version,
      offset: 127,
      batch: 3,
      retentionDays: 7,
      now: c.now,
    });
  assert.equal(r.checked, 3);
  assert.equal(r.total, 131);
  assert.equal(r.next_offset, 130);
  assert.equal(c.calls.length, 6);
  assert.equal(r.inventory_uniqueness_verified, false);
  assert.equal(r.cleanup_authorized, false);
  const full = await auditRemote(c.backend, c.pin.key, c.pin.checksum, {
    version: c.pin.version,
    batch: 1000,
  });
  assert.equal(full.entire_receipt_checked, true);
  assert.equal(full.inventory_uniqueness_verified, true);
  assert.equal(full.plaintext_content_verified, false);
  c.map.get(c.record.pages[1].key).bytes = Buffer.from("corrupt");
  await assert.rejects(
    auditRemote(c.backend, c.pin.key, c.pin.checksum, {
      version: c.pin.version,
      offset: 128,
    }),
  );
});
test("paged audit cycle resumes at authenticated offset and cannot convert cumulative observations into inventory/restore proof", async () => {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private");
  try {
    const c = controlled(),
      config = { cycleId: randomUUID(), version: c.pin.version, batch: 128 };
    assert.equal(
      (await auditRemoteCycle(c.backend, c.pin.key, c.pin.checksum, config))
        .checked,
      128,
    );
    const damaged = c.map.get(c.record.pages[1].key),
      original = damaged.bytes;
    damaged.bytes = Buffer.from("corrupt");
    await assert.rejects(
      auditRemoteCycle(c.backend, c.pin.key, c.pin.checksum, config),
    );
    damaged.bytes = original;
    await assert.rejects(
      auditRemoteCycle(c.backend, c.pin.key, c.pin.checksum, config),
      /retry/,
    );
    const result = await auditRemoteCycle(
      c.backend,
      c.pin.key,
      c.pin.checksum,
      { ...config, retry: true },
    );
    assert.equal(result.checked, 131);
    assert.equal(result.entire_receipt_checked, true);
    assert.equal(result.inventory_uniqueness_verified, false);
    assert.equal(result.cleanup_authorized, false);
  } finally {
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
    f.cleanup();
  }
});
