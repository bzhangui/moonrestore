// Small reproducible synthetic profile; never scans personal directories.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  backupPaged,
  verifyPaged,
  restorePaged,
} from "../platform/paged-operations.mjs";
const size = Number(process.argv[2] ?? 8);
const shape = process.argv[3] ?? "repeated";
if (
  !Number.isInteger(size) ||
  size < 1 ||
  size > 64 ||
  !["repeated", "unique", "compressible"].includes(shape) ||
  process.argv.length > 4
)
  throw new Error("Synthetic profile 1..64 MiB only");
const parent = fs.realpathSync(os.tmpdir()),
  base = fs.mkdtempSync(path.join(parent, "moonrestore-profile-")),
  old = process.env.MOONRESTORE_HOME;
process.env.MOONRESTORE_HOME = path.join(base, "home");
const original = Object.fromEntries(
  ["readSync", "writeSync", "fsyncSync", "readFileSync"].map((k) => [k, fs[k]]),
);
let current;
for (const key of Object.keys(original))
  fs[key] = function (...args) {
    const started = performance.now(),
      r = original[key].apply(fs, args);
    if (current) {
      current.calls[key]++;
      current.time_ms[key] += performance.now() - started;
      if (key === "readSync") current.read_bytes += r;
      if (key === "writeSync") current.write_bytes += r;
      if (key === "readFileSync") current.read_bytes += Buffer.byteLength(r);
    }
    return r;
  };
const disk = (folder) => {
  let bytes = 0;
  for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
    const p = path.join(folder, d.name);
    bytes += d.isDirectory() ? disk(p) : fs.lstatSync(p).size;
  }
  return bytes;
};
const stages = [];
async function stage(name, work) {
  current = {
    name,
    calls: Object.fromEntries(Object.keys(original).map((k) => [k, 0])),
    time_ms: Object.fromEntries(Object.keys(original).map((k) => [k, 0])),
    read_bytes: 0,
    write_bytes: 0,
  };
  const start = performance.now(),
    cpu = process.cpuUsage();
  const result = await work();
  current.elapsed_ms = performance.now() - start;
  current.cpu_microseconds = process.cpuUsage(cpu);
  current.rss_bytes = process.memoryUsage().rss;
  current.process_high_water_rss_bytes = process.resourceUsage().maxRSS * 1024;
  current.owned_disk_bytes = disk(base);
  stages.push(current);
  current = null;
  return result;
}
try {
  const available = fs.statfsSync(parent);
  if (
    BigInt(available.bavail) * BigInt(available.bsize) <
    BigInt(size + 256) * 1048576n
  )
    throw new Error("Insufficient temporary space");
  const source = path.join(base, "source"),
    repo = path.join(base, "repo"),
    target = path.join(base, "restore");
  fs.mkdirSync(source);
  const block = Buffer.alloc(1048576);
  let x = 20261031;
  for (let i = 0; i < block.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    block[i] = x & 255;
  }
  for (let i = 0; i < size; i++) {
    const b = Buffer.from(block);
    if (shape === "unique")
      for (let j = 0; j < b.length; j++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        b[j] = x & 255;
      }
    if (shape === "compressible") b.fill(i % 2);
    b.writeUInt32BE(i);
    fs.writeFileSync(path.join(source, "file-" + i), b);
  }
  fs.writeFileSync(path.join(source, "配置.json"), '{"profile":1}');
  await PagedStore.create(repo);
  const first = await stage("cold_backup", () => backupPaged(repo, source));
  await stage("unchanged_backup", () => backupPaged(repo, source));
  await stage("full_content_verify", () => verifyPaged(repo, first.snapshot));
  await stage("restore_and_readback", () =>
    restorePaged(repo, first.snapshot, target),
  );
  for (const name of fs.readdirSync(source)) {
    const a = createHash("sha256")
        .update(original.readFileSync(path.join(source, name)))
        .digest("hex"),
      b = createHash("sha256")
        .update(original.readFileSync(path.join(target, name)))
        .digest("hex");
    if (a !== b) throw new Error("Profile restore mismatch");
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        kind: "controlled_resource_profile",
        synthetic_mib: size,
        dataset_shape: shape,
        platform: process.platform,
        node: process.version,
        stages,
        all_readbacks_verified: true,
        native_child_memory_measured: false,
        physical_io_counters: false,
        production_benchmark: false,
      },
      null,
      2,
    ),
  );
} finally {
  for (const [key, value] of Object.entries(original)) fs[key] = value;
  if (old === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = old;
  if (
    path.dirname(base) !== parent ||
    !path.basename(base).startsWith("moonrestore-profile-")
  )
    throw new Error("Profile cleanup ownership");
  fs.rmSync(base, { recursive: true, force: true });
}
