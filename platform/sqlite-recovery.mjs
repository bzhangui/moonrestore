import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checked, readPrivate } from "./vault.mjs";
import { core, options } from "./maintenance.mjs";
import { activity, checkpoint } from "./activity.mjs";

export async function verifySqliteRecovery(
  file,
  checks = { format: 1, tables: [] },
  { timeoutMs = 30000, referenceRoot } = {},
) {
  file = checked(file);
  const stat = fs.lstatSync(file),
    input = JSON.stringify(checks);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 68719476736 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 1800000 ||
    Buffer.byteLength(input) > 65536
  )
    throw new Error("Invalid bounded SQLite recovery verification");
  checkpoint("sqlite_recovery_verify");
  const before = fs.lstatSync(file, { bigint: true });
  const sidecars = () =>
    Object.fromEntries(
      ["-wal", "-journal"].map((suffix) => {
        if (!fs.existsSync(file + suffix)) return [suffix, null];
        const s = fs.lstatSync(checked(file + suffix), { bigint: true });
        if (!s.isFile() || s.nlink !== 1n || s.size > 68719476736n)
          throw new Error("Invalid recovered database sidecar");
        return [
          suffix,
          s.size === 0n
            ? null
            : ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
                .map((k) => String(s[k]))
                .join(":"),
        ];
      }),
    );
  if (fs.existsSync(file + "-shm")) {
    const shm = fs.lstatSync(checked(file + "-shm"));
    if (!shm.isFile() || shm.nlink !== 1)
      throw new Error("Invalid recovered SQLite shared-memory sidecar");
  }
  const payloadSidecars = sidecars();
  return new Promise((resolve, reject) => {
    const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../bin/sqlite-verify.mjs", import.meta.url)),
          file,
          ...(referenceRoot ? [checked(referenceRoot)] : []),
        ],
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          signal: activity()?.signal,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
      chunks = [];
    let bytes = 0,
      failure;
    child.stdin.on("error", () => {});
    child.stdout.on("data", (b) => {
      bytes += b.length;
      if (bytes > 4096) {
        failure = new Error("SQLite recovery output budget");
        child.kill();
      } else chunks.push(b);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      failure = new Error(
        "SQLite recovery verification interrupted or unavailable",
      );
    });
    child.on("close", (code) => {
      try {
        if (failure) throw failure;
        if (code !== 0)
          throw new Error(
            "SQLite recovery checks failed; restored new target retained for private inspection",
          );
        const result = JSON.parse(Buffer.concat(chunks));
        if (result.ok !== true || result.sqlite_integrity_checked !== true)
          throw new Error("Incomplete verification");
        const after = fs.lstatSync(checked(file), { bigint: true });
        if (
          ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].some(
            (k) => before[k] !== after[k],
          ) ||
          JSON.stringify(payloadSidecars) !== JSON.stringify(sidecars())
        )
          throw new Error("Recovered database changed during validation");
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(input);
  });
}
export async function recoverSqlite(
  repository,
  snapshot,
  destination,
  { checks = { format: 1, tables: [] }, confirmation, timeoutMs = 30000 } = {},
) {
  if (typeof destination !== "string" || confirmation !== destination)
    throw new Error("Confirm the exact new SQLite recovery directory");
  destination = checked(destination, false);
  const restored = await core(["restore", repository, snapshot, destination]);
  const verification = await verifySqliteRecovery(
    path.join(destination, "database.sqlite"),
    checks,
    { timeoutMs },
  );
  return {
    ok: restored.ok && verification.ok,
    kind: "sqlite_isolated_recovery",
    destination,
    ...verification,
    production_overwritten: false,
    source_repository_unchanged: true,
    external_application_started: false,
  };
}
export async function sqliteRecoveryCommand(args) {
  if (args[0] !== "sqlite-recover") return null;
  const { positionals: p, values: v } = options(args.slice(1), [
    "checks",
    "confirm",
    "timeout",
  ]);
  if (p.length !== 3)
    throw new Error(
      "sqlite-recover REPO SNAPSHOT NEW_DIR --confirm NEW_DIR [--checks PRIVATE_JSON --timeout MS]",
    );
  const checks = v.checks
    ? JSON.parse(readPrivate(checked(v.checks), 65536))
    : { format: 1, tables: [] };
  return recoverSqlite(...p, {
    checks,
    confirmation: v.confirm,
    timeoutMs: v.timeout === undefined ? 30000 : Number(v.timeout),
  });
}
