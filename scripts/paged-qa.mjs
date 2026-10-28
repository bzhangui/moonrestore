// Optional bounded scale rehearsal, only temporary synthetic data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  backupPaged,
  verifyPaged,
  restorePaged,
} from "../platform/paged-operations.mjs";
import { removeOwned } from "../platform/maintenance.mjs";
const parent = fs.realpathSync(os.tmpdir()),
  disk = fs.statfsSync(parent, { bigint: true });
if (disk.bavail * disk.bsize < 536870912n)
  throw new Error("At least 512MiB free space required");
const owned = fs.mkdtempSync(path.join(parent, "moonrestore-paged-scale-")),
  source = path.join(owned, "source"),
  repo = path.join(owned, "repo"),
  target = path.join(owned, "restore"),
  old = process.env.MOONRESTORE_HOME;
process.env.MOONRESTORE_HOME = path.join(owned, "state");
fs.mkdirSync(source);
const digest = (file) => {
  const h = createHash("sha256"),
    fd = fs.openSync(file, "r"),
    b = Buffer.alloc(65536);
  try {
    while (true) {
      const n = fs.readSync(fd, b);
      if (!n) break;
      h.update(b.subarray(0, n));
    }
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
};
try {
  const size = 67108864,
    file = path.join(source, "synthetic-random.bin"),
    fd = fs.openSync(file, "wx"),
    buffer = Buffer.alloc(65536);
  let x = 0x184129;
  try {
    for (let at = 0; at < size; at += buffer.length) {
      for (let i = 0; i < buffer.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        buffer[i] = x & 255;
      }
      fs.writeSync(fd, buffer);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let i = 0; i < 500; i++)
    fs.writeFileSync(
      path.join(source, "entry-" + i + ".txt"),
      "synthetic " + i + " 中文",
    );
  await PagedStore.create(repo);
  let start = performance.now();
  const b = await backupPaged(repo, source),
    backupMs = Math.ceil(performance.now() - start);
  assert.ok(b.pages > 10);
  assert.ok(fs.readdirSync(path.join(repo, "packs")).length > 4);
  start = performance.now();
  const repeat = await backupPaged(repo, source),
    incrementalMs = Math.ceil(performance.now() - start);
  assert.ok(repeat.history_audit.cached_roots > 0);
  assert.equal(repeat.stored_pack_bytes, "0");
  assert.equal(repeat.history_fully_healthy, false);
  start = performance.now();
  await verifyPaged(repo, b.snapshot);
  const verifyMs = Math.ceil(performance.now() - start);
  start = performance.now();
  await restorePaged(repo, b.snapshot, target);
  const restoreMs = Math.ceil(performance.now() - start);
  assert.equal(digest(file), digest(path.join(target, "synthetic-random.bin")));
  assert.equal(fs.readdirSync(target).length, 501);
  console.log(
    JSON.stringify({
      ok: true,
      kind: "paged_bounded_scale_rehearsal",
      synthetic_bytes: size,
      entries: b.entries,
      pages: b.pages,
      packs: fs.readdirSync(path.join(repo, "packs")).length,
      backup_ms: backupMs,
      repeat_backup_ms: incrementalMs,
      repeat_stored_pack_bytes: repeat.stored_pack_bytes,
      cached_history_roots: repeat.history_audit.cached_roots,
      verify_ms: verifyMs,
      restore_ms: restoreMs,
      process_peak_rss_kib: process.resourceUsage().maxRSS,
      peak_scope: "entire_QA_process_not_per_phase",
      plaintext_sha256: digest(file),
      production_or_limit_scale_verified: false,
      public_raw_report: false,
    }),
  );
} finally {
  if (old === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = old;
  removeOwned(owned, parent, "moonrestore-paged-scale-");
}
