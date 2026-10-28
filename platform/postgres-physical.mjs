// Physical PostgreSQL adapter. Native tools validate the engine-specific WAL;
// MoonBit format-4 protects the resulting immutable files. Never runs production SQL.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checked, mkdirPrivate, stateHome } from "./vault.mjs";
import { options, removeOwned } from "./maintenance.mjs";
import { postgresEnvironment } from "./postgresql.mjs";
import { backupPaged, restorePaged } from "./paged-operations.mjs";
import { newFile, bounded, syncDirectory } from "./paged-store.mjs";
import { activity, checkpoint } from "./activity.mjs";
export function physicalClient(
  exe,
  args,
  {
    environment = process.env,
    timeoutMs = 180000,
    signal,
    cleanup = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    if (!cleanup) checkpoint("postgres_physical_client");
    const signals = [signal, cleanup ? undefined : activity()?.signal].filter(
      Boolean,
    );
    const child = spawn(exe, args, {
      env: environment,
      timeout: timeoutMs,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
      shell: false,
      windowsHide: true,
    });
    let output = "",
      diagnostic = "",
      used = 0,
      failed = false;
    child.stdout.on("data", (b) => {
      used += b.length;
      if (used > 1048576) {
        failed = true;
        child.kill();
      } else output += b.toString("utf8");
    });
    child.stderr.on("data", (b) => {
      used += b.length;
      if (diagnostic.length < 16384)
        diagnostic += b.toString("utf8").slice(0, 16384 - diagnostic.length);
      if (used > 1048576) {
        failed = true;
        child.kill();
      }
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (failed || code !== 0) {
        const tool = path.basename(exe).replace(/\.exe$/i, ""),
          known = [
            "psql",
            "pg_basebackup",
            "pg_verifybackup",
            "pg_ctl",
            "pg_waldump",
            "initdb",
          ].includes(tool)
            ? tool
            : "client";
        const reason =
          [
            "invalid permissions",
            "recovery ended before configured recovery target was reached",
            "could not open file",
            "could not restore file",
            "WAL parsing failed",
            "could not find any WAL file",
            "checksum mismatch",
            "invalid backup manifest",
            "unrecognized configuration parameter",
            "invalid value for parameter",
            "Permission denied",
          ].find((text) => diagnostic.includes(text)) ?? "unclassified";
        reject(
          new Error(
            "Physical PostgreSQL " +
              known +
              " failed (exit " +
              code +
              ", " +
              reason +
              "); raw diagnostics withheld",
          ),
        );
      } else resolve(output.trim());
    });
  });
}
export function physicalTools(directory) {
  const root = checked(directory),
    tools = {};
  for (const name of [
    "psql",
    "pg_basebackup",
    "pg_verifybackup",
    "pg_ctl",
    "pg_waldump",
  ]) {
    const full = checked(
        path.join(root, name + (process.platform === "win32" ? ".exe" : "")),
      ),
      s = fs.lstatSync(full);
    if (!s.isFile() || s.nlink !== 1)
      throw new Error("Trusted absolute PostgreSQL tools required");
    tools[name] = full;
  }
  return tools;
}
export async function validatePhysicalTools(tools, execute = physicalClient) {
  let major;
  for (const [name, exe] of Object.entries(tools)) {
    const text = await execute(exe, ["--version"]),
      m = text.match(/\(PostgreSQL\) (\d+)\./);
    if (!m || +m[1] < 16 || (major && major !== +m[1]))
      throw new Error("Matching PostgreSQL >=16 tools required");
    major = +m[1];
  }
  return major;
}
function connection(config) {
  const {
    host = "127.0.0.1",
    port = 5432,
    user,
    database = "postgres",
    allowRemote = false,
  } = config;
  if (
    !/^[A-Za-z0-9_.-]{1,253}$/.test(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    ![user, database].every((v) =>
      /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(v || ""),
    ) ||
    typeof allowRemote !== "boolean" ||
    (!["127.0.0.1", "localhost"].includes(host) && !allowRemote)
  )
    throw new Error("Explicit physical backup connection required");
  return postgresEnvironment({ host, port, user, database, allowRemote });
}
function inventory(directory, maxBytes) {
  let bytes = 0,
    entries = 0;
  const walk = (dir, depth) => {
    if (depth > 64) throw new Error("Physical tree depth");
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = checked(path.join(dir, d.name)),
        s = fs.lstatSync(full);
      if (++entries > 1000000 || s.isSymbolicLink())
        throw new Error("Physical link or entry budget");
      if (s.isDirectory()) walk(full, depth + 1);
      else if (s.isFile() && s.nlink === 1) {
        bytes += s.size;
        if (bytes > maxBytes) throw new Error("Physical byte budget");
      } else throw new Error("Physical special file");
    }
  };
  walk(directory, 0);
  return { bytes, entries };
}
export async function physicalBackup(
  repository,
  config,
  { execute = physicalClient, controlledSimulation = false } = {},
) {
  if (execute !== physicalClient && !controlledSimulation)
    throw new Error("Custom physical tools require controlled simulation");
  const tools = controlledSimulation ? config.tools : physicalTools(config.bin),
    environment = connection(config),
    major = await validatePhysicalTools(tools, execute);
  const timeoutMs = config.timeoutMs ?? 1800000,
    maxBytes = config.maxBytes ?? 10737418240;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 1800000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1048576 ||
    maxBytes > 1099511627776
  )
    throw new Error("Physical backup budget");
  const controller = new AbortController(),
    run = (name, args) =>
      execute(tools[name], args, {
        environment,
        timeoutMs,
        signal: controller.signal,
      });
  // Plain pg_basebackup would otherwise write external tablespaces at their old paths.
  const preflight = JSON.parse(
    await run("psql", [
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "SELECT json_build_object('version',current_setting('server_version_num')::int,'tablespaces',(SELECT count(*) FROM pg_tablespace WHERE pg_tablespace_location(oid)<>''),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()))::text",
    ]),
  );
  if (
    preflight.tablespaces !== 0 ||
    Math.floor(preflight.version / 10000) !== major ||
    !/^\d{1,20}$/.test(preflight.system_identifier)
  )
    throw new Error("Unsupported tablespaces or server/tool identity mismatch");
  const parent = mkdirPrivate(path.join(stateHome(), "physical-staging")),
    owned = fs.mkdtempSync(path.join(parent, "physical-")),
    base = path.join(owned, "base");
  let completed = false;
  let budgetFailure = false;
  const monitor = setInterval(() => {
    try {
      inventory(owned, maxBytes);
      checkpoint("physical_backup_budget");
    } catch {
      budgetFailure = true;
      controller.abort();
    }
  }, 200);
  try {
    // External cancellation is inherited by physicalClient. Size is also checked
    // on completion; interval checks do not assert a hard OS disk quota.
    await run("pg_basebackup", [
      "--pgdata=" + base,
      "--format=plain",
      "--wal-method=stream",
      "--no-slot",
      "--no-password",
      "--manifest-checksums=SHA256",
      "--checkpoint=spread",
    ]);
    if (budgetFailure)
      throw new Error("Physical backup monitoring budget exceeded");
    const size = inventory(base, maxBytes);
    if (
      fs.readFileSync(checked(path.join(base, "PG_VERSION")), "utf8").trim() !==
      String(major)
    )
      throw new Error("Physical major mismatch");
    await run("pg_verifybackup", [base]);
    const manifest = JSON.parse(
      bounded(path.join(base, "backup_manifest"), 33554432),
    );
    if (
      !Array.isArray(manifest["WAL-Ranges"]) ||
      manifest["WAL-Ranges"].length < 1 ||
      manifest["WAL-Ranges"].length > 1000
    )
      throw new Error("Physical WAL range required");
    newFile(
      path.join(owned, "physical.json"),
      Buffer.from(
        JSON.stringify({
          format: 1,
          kind: "postgresql_physical",
          major,
          system_identifier: preflight.system_identifier,
          created: new Date().toISOString(),
          wal_ranges: manifest["WAL-Ranges"],
        }),
      ),
    );
    const result = await backupPaged(repository, owned, {
      label: "PostgreSQL physical base with streamed WAL",
    });
    completed = true;
    return {
      ...result,
      kind: "postgresql_physical_backup",
      major,
      base_bytes: String(size.bytes),
      manifest_verified: true,
      base_wal_verified: true,
      pitr_target_verified: false,
      controlled_simulation: controlledSimulation,
      native_client_executed: !controlledSimulation,
      temporary_plaintext_export: true,
    };
  } finally {
    clearInterval(monitor);
    if (completed) removeOwned(owned, parent, "physical-");
  }
}
const walName = (v) =>
  typeof v === "string" &&
  (/^[A-F0-9]{24}$/.test(v) ||
    /^[A-F0-9]{8}\.history$/.test(v) ||
    /^[A-F0-9]{24}\.[A-F0-9]{8}\.backup$/.test(v));
