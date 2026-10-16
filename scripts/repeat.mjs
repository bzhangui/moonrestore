// Bounded controlled repeatability, not a production soak or real-user pilot.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  core,
  health,
  drill,
  replicate,
  removeOwned,
  saveReport,
} from "../platform/maintenance.mjs";
const rounds = Number(process.argv[2] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30)
  throw new Error("Rounds must be 1..30");
const smallFiles = Number(process.argv[3] ?? 120);
if (!Number.isInteger(smallFiles) || smallFiles < 1 || smallFiles > 10000)
  throw new Error("Small file count must be 1..10000");
const parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-repeat-"));
const reports = [];
try {
  for (let round = 0; round < rounds; round++) {
    const base = path.join(root, String(round));
    fs.mkdirSync(base);
    const source = path.join(base, "source");
    fs.mkdirSync(source);
    const repo = path.join(base, "repo");
    for (let file = 0; file < smallFiles; file++)
      fs.writeFileSync(
        path.join(source, `sample-${file}.bin`),
        Buffer.alloc(4096, (file + round) % 251),
      );
    fs.writeFileSync(
      path.join(source, "large.bin"),
      Buffer.alloc(8 * 1024 * 1024, round + 1),
    );
    const started = performance.now();
    await core(["init", repo]);
    const snapshots = [];
    for (let revision = 0; revision < 3; revision++) {
      fs.writeFileSync(path.join(source, "revision.txt"), String(revision));
      snapshots.push((await core(["backup", repo, source])).snapshot);
    }
    const audit = await health(repo, "all", {
      directory: path.join(base, "reports"),
    });
    const recovered = await drill(repo, snapshots[0], {
      parent: base,
      directory: path.join(base, "reports"),
    });
    const copied = await replicate(repo, path.join(base, "replica"));
    if (!audit.ok || !recovered.ok || !copied.ok)
      throw new Error("Controlled repeatability assertion failed");
    reports.push({
      round: round + 1,
      ok: true,
      files: smallFiles + 2,
      versions: 3,
      elapsed_ms: Math.round(performance.now() - started),
      restored_files: recovered.restored_files,
    });
  }
  const report = {
    format: 1,
    version: "0.3.0",
    kind: "controlled_repeatability",
    ok: true,
    rounds,
    reports,
    real_user_pilot: false,
    production_soak: false,
    independent_device_verified: false,
  };
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  removeOwned(root, parent, "moonrestore-repeat-");
}
