// Opt-in real >2 GiB streaming regression. Uses owned temporary data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { cli, removeOwned, saveReport } from "../platform/maintenance.mjs";
import {
  createOperation,
  runOperation,
  operationStatus,
} from "../platform/operations.mjs";
const durable = process.argv.includes("--durable-restore");
const checkpointResume = process.argv.includes("--checkpoint-resume");
if (
  process.argv
    .slice(2)
    .some((a) => !["--durable-restore", "--checkpoint-resume"].includes(a))
)
  throw new Error(
    "Only --durable-restore and --checkpoint-resume are supported",
  );
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
const priorHome = process.env.MOONRESTORE_HOME,
  priorCrash = process.env.MOONRESTORE_TEST_CRASH;
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
  let snapshot;
  if (checkpointResume) {
    process.env.MOONRESTORE_HOME = path.join(root, "state");
    const id = await createOperation({
        repository: repo,
        source,
        arguments: ["--min", "1048576", "--avg", "1048576", "--max", "1048576"],
      }),
      start = performance.now();
    console.log(
      "Starting actual >2 GiB backup interruption at 1024 committed chunks",
    );
    process.env.MOONRESTORE_TEST_CRASH = "checkpoint-chunks";
    try {
      await runOperation(repo, id);
      throw new Error("Expected backup interruption missing");
    } catch {
      const stopped = operationStatus(repo, id);
      if (
        stopped.state !== "failed" ||
        stopped.checkpoint_chunks !== 1024 ||
        fs.readdirSync(path.join(repo, "snapshots")).length
      )
        throw new Error("Expected partial checkpoint/no snapshot not observed");
    } finally {
      if (priorCrash === undefined) delete process.env.MOONRESTORE_TEST_CRASH;
      else process.env.MOONRESTORE_TEST_CRASH = priorCrash;
    }
    steps.push({
      operation: "backup-interrupted-at-1024-chunks",
      elapsed_ms: Math.round(performance.now() - start),
    });
    const resumed = performance.now();
    snapshot = await runOperation(repo, id, { recover: true });
    if (snapshot.state !== "completed" || snapshot.checkpoint_chunks < 2048)
      throw new Error("Large partial checkpoint resume incomplete");
    steps.push({
      operation: "backup-resume-with-prefix-reread",
      elapsed_ms: Math.round(performance.now() - resumed),
      checkpoint_chunks: snapshot.checkpoint_chunks,
      worker_rss_measured: false,
    });
    snapshot.logical_bytes = (
      await run(["catalog", repo, snapshot.snapshot])
    ).entries
      .filter((e) => e.kind === "file")
      .reduce((sum, e) => sum + BigInt(e.size), 0n)
      .toString();
    if (priorHome === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = priorHome;
  } else
    snapshot = await run([
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
    version: JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url)),
    ).version,
    kind: "large_file_regression",
    ok: true,
    bytes: String(size),
    sha256: actual,
    steps,
    controlled_sample: true,
    maximum_profile_scale_verified: false,
    production_soak: false,
    durable_restore: durable,
    actual_chunk_interruption_and_resume: checkpointResume,
  };
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  if (priorHome === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = priorHome;
  if (priorCrash === undefined) delete process.env.MOONRESTORE_TEST_CRASH;
  else process.env.MOONRESTORE_TEST_CRASH = priorCrash;
  active?.kill();
  removeOwned(root, parent, "moonrestore-large-");
}