function walRoot(directory) {
  const root = checked(directory);
  if (
    bounded(path.join(root, "moonrestore-wal"), 64).toString() !==
    "moonrestore-wal-archive-v1\n"
  )
    throw new Error("Explicit WAL archive required");
  return root;
}
export function initWalArchive(directory) {
  const root = checked(directory, false);
  fs.mkdirSync(root, { mode: 0o700 });
  newFile(
    path.join(root, "moonrestore-wal"),
    Buffer.from("moonrestore-wal-archive-v1\n"),
  );
  return {
    ok: true,
    initialized: true,
    production_configuration_changed: false,
  };
}
function fileDigest(file) {
  const fd = fs.openSync(checked(file), "r"),
    buffer = Buffer.alloc(65536),
    h = createHash("sha256");
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 1073741824 || s.size < 1)
      throw new Error("WAL size/link budget");
    while (true) {
      const n = fs.readSync(fd, buffer);
      if (!n) break;
      h.update(buffer.subarray(0, n));
    }
    const after = fs.fstatSync(fd);
    if (
      after.size !== s.size ||
      after.mtimeMs !== s.mtimeMs ||
      after.ctimeMs !== s.ctimeMs
    )
      throw new Error("WAL changed during hashing");
    return { size: s.size, sha256: h.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}
