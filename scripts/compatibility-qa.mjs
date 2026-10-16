// Optional actual 0.2.0 runtime comparison, not a reconstructed mock format.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { removeOwned, saveReport } from "../platform/maintenance.mjs";
const baseline = path.resolve(process.argv[2] || "");
if (!fs.existsSync(path.join(baseline, "manifest.json")))
  throw new Error("Pass an independently built 0.2.0 portable bundle");
const metadata = JSON.parse(
  fs.readFileSync(path.join(baseline, "manifest.json")),
);
if (metadata.version !== "0.2.0") throw new Error("Expected 0.2.0 baseline");
const current = fileURLToPath(new URL("../", import.meta.url)),
  parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-compat-")),
  source = path.join(root, "source");
const run = (project, args) => {
  const started = performance.now(),
    r = spawnSync(
      process.execPath,
      [path.join(project, "bin/moonrestore.mjs"), ...args],
      { cwd: project, encoding: "utf8", timeout: 180000, shell: false },
    );
  if (r.status !== 0)
    throw new Error("Compatibility operation failed: " + args[0]);
  return {
    value: JSON.parse(r.stdout),
    ms: Math.round(performance.now() - started),
  };
};
try {
  fs.mkdirSync(source);
  const random = Buffer.alloc(8 * 1024 * 1024);
  let seed = 73;
  for (let i = 0; i < random.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    random[i] = seed & 255;
  }
  const text = Buffer.from(
    "controlled documentation and source sample\n".repeat(100000),
  );
  fs.writeFileSync(path.join(source, "random.bin"), random);
  fs.writeFileSync(path.join(source, "notes.txt"), text);
  const oldRepo = path.join(root, "old"),
    newRepo = path.join(root, "new");
  run(baseline, ["init", oldRepo]);
  const old = run(baseline, ["backup", oldRepo, source]);
  run(current, ["verify", oldRepo, old.value.snapshot]);
  run(current, [
    "restore",
    oldRepo,
    old.value.snapshot,
    path.join(root, "new-reads-old"),
  ]);
  run(current, ["init", newRepo]);
  const fresh = run(current, ["backup", newRepo, source]);
  run(baseline, ["verify", newRepo, fresh.value.snapshot]);
  run(baseline, [
    "restore",
    newRepo,
    fresh.value.snapshot,
    path.join(root, "old-reads-new"),
  ]);
  const a = run(baseline, ["catalog", oldRepo, old.value.snapshot]).value,
    b = run(current, ["catalog", newRepo, fresh.value.snapshot]).value;
  assert.deepEqual(b.entries, a.entries);
  const digest = (file) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  for (const name of ["random.bin", "notes.txt"])
    for (const restored of ["new-reads-old", "old-reads-new"])
      assert.equal(
        digest(path.join(root, restored, name)),
        digest(path.join(source, name)),
      );
  const compression = [];
  for (const [name, bytes] of [
    ["random_binary", random],
    ["repeated_text", text],
    ["already_gzip", gzipSync(text)],
  ]) {
    const begin = performance.now(),
      packed = brotliCompressSync(bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      });
    compression.push({
      sample: name,
      input_bytes: bytes.length,
      compressed_bytes: packed.length,
      ratio: Number((packed.length / bytes.length).toPrecision(5)),
      elapsed_ms: Math.round(performance.now() - begin),
    });
  }
  const report = {
    version: "0.3.1",
    kind: "compatibility_and_codec_evaluation",
    ok: true,
    actual_baseline: "0.2.0",
    old_reads_new_content: true,
    new_reads_old_content: true,
    chunk_references_identical: true,
    single_sample_backup_ms: { baseline: old.ms, current: fresh.ms },
    compression_prototype_only: compression,
    compression_enabled_in_repository: false,
    production_throughput_claim: false,
  };
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  removeOwned(root, parent, "moonrestore-compat-");
}
