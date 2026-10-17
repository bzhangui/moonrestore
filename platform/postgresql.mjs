// PostgreSQL logical export, not cluster/PITR backup. Never restores into a
// running database here: archive expansion and disk readback are distinct proof.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { checked, mkdirPrivate, stateHome } from "./vault.mjs";
import { core, drill, options, removeOwned } from "./maintenance.mjs";
import { activity, checkpoint } from "./activity.mjs";
function executable(input, name) {
  if (!path.isAbsolute(input))
    throw new Error("Explicit absolute PostgreSQL executable required");
  const p = checked(fs.realpathSync(input)),
    s = fs.statSync(p);
  if (
    !s.isFile() ||
    s.nlink !== 1 ||
    !new RegExp("^" + name + "(?:\\.exe)?$", "i").test(path.basename(p))
  )
    throw new Error("Unexpected PostgreSQL executable");
  return p;
}
export function postgresClient(
  exe,
  args,
  { environment, timeoutMs, maxBytes, output } = {},
) {
  return new Promise((resolve, reject) => {
    checkpoint("postgres_client");
    const signal = activity()?.signal;
    if (signal?.aborted) {
      reject(new Error("PostgreSQL operation cancelled"));
      return;
    }
    const child = spawn(exe, args, {
      shell: false,
      windowsHide: true,
      env: environment,
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
    let used = 0,
      failure = false;
    const consume = (b) => {
      used += b.length;
      if (used > 1048576) {
        failure = true;
        child.kill();
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timer = setInterval(() => {
      try {
        checkpoint("postgres_export");
        if (
          output &&
          fs.existsSync(output) &&
          fs.statSync(output).size > maxBytes
        ) {
          failure = true;
          child.kill();
        }
      } catch {
        failure = true;
        child.kill();
      }
    }, 100);
    child.on("error", () => {
      failure = true;
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (failure || code !== 0)
        reject(
          new Error(
            "PostgreSQL client failed, cancelled or exceeded its budget (details hidden)",
          ),
        );
      else resolve();
    });
  });
}
export async function postgresBackup(
  repository,
  config,
  { client = postgresClient, controlledSimulation = false } = {},
) {
  if (client !== postgresClient && !controlledSimulation)
    throw new Error("Custom client requires a labeled controlled simulation");
  repository = checked(repository);
  const {
    database,
    host = "127.0.0.1",
    port = 5432,
    user,
    dumpExecutable,
    restoreExecutable,
    allowRemote = false,
    timeoutMs = 120000,
    maxBytes = 1073741824,
  } = config;
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(database || "") ||
    !/^[A-Za-z0-9_.-]{1,253}$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(user || "") ||
    typeof allowRemote !== "boolean" ||
    (!["127.0.0.1", "localhost"].includes(host) && !allowRemote) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 1800000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 2147483648
  )
    throw new Error(
      "Invalid PostgreSQL configuration or explicit remote permission missing",
    );
  const dump = controlledSimulation
      ? dumpExecutable
      : executable(dumpExecutable, "pg_dump"),
    restore = controlledSimulation
      ? restoreExecutable
      : executable(restoreExecutable, "pg_restore");
  const parent = mkdirPrivate(path.join(stateHome(), "application-staging")),
    owned = fs.mkdtempSync(path.join(parent, "postgres-stage-")),
    archive = path.join(owned, "database.dump"),
    expanded = path.join(owned, "validation.sql");
  // Pass credentials only via caller's environment/passfile, never CLI/report.
  const environment = {
    ...process.env,
    PGHOST: host,
    PGHOSTADDR: "",
    PGPORT: String(port),
    PGDATABASE: database,
    PGUSER: user,
    PGCONNECT_TIMEOUT: "10",
    PGSSLMODE: allowRemote ? "verify-full" : "prefer",
    PGSERVICE: "",
    PGSERVICEFILE: "",
    PGOPTIONS: "",
    PGAPPNAME: "moonrestore",
  };
  const execute = (exe, args, output) =>
    client(exe, args, { environment, timeoutMs, maxBytes, output });
  try {
    await execute(
      dump,
      ["--format=custom", "--no-password", "--file=" + archive],
      archive,
    );
    const stat = fs.lstatSync(checked(archive));
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      stat.size < 5
    )
      throw new Error("Invalid PostgreSQL archive");
    const fd = fs.openSync(archive, "r"),
      magic = Buffer.alloc(5);
    try {
      fs.readSync(fd, magic, 0, 5, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (magic.toString() !== "PGDMP")
      throw new Error("PostgreSQL custom archive required");
    await execute(restore, ["--list", archive]);
    await execute(
      restore,
      ["--no-owner", "--no-acl", "--file=" + expanded, archive],
      expanded,
    );
    const sql = fs.lstatSync(checked(expanded));
    if (!sql.isFile() || sql.nlink !== 1 || sql.size > maxBytes)
      throw new Error("PostgreSQL expansion budget");
    fs.unlinkSync(expanded); // Owned temporary SQL; never execute untrusted dump code.
    const b = await core([
      "backup",
      repository,
      owned,
      "--label",
      "PostgreSQL logical export",
    ]);
    await core(["verify", repository, b.snapshot]);
    const restored = await drill(repository, b.snapshot);
    return {
      ok: restored.ok,
      kind: "postgresql_logical_backup",
      snapshot: b.snapshot,
      scope: "single_database_no_cluster_globals_or_pitr",
      archive_expanded: true,
      post_restore_readback: restored.post_restore_readback === true,
      database_restore_executed: false,
      controlled_simulation: controlledSimulation,
      native_client_executed: !controlledSimulation,
      temporary_plaintext_export: true,
      real_user_pilot: false,
    };
  } finally {
    removeOwned(owned, parent, "postgres-stage-");
  }
}
export async function postgresCommand(args) {
  if (args[0] !== "postgres-backup") return null;
  const { values: v, positionals: p } = options(
    args.slice(1),
    [
      "database",
      "host",
      "port",
      "user",
      "pg-dump",
      "pg-restore",
      "allow-remote",
      "timeout",
    ],
    ["allow-remote"],
  );
  if (p.length !== 1)
    throw new Error(
      "Usage: postgres-backup REPO --database DB --user USER --pg-dump ABS --pg-restore ABS",
    );
  return postgresBackup(p[0], {
    database: v.database,
    user: v.user,
    host: v.host,
    port: v.port === undefined ? 5432 : Number(v.port),
    dumpExecutable: v["pg-dump"],
    restoreExecutable: v["pg-restore"],
    allowRemote: v["allow-remote"] === true,
    timeoutMs: v.timeout === undefined ? 120000 : Number(v.timeout),
  });
}
