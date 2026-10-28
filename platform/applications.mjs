import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { core, openHost, drill, options, removeOwned } from "./maintenance.mjs";
import { checked, mkdirPrivate, stateHome } from "./vault.mjs";
import { activity, checkpoint, credentials } from "./activity.mjs";
import { verifySqliteRecovery } from "./sqlite-recovery.mjs";
import { repositoryKind } from "./repository-kind.mjs";
import { runEngine } from "./engine-client.mjs";

export async function sqliteBackup(
  repository,
  database,
  { label = "SQLite consistent export", timeoutMs = 120000 } = {},
) {
  database = checked(database);
  repository = checked(repository);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 1800000 ||
    typeof label !== "string" ||
    Buffer.byteLength(label) > 256
  )
    throw new Error("Invalid SQLite export options");
  const stat = fs.lstatSync(database);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 68719476736)
    throw new Error("SQLite source must be a bounded regular file");
  const root =
    process.platform === "win32" ? repository.toLowerCase() : repository;
  const source =
    process.platform === "win32" ? database.toLowerCase() : database;
  if (source === root || source.startsWith(root + path.sep))
    throw new Error("Database cannot be inside its backup repository");
  const host = repositoryKind(repository).paged
    ? null
    : openHost(repository, {
        environment: {
          ...process.env,
          ...credentials(repository),
          MOONRESTORE_READ_ONLY: "1",
        },
      });
  if (host) host.clean();
  else await runEngine("capabilities", { repository });
  const parent = mkdirPrivate(path.join(stateHome(), "application-staging"));
  const owned = fs.mkdtempSync(path.join(parent, "sqlite-stage-")),
    output = path.join(owned, "database.sqlite");
  try {
    const exported = await new Promise((resolve, reject) => {
      checkpoint("sqlite_online_export");
      const signal = activity()?.signal;
      if (signal?.aborted) {
        reject(new Error("SQLite export cancelled"));
        return;
      }
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../bin/sqlite-export.mjs", import.meta.url)),
          database,
          output,
        ],
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          ...(signal ? { signal } : {}),
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (b) => {
        stdout += b;
        if (stdout.length > 4096) child.kill();
      });
      child.stderr.on("data", (b) => {
        stderr += b;
        let newline;
        while ((newline = stderr.indexOf("\n")) >= 0) {
          const line = stderr.slice(0, newline);
          stderr = stderr.slice(newline + 1);
          if (line.startsWith("MR_SQLITE:")) {
            try {
              checkpoint("sqlite_online_export", JSON.parse(line.slice(10)));
            } catch {
              child.kill();
            }
          }
        }
        if (stderr.length > 4096) child.kill();
      });
      let failure;
      child.on("error", () => {
        failure = new Error("SQLite export interrupted or unavailable");
      });
      child.on("close", (code) => {
        try {
          if (failure) throw failure;
          if (code !== 0)
            throw new Error(
              "SQLite online export failed; no new snapshot was requested",
            );
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
    if (!exported.ok || !exported.sqlite_integrity_checked)
      throw new Error("SQLite export evidence missing");
    const backed = await core(["backup", repository, owned, "--label", label]);
    const audit = await core(["audit", repository, backed.snapshot], {
      env: { MOONRESTORE_READ_ONLY: "1" },
    });
    const restored = await drill(repository, backed.snapshot);
    const restoredDirectory = path.join(owned, "verified-restore");
    await core(["restore", repository, backed.snapshot, restoredDirectory]);
    const reopened = await verifySqliteRecovery(
      path.join(restoredDirectory, "database.sqlite"),
    );
    return {
      ok: audit.ok && restored.ok && reopened.ok,
      kind: "sqlite_consistent_backup",
      snapshot: backed.snapshot,
      sqlite_integrity_checked: true,
      restored_database_opened: true,
      restored_foreign_keys_checked: reopened.foreign_keys_checked,
      file_hash: exported.hash,
      export_bytes: exported.bytes,
      recovery_drill: restored.ok,
      post_restore_readback: restored.post_restore_readback === true,
      scope: "one_sqlite_main_database",
      cross_database_transaction_consistency: false,
      temporary_plaintext_export: true,
      real_user_pilot: false,
    };
  } finally {
    removeOwned(owned, parent, "sqlite-stage-");
  }
}

export async function applicationCommand(args) {
  if (args[0] !== "sqlite-backup") return null;
  const { values: v, positionals: p } = options(args.slice(1), [
    "label",
    "timeout",
  ]);
  if (p.length !== 2)
    throw new Error(
      "Usage: sqlite-backup REPOSITORY DATABASE [--label text] [--timeout ms]",
    );
  return sqliteBackup(...p, {
    label: v.label,
    timeoutMs: v.timeout === undefined ? 120000 : Number(v.timeout),
  });
}