export function archiveWal(directory, name, source) {
  const root = walRoot(directory);
  if (!walName(name))
    throw new Error("Canonical WAL or timeline-history name required");
  source = checked(source);
  const info = fileDigest(source);
  if (!/^[A-F0-9]{24}$/.test(name) && info.size > 1048576)
    throw new Error("Timeline/backup history size budget");
  if (
    /^[A-F0-9]{24}$/.test(name) &&
    (info.size < 1048576 || (info.size & (info.size - 1)) !== 0)
  )
    throw new Error("Only complete power-of-two WAL segments are accepted");
  const target = path.join(root, name),
    record = path.join(root, name + ".json");
  if (fs.existsSync(target)) {
    const found = fileDigest(target);
    if (JSON.stringify(found) !== JSON.stringify(info))
      throw new Error("Immutable WAL conflict");
    if (
      fs.existsSync(record) &&
      JSON.stringify(JSON.parse(bounded(record, 1024))) !== JSON.stringify(info)
    )
      throw new Error("WAL receipt conflict");
    if (!fs.existsSync(record))
      newFile(record, Buffer.from(JSON.stringify(info)));
    return { ok: true, idempotent: true };
  }
  const temp = path.join(root, ".pending-" + randomUUID());
  fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
  try {
    if (JSON.stringify(fileDigest(temp)) !== JSON.stringify(info))
      throw new Error("WAL readback mismatch");
    const fd = fs.openSync(temp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.linkSync(temp, target);
    fs.unlinkSync(temp);
    newFile(record, Buffer.from(JSON.stringify(info)));
    syncDirectory(root);
    return { ok: true, idempotent: false };
  } finally {
    if (fs.existsSync(temp) && fs.lstatSync(temp).nlink === 1)
      fs.unlinkSync(temp);
  }
}
export function fetchWal(directory, name, destination) {
  const root = walRoot(directory);
  if (!walName(name)) throw new Error("Canonical WAL name required");
  const source = path.join(root, name),
    record = JSON.parse(bounded(path.join(root, name + ".json"), 1024));
  if (JSON.stringify(fileDigest(source)) !== JSON.stringify(record))
    throw new Error("WAL archive checksum mismatch");
  const target = checked(destination, false);
  if (fs.existsSync(target)) throw new Error("WAL destination must not exist");
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (JSON.stringify(fileDigest(target)) !== JSON.stringify(record))
    throw new Error("WAL destination readback mismatch");
  return { ok: true, restored: true };
}
function configLiteral(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Unsafe PostgreSQL setting");
  return "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "''") + "'";
}
export function postgresRecoveryTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error("Valid UTC recovery timestamp required");
  // Recovery GUCs are checked before timezone_abbreviations is initialized.
  // A numeric UTC offset is independent of that ordering; preserve microseconds.
  return value.slice(0, -1).replace("T", " ") + "+00";
}
export async function preparePitr(
  repository,
  snapshot,
  target,
  { bin, walArchive, recoveryTime, port = 55432, trustSource = false } = {},
) {
  if (
    !trustSource ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(
      recoveryTime || "",
    ) ||
    !Number.isFinite(Date.parse(recoveryTime)) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new Error(
      "Trusted physical source, UTC recovery time and isolated port required",
    );
  if (process.platform === "win32")
    throw new Error(
      "PITR isolated server currently requires Unix; no restore attempted",
    );
  const targetTime = postgresRecoveryTime(recoveryTime);
  const tools = physicalTools(bin),
    major = await validatePhysicalTools(tools),
    archive = walRoot(walArchive);
  await restorePaged(repository, snapshot, target);
  const material = checked(target),
    base = checked(path.join(material, "base")),
    record = JSON.parse(bounded(path.join(material, "physical.json"), 262144));
  if (
    record.kind !== "postgresql_physical" ||
    record.major !== major ||
    fs.existsSync(path.join(base, "postmaster.pid"))
  )
    throw new Error("Wrong physical source or active data directory");
  await physicalClient(tools.pg_verifybackup, [base]);
  // Generated settings replace, never include or execute source configuration.
  const helper = fileURLToPath(
    new URL("../bin/wal-fetch.mjs", import.meta.url),
  );
  const shellQuote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
  // PostgreSQL substitutes %f and %p. The validated filename has a strict grammar;
  // %p is pg_wal/<canonical name>, not caller-controlled SQL or a shell fragment.
  const restore =
    [process.execPath, helper, archive].map(shellQuote).join(" ") +
    " '%f' '%p'";
  const settings = [
    "listen_addresses = '127.0.0.1'",
    "port = " + port,
    "unix_socket_directories = ''",
    "ssl = off",
    "archive_mode = off",
    "archive_command = ''",
    "primary_conninfo = ''",
    "primary_slot_name = ''",
    "shared_preload_libraries = ''",
    "session_preload_libraries = ''",
    "local_preload_libraries = ''",
    "dynamic_library_path = '$libdir'",
    "max_logical_replication_workers = 0",
    "restore_command = " + configLiteral(restore),
    "recovery_target_time = " + configLiteral(targetTime),
    "recovery_target_timeline = 'current'",
    "recovery_target_action = 'pause'",
    "hot_standby = on",
  ];
  for (const name of [
    "postgresql.conf",
    "postgresql.auto.conf",
    "pg_hba.conf",
    "pg_ident.conf",
    "standby.signal",
    "recovery.signal",
  ]) {
    const file = checked(path.join(base, name), false);
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).nlink !== 1)
        throw new Error("Unsafe source config");
      fs.unlinkSync(file);
    }
  }
  newFile(
    path.join(base, "postgresql.conf"),
    Buffer.from(settings.join("\n") + "\n"),
  );
  newFile(path.join(base, "postgresql.auto.conf"), Buffer.alloc(0));
  newFile(
    path.join(base, "pg_hba.conf"),
    Buffer.from("host all all 127.0.0.1/32 reject\n"),
  );
  newFile(path.join(base, "pg_ident.conf"), Buffer.alloc(0));
  newFile(path.join(base, "recovery.signal"), Buffer.alloc(0));
  newFile(
    path.join(material, ".moonrestore-pitr.json"),
    Buffer.from(
      JSON.stringify({
        format: 1,
        base,
        port,
        major,
        system_identifier: record.system_identifier,
        prepared: new Date().toISOString(),
      }),
    ),
  );
  return {
    ok: true,
    kind: "pitr_isolated_preparation",
    base,
    port,
    recovery_time: recoveryTime,
    system_identifier: record.system_identifier,
    source_configuration_excluded: true,
    network_access: "loopback_reject_all",
    server_started: false,
    target_reached: false,
    next: "Use pitr-drill with a trusted source and temporary local authentication to verify the target; preparation alone is not PITR proof.",
  };
}
export async function pitrDrill(repository, snapshot, target, config = {}) {
  if (
    config.allowIsolatedServer !== true ||
    !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(config.user || "")
  )
    throw new Error(
      "Explicit trusted-source isolated server and local database role required",
    );
  const checks = config.checks ?? [];
  if (
    !Array.isArray(checks) ||
    checks.length > 32 ||
    checks.some(
      (r) =>
        !r ||
        Object.keys(r).some((k) => !["table", "rows"].includes(k)) ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(r.table || "") ||
        !Number.isSafeInteger(r.rows) ||
        r.rows < 0,
    )
  )
    throw new Error(
      "Bounded public-table row checks required, not SQL scripts",
    );
  const prepared = await preparePitr(repository, snapshot, target, config),
    tools = physicalTools(config.bin),
    base = prepared.base;
  // This opt-in starts code from a trusted PostgreSQL cluster. It is not an OS sandbox.
  // Only the newly restored data directory is ever passed to pg_ctl.
  const hba = checked(path.join(base, "pg_hba.conf"));
  fs.unlinkSync(hba);
  newFile(
    hba,
    Buffer.from(
      "host all " +
        config.user +
        " 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 reject\n",
    ),
  );
  const environment = postgresEnvironment({
    host: "127.0.0.1",
    port: prepared.port,
    user: config.user,
    database: "postgres",
    allowRemote: false,
  });
  let failed,
    result,
    stopConfirmed = false;
  try {
    await physicalClient(
      tools.pg_ctl,
      [
        "-D",
        base,
        "-l",
        path.join(target, "isolated-server.log"),
        "-w",
        "-t",
        "60",
        "start",
      ],
      { environment, timeoutMs: 90000 },
    );
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      checkpoint("pitr_target_wait");
      const value = JSON.parse(
        await physicalClient(
          tools.psql,
          [
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "SELECT json_build_object('paused',pg_is_wal_replay_paused(),'recovery',pg_is_in_recovery(),'system_identifier',(SELECT system_identifier::text FROM pg_control_system()),'replay_lsn',pg_last_wal_replay_lsn()::text)::text",
          ],
          { environment, timeoutMs: 10000 },
        ),
      );
      if (value.system_identifier !== prepared.system_identifier)
        throw new Error("Wrong recovered cluster identity");
      if (
        value.paused === true &&
        value.recovery === true &&
        /^[A-F0-9]+\/[A-F0-9]+$/i.test(value.replay_lsn)
      ) {
        for (const check of checks) {
          const count = await physicalClient(
            tools.psql,
            [
              "-X",
              "-A",
              "-t",
              "-v",
              "ON_ERROR_STOP=1",
              "-c",
              'SELECT count(*) FROM public."' + check.table + '"',
            ],
            { environment, timeoutMs: 10000 },
          );
          if (count !== String(check.rows))
            throw new Error("Isolated recovered content check failed");
        }
        result = {
          ok: true,
          kind: "postgresql_pitr_drill",
          target_reached: true,
          recovery_paused: true,
          isolated_server_started: true,
          business_data_verified: false,
          table_row_checks_passed: checks.length,
          real_user_pilot: false,
          production_modified: false,
        };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!result) throw new Error("Requested recovery target was not confirmed");
  } catch (error) {
    failed = error;
  } finally {
    // Cancellation must never suppress cleanup of this newly created server.
    // Close local trust on disk first, then request reload/stop on the exact base.
    try {
      fs.unlinkSync(hba);
      newFile(hba, Buffer.from("host all all 127.0.0.1/32 reject\n"));
    } catch {
      failed ??= new Error(
        "Temporary HBA reset failed; do not restart this retained recovery directory",
      );
    }
    if (fs.existsSync(path.join(base, "postmaster.pid")))
      try {
        await physicalClient(tools.pg_ctl, ["-D", base, "reload"], {
          environment,
          timeoutMs: 10000,
          cleanup: true,
        });
      } catch {}
    try {
      await physicalClient(
        tools.pg_ctl,
        ["-D", base, "-w", "-t", "30", "-m", "fast", "stop"],
        { environment, timeoutMs: 45000, cleanup: true },
      );
      stopConfirmed = !fs.existsSync(path.join(base, "postmaster.pid"));
    } catch {
      stopConfirmed = !fs.existsSync(path.join(base, "postmaster.pid"));
    }
  }
  if (!stopConfirmed)
    throw new AggregateError(
      failed ? [failed] : [],
      "Exact isolated server shutdown unconfirmed; retain the recovery directory",
    );
  if (failed) throw failed;
  return { ...result, isolated_server_stopped: true };
}
export async function physicalCommand(args) {
  const [command, ...rest] = args;
  if (
    ![
      "postgres-physical-backup",
      "wal-archive-init",
      "wal-archive-put",
      "pitr-prepare",
      "pitr-drill",
    ].includes(command)
  )
    return null;
  if (command === "wal-archive-init" && rest.length === 1)
    return initWalArchive(rest[0]);
  if (command === "wal-archive-put" && rest.length === 3)
    return archiveWal(...rest);
  const { positionals: p, values: v } = options(
    rest,
    [
      "bin",
      "host",
      "port",
      "database",
      "user",
      "allow-remote",
      "max-bytes",
      "wal",
      "time",
      "confirm",
      "trust-source",
      "allow-isolated-server",
    ],
    ["allow-remote", "trust-source", "allow-isolated-server"],
  );
  if (
    command === "postgres-physical-backup" &&
    p.length === 1 &&
    Object.keys(v).every((k) =>
      [
        "bin",
        "host",
        "port",
        "database",
        "user",
        "allow-remote",
        "max-bytes",
      ].includes(k),
    )
  )
    return physicalBackup(p[0], {
      bin: v.bin,
      host: v.host,
      port: v.port === undefined ? 5432 : Number(v.port),
      database: v.database,
      user: v.user,
      allowRemote: !!v["allow-remote"],
      maxBytes:
        v["max-bytes"] === undefined ? undefined : Number(v["max-bytes"]),
    });
  if (
    command === "pitr-prepare" &&
    p.length === 3 &&
    v.confirm === p[2] &&
    Object.keys(v).every((k) =>
      ["bin", "port", "wal", "time", "confirm", "trust-source"].includes(k),
    )
  )
    return preparePitr(...p, {
      bin: v.bin,
      walArchive: v.wal,
      recoveryTime: v.time,
      port: v.port === undefined ? 55432 : Number(v.port),
      trustSource: !!v["trust-source"],
    });
  if (
    command === "pitr-drill" &&
    p.length === 3 &&
    v.confirm === p[2] &&
    Object.keys(v).every((k) =>
      [
        "bin",
        "port",
        "wal",
        "time",
        "confirm",
        "trust-source",
        "allow-isolated-server",
        "user",
      ].includes(k),
    )
  )
    return pitrDrill(...p, {
      bin: v.bin,
      walArchive: v.wal,
      recoveryTime: v.time,
      port: v.port === undefined ? 55432 : Number(v.port),
      trustSource: !!v["trust-source"],
      allowIsolatedServer: !!v["allow-isolated-server"],
      user: v.user,
    });
  throw new Error("Invalid physical recovery command");
}
