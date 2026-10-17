// Opt-in real >2 GiB streaming regression. Uses owned temporary data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { cli, removeOwned, saveReport } from "../platform/maintenance.mjs";
const durable = process.argv.includes("--durable-restore");
if (process.argv.slice(2).some((a) => a !== "--durable-restore"))
  throw new Error("Only --durable-restore is supported");
const parent = fs.realpathSync(os.tmpdir()),
  space = fs.statfsSync(parent, { bigint: true });
if (space.bavail * space.bsize < 6n * 1024n * 1024n * 1024n)
  throw new Error(
    "At least 6 GiB free on the temporary filesystem is required",
  );
const root = fs.mkdtempSync(path.join(parent, "moonrestore-large-")),
  source = path.join(root, "source"),
  repo = path.join(root, "vault"),
  target = path.join(root, "restored");
const size = 2147483649;
let active,
  interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
  active?.kill();
});
const steps = [];
async function run(args) {
  console.log("Starting " + args[0] + " for controlled >2 GiB sample");
  const start = performance.now();
  const value = await new Promise((resolve, reject) => {
    active = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        MOONRESTORE_HOME: path.join(root, "state"),
        MOONRESTORE_PROFILE: "1",
      },
      windowsHide: true,
      shell: false,
    });
    let out = "",
      err = "";
    const timer = setTimeout(() => active.kill(), 3600000);
    active.stdout.on("data", (b) => {
      if (out.length < 1048576) out += b;
    });
    active.stderr.on("data", (b) => {
      if (err.length < 65536) err += b;
    });
    active.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    active.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new Error("Large regression failed/interrupted at " + args[0]),
        );
      try {
        const profile = err
          .split(/\r?\n/)
          .filter(Boolean)
          .map((s) => {
            try {
              return JSON.parse(s);
            } catch {
              return {};
            }
          })
          .find((p) => p.profile);
        steps.push({
          operation: args[0],
          elapsed_ms: Math.round(performance.now() - start),
          profile,
        });
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        reject(e);
      }
    });
  });
  active = null;
  if (interrupted) throw new Error("Interrupted");
  return value;
}
async function digest(file) {
  const h = createHash("sha256");
  for await (const block of fs.createReadStream(file)) h.update(block);
  return h.digest("hex");
}
try {
  fs.mkdirSync(source);
  const input = path.join(source, "large.bin"),
    fd = fs.openSync(input, "wx");
  fs.ftruncateSync(fd, size);
  fs.writeSync(fd, Buffer.from("ending"), 0, 6, size - 6);
  fs.closeSync(fd);
  await run(["init-large", repo]);
  const snapshot = await run([
    "backup",
    repo,
    source,
    "--min",
    "1048576",
    "--avg",
    "1048576",
    "--max",
    "1048576",
  ]);
  if (snapshot.logical_bytes !== String(size))
    throw new Error("Large size precision mismatch");
  await run(["verify", repo, snapshot.snapshot]);
  await run([
    durable ? "restore-resumable" : "restore",
    repo,
    snapshot.snapshot,
    target,
  ]);
  const actual = await digest(path.join(target, "large.bin")),
    expected = await digest(input);
  if (actual !== expected) throw new Error("Large restored file differs");
  const report = {
    format: 1,
    version: "0.5.0",
    kind: "large_file_regression",
    ok: true,
    bytes: String(size),
    sha256: actual,
    steps,
    controlled_sample: true,
    maximum_profile_scale_verified: false,
    production_soak: false,
    durable_restore: durable,
  };
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  active?.kill();
  removeOwned(root, parent, "moonrestore-large-");
}
