// Versioned, private application plans. No passwords/tokens in configuration.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { checked, mkdirPrivate, readPrivate, stateHome } from "./vault.mjs";
import { atomicPrivate, operationId, repositoryBinding } from "./journal.mjs";
import {
  core,
  hash,
  openHost,
  drill,
  capacity,
  replicate,
  options,
} from "./maintenance.mjs";
import { credentials } from "./activity.mjs";
import {
  createOperation,
  runOperation,
  operationStatus,
} from "./operations.mjs";
import { sqliteBackup } from "./applications.mjs";
import { postgresBackup } from "./postgresql.mjs";
import { S3Backend, validateS3Destination } from "./s3.mjs";
import { pushSnapshot } from "./remote.mjs";
import { repositoryKind } from "./repository-kind.mjs";
import { runEngine } from "./engine-client.mjs";
const planFile = (id) =>
  path.join(
    mkdirPrivate(path.join(stateHome(), "plans-v1")),
    operationId(id) + ".json",
  );
const normalize = (p) =>
  process.platform === "win32"
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
function strict(v, allowed) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !allowed.includes(k))
  )
    throw new Error("Unknown plan fields; never store credential values");
}
function bound(repository) {
  if (repositoryKind(repository).paged)
    return repositoryBinding({
      repo: checked(repository),
      vault: fs.existsSync(path.join(repository, "encryption.json"))
        ? JSON.parse(
            readPrivate(path.join(repository, "encryption.json"), 4096),
          )
        : null,
    });
  const h = openHost(repository, {
    environment: {
      ...process.env,
      ...credentials(repository),
      MOONRESTORE_READ_ONLY: "1",
    },
  });
  try {
    return repositoryBinding(h);
  } finally {
    h.clean();
  }
}
function guardFile(repository) {
  return path.join(
    mkdirPrivate(path.join(stateHome(), "cleanup-guards")),
    hash(normalize(repository)) + ".json",
  );
}
export function setCleanupGuard(repository, state, scope = "default") {
  const file = guardFile(repository),
    binding = bound(repository);
  const lock = file + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const prior = fs.existsSync(file)
      ? JSON.parse(readPrivate(file, 262144))
      : { binding, scopes: {} };
    if (prior.binding !== binding)
      throw new Error("Cleanup guard repository identity changed");
    const scopes = prior.scopes || { legacy: prior };
    if (Object.keys(scopes).length >= 1000 && !Object.hasOwn(scopes, scope))
      throw new Error("Cleanup guard scope budget");
    scopes[scope] = state;
    atomicPrivate(file, Buffer.from(JSON.stringify({ binding, scopes })));
  } finally {
    fs.rmdirSync(lock);
  }
}
export function assertCleanupGuard(repository, now = Date.now()) {
  const file = guardFile(repository);
  if (fs.existsSync(file + ".lock"))
    throw new Error(
      "Cleanup guard update active or interrupted; inspect private state before cleaning",
    );
  if (!fs.existsSync(file)) return;
  const g = JSON.parse(readPrivate(file, 262144));
  if (
    g.binding !== bound(repository) ||
    !g.scopes ||
    Object.values(g.scopes).some(
      (s) =>
        s.blocked !== false ||
        !Number.isSafeInteger(s.updated) ||
        now < s.updated ||
        now - s.updated > 86400000,
    )
  )
    throw new Error(
      "Cleanup safety guard is blocked/stale or clock/identity changed; run and verify the configured plan first",
    );
}
export function savePlan(config) {
  strict(config, [
    "name",
    "type",
    "repository",
    "source",
    "postgres",
    "replica",
    "remote",
    "dropPercent",
    "growthPercent",
    "reserveBytes",
    "rpoHours",
    "rtoMinutes",
  ]);
  if (
    typeof config.name !== "string" ||
    !config.name.trim() ||
    Buffer.byteLength(config.name) > 128 ||
    !["files", "sqlite", "postgresql"].includes(config.type)
  )
    throw new Error("Invalid plan name/type");
  const c = {
    ...config,
    repository: checked(config.repository),
    dropPercent: config.dropPercent ?? 30,
    growthPercent: config.growthPercent ?? 300,
    reserveBytes: config.reserveBytes ?? 268435456,
    rpoHours: config.rpoHours ?? 24,
    rtoMinutes: config.rtoMinutes ?? 0,
  };
  for (const [key, min, max] of [
    ["dropPercent", 1, 100],
    ["growthPercent", 101, 10000],
    ["reserveBytes", 0, 1099511627776],
    ["rpoHours", 1, 8760],
    ["rtoMinutes", 0, 1440],
  ])
    if (!Number.isSafeInteger(c[key]) || c[key] < min || c[key] > max)
      throw new Error("Plan budget out of bounds");
  if (c.type === "postgresql") {
    strict(c.postgres, [
      "database",
      "user",
      "host",
      "port",
      "dumpExecutable",
      "restoreExecutable",
      "allowRemote",
      "timeoutMs",
      "maxBytes",
    ]);
    if (c.source !== undefined)
      throw new Error("PostgreSQL source is configured separately");
    const p = c.postgres;
    if (
      typeof p.database !== "string" ||
      typeof p.user !== "string" ||
      (p.host !== undefined && typeof p.host !== "string")
    )
      throw new Error("Invalid PostgreSQL plan connection fields");
    if (
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(p.database || "") ||
      !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(p.user || "") ||
      !/^[A-Za-z0-9_.-]{1,253}$/.test(p.host ?? "127.0.0.1") ||
      typeof (p.allowRemote ?? false) !== "boolean" ||
      (!["127.0.0.1", "localhost"].includes(p.host ?? "127.0.0.1") &&
        p.allowRemote !== true) ||
      !Number.isSafeInteger(p.port ?? 5432) ||
      (p.port ?? 5432) < 1 ||
      (p.port ?? 5432) > 65535
    )
      throw new Error(
        "Invalid PostgreSQL plan connection; credential-bearing URLs are not accepted",
      );
    for (const [key, name] of [
      ["dumpExecutable", "pg_dump"],
      ["restoreExecutable", "pg_restore"],
    ])
      if (
        typeof p[key] !== "string" ||
        !path.isAbsolute(p[key]) ||
        /[\r\n\x00]/.test(p[key]) ||
        !new RegExp("^" + name + "(?:\\.exe)?$", "i").test(
          path.basename(p[key]),
        )
      )
        throw new Error("Explicit PostgreSQL client paths required");
  } else {
    if (c.postgres !== undefined)
      throw new Error("Unexpected PostgreSQL config");
    c.source = checked(c.source);
    if (c.type === "files" && !fs.statSync(c.source).isDirectory())
      throw new Error("Directory source required");
  }
  if (c.replica) {
    c.replica = checked(c.replica, false);
    if (normalize(c.replica) === normalize(c.repository))
      throw new Error("Replica must differ");
  }
  if (c.remote) {
    strict(c.remote, [
      "endpoint",
      "bucket",
      "region",
      "prefix",
      "accessKeyEnv",
      "secretKeyEnv",
      "sessionTokenEnv",
      "allowRemote",
    ]);
    validateS3Destination(c.remote); // Validate before persisting any endpoint or userinfo.
    if (
      c.remote.prefix !== undefined &&
      !/^[A-Za-z0-9_-]{1,64}$/.test(c.remote.prefix)
    )
      throw new Error("Invalid remote object prefix");
    for (const key of ["accessKeyEnv", "secretKeyEnv"])
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(c.remote[key] || ""))
        throw new Error("Remote credential environment names required");
    if (
      c.remote.sessionTokenEnv &&
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.remote.sessionTokenEnv)
    )
      throw new Error("Invalid session token environment name");
  }
  const id = randomUUID(),
    record = {
      format: 1,
      id,
      config: c,
      binding: bound(c.repository),
      evidence: {},
      updated: Date.now(),
    };
  setCleanupGuard(
    c.repository,
    {
      blocked: true,
      updated: Date.now(),
      reason: "no_plan_evidence",
    },
    id,
  );
  atomicPrivate(planFile(id), Buffer.from(JSON.stringify(record)));
  return { ok: true, id, config: c };
}
export function loadPlan(id) {
  const r = JSON.parse(readPrivate(planFile(id), 65536));
  if (r.format !== 1 || r.id !== id || r.binding !== bound(r.config.repository))
    throw new Error("Plan repository identity changed");
  return r;
}
export function planStatus(id, now = Date.now()) {
  const r = loadPlan(id),
    e = r.evidence,
    age = e.backup ? now - Date.parse(e.backup.finished) : null;
  const snapshot = e.backup?.snapshot;
  const pointAge = e.backup ? now - Date.parse(e.backup.recoveryPointAt) : NaN;
  const pointWithin =
    Number.isFinite(pointAge) &&
    pointAge >= 0 &&
    pointAge <= r.config.rpoHours * 3600000;
  const stages = {};
  for (const key of ["backup", "verified", "drill", "replica", "remote"]) {
    const point = e[key],
      required = !["replica", "remote"].includes(key) || !!r.config[key],
      finished = point && Date.parse(point.finished),
      pointAge = point ? now - finished : null;
    const state = !point
      ? "unknown"
      : !/^[a-f0-9]{64}$/.test(snapshot || "")
        ? "invalid"
        : point.snapshot !== snapshot
          ? "different_snapshot"
          : !Number.isFinite(finished) || !Number.isSafeInteger(now)
            ? "invalid"
            : pointAge < 0
              ? "future"
              : pointAge > r.config.rpoHours * 3600000
                ? "stale"
                : "current";
    stages[key] = {
      required,
      state,
      age_ms: Number.isFinite(pointAge) ? pointAge : null,
      finished: point?.finished ?? null,
      snapshot: point?.snapshot ?? null,
    };
  }
  const running = fs.existsSync(planFile(id) + ".lock");
  const rtoRequired = (r.config.rtoMinutes ?? 0) > 0;
  const observed = e.drill?.durationMs;
  const rtoWithin =
    !rtoRequired ||
    (Number.isSafeInteger(observed) &&
      observed >= 0 &&
      observed <= r.config.rtoMinutes * 60000);
  return {
    ok:
      !running &&
      !r.activeOperation &&
      !r.lastError &&
      rtoWithin &&
      pointWithin &&
      Object.values(stages).every((s) => !s.required || s.state === "current"),
    id,
    config: r.config,
    evidence: e,
    stages,
    running,
    backup_age_ms: age,
    recovery_point_age_ms: Number.isFinite(pointAge) ? pointAge : null,
    recovery_point_observed:
      typeof e.backup?.recoveryPointAt === "string" &&
      Number.isFinite(pointAge),
    observed_restore_ms: e.drill?.durationMs ?? null,
    rto_goal_met: rtoWithin,
    production_rto_guaranteed: false,
    lastError: r.lastError || null,
    activeOperation: r.activeOperation || null,
  };
}
export function listPlans(now = Date.now()) {
  const dir = mkdirPrivate(path.join(stateHome(), "plans-v1")),
    it = fs.opendirSync(dir),
    result = [];
  try {
    for (let d = it.readSync(); d; d = it.readSync()) {
      if (!d.name.endsWith(".json")) continue;
      if (result.length >= 1000) throw new Error("Plan count budget");
      const id = d.name.slice(0, -5);
      operationId(id);
      try {
        result.push(planStatus(id, now));
      } catch {
        // Inspection remains usable when one removable repository is offline.
        // Writes still require loadPlan's identity and unlock checks.
        let config = { name: "不可用计划", type: "unknown" };
        try {
          const raw = JSON.parse(readPrivate(planFile(id), 65536));
          if (
            raw.format === 1 &&
            raw.id === id &&
            typeof raw.config?.name === "string" &&
            typeof raw.config?.type === "string"
          )
            config = { name: raw.config.name, type: raw.config.type };
        } catch {}
        result.push({
          ok: false,
          id,
          config,
          evidence: {},
          stages: {},
          running: false,
          lastError: "plan_unavailable",
          unavailable: true,
        });
      }
    }
  } finally {
    it.closeSync();
  }
  return { ok: true, plans: result };
}
export async function runPlan(
  id,
  { acceptAnomaly = false, recover = false, restart = false } = {},
) {
  if (
    typeof acceptAnomaly !== "boolean" ||
    typeof recover !== "boolean" ||
    typeof restart !== "boolean"
  )
    throw new Error("Strict plan flags required");
  const r = loadPlan(id),
    file = planFile(id),
    lock = file + ".lock";
  if (fs.existsSync(lock)) {
    if (!recover)
      throw new Error(
        "Plan already active or stale plan lease; explicit --recover required",
      );
    const owner = JSON.parse(
      readPrivate(path.join(checked(lock), "owner.json"), 1024),
    );
    if (
      owner.host !== os.hostname() ||
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.plan !== id
    )
      throw new Error("Foreign plan lease");
    try {
      process.kill(owner.pid, 0);
      throw new Error("Plan owner still active");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  atomicPrivate(
    path.join(lock, "owner.json"),
    Buffer.from(
      JSON.stringify({ pid: process.pid, host: os.hostname(), plan: id }),
    ),
  );
  const c = r.config,
    began = Date.now(),
    persist = () => atomicPrivate(file, Buffer.from(JSON.stringify(r)));
  let result;
  try {
    setCleanupGuard(
      c.repository,
      {
        blocked: true,
        updated: Date.now(),
        reason: "plan_in_progress",
      },
      id,
    );
    if (
      !(
        await core([
          "clock-guard",
          String(r.updated),
          String(began),
          String(31 * 86400000),
        ])
      ).ok
    )
      throw new Error(
        "Plan clock rollback/large jump; investigate before resuming",
      );
    if (c.type === "files") {
      const space = await capacity(c.repository, c.source, {
        reserve: String(c.reserveBytes),
      });
      if (!space.ok) throw new Error("Insufficient plan capacity");
      const scan = await core(["plan", c.repository, c.source]),
        previous = r.evidence.backup;
      if (scan.entries === 0)
        throw new Error("Empty source plan refused; check mount and selection");
      const anomaly =
        previous &&
        (scan.entries * 100 < previous.entries * (100 - c.dropPercent) ||
          BigInt(scan.logical_bytes) * 100n >
            BigInt(previous.logicalBytes || "0") * BigInt(c.growthPercent));
      if (anomaly && !acceptAnomaly)
        throw new Error(
          "Source drop/growth anomaly; explicit --accept-anomaly required; old recovery points retained",
        );
      if (restart && r.activeOperation) {
        if (
          (repositoryKind(c.repository).paged
            ? await runEngine(
                "operation-status",
                { repository: c.repository, id: r.activeOperation },
                { allowFailure: true },
              )
            : operationStatus(c.repository, r.activeOperation)
          ).state === "running"
        )
          throw new Error("Cannot restart an active operation");
        r.activeOperation = null;
      }
      r.activeOperation ??= repositoryKind(c.repository).paged
        ? (
            await runEngine(
              "operation-create",
              { repository: c.repository, source: c.source, label: c.name },
              { allowFailure: true },
            )
          ).operation
        : await createOperation({
            repository: c.repository,
            source: c.source,
            arguments: ["--label", c.name],
          });
      persist();
      result = repositoryKind(c.repository).paged
        ? await runEngine("operation-run", {
            repository: c.repository,
            id: r.activeOperation,
            recover,
          })
        : await runOperation(c.repository, r.activeOperation, { recover });
      r.activeOperation = null;
      r.evidence.backup = {
        snapshot: result.snapshot,
        recoveryPointAt: result.started,
        finished: new Date().toISOString(),
        entries: scan.entries,
        logicalBytes: scan.logical_bytes,
      };
    } else {
      result =
        c.type === "sqlite"
          ? await sqliteBackup(c.repository, c.source, { label: c.name })
          : await postgresBackup(c.repository, c.postgres);
      r.evidence.backup = {
        snapshot: result.snapshot,
        recoveryPointAt: new Date(began).toISOString(),
        finished: new Date().toISOString(),
      };
    }
    persist();
    await core(["verify", c.repository, result.snapshot]);
    r.evidence.verified = {
      snapshot: result.snapshot,
      finished: new Date().toISOString(),
    };
    persist();
    const started = performance.now(),
      d = await drill(c.repository, result.snapshot);
    if (!d.ok || !d.post_restore_readback)
      throw new Error("Plan recovery drill failed");
    r.evidence.drill = {
      snapshot: result.snapshot,
      finished: new Date().toISOString(),
      durationMs: Math.ceil(performance.now() - started),
    };
    persist();
    if (
      (c.rtoMinutes ?? 0) > 0 &&
      r.evidence.drill.durationMs > c.rtoMinutes * 60000
    )
      throw new Error(
        "Measured drill exceeded the configured RTO goal; valid snapshot retained and cleanup protection stays blocked",
      );
    if (c.replica) {
      const copy = await replicate(c.repository, c.replica);
      if (!copy.ok) throw new Error("Replica audit failed");
      r.evidence.replica = {
        snapshot: result.snapshot,
        finished: new Date().toISOString(),
        independent_device_verified: false,
      };
      persist();
    }
    if (c.remote) {
      const p = c.remote,
        b = new S3Backend({
          endpoint: p.endpoint,
          bucket: p.bucket,
          region: p.region,
          allowRemote: p.allowRemote === true,
          accessKeyId: process.env[p.accessKeyEnv],
          secretAccessKey: process.env[p.secretKeyEnv],
          sessionToken: p.sessionTokenEnv
            ? process.env[p.sessionTokenEnv]
            : undefined,
        }),
        copied = await pushSnapshot(c.repository, result.snapshot, b, {
          prefix: p.prefix,
        });
      if (!copied.ok) throw new Error("Remote copy failed");
      r.evidence.remote = {
        snapshot: result.snapshot,
        finished: new Date().toISOString(),
        receipt: copied.receipt_key,
        checksum: copied.receipt_checksum,
        real_provider_verified: false,
      };
      persist();
    }
    r.lastError = null;
    const required = [
        "backup",
        "verified",
        "drill",
        ...(c.replica ? ["replica"] : []),
        ...(c.remote ? ["remote"] : []),
      ],
      completed = Date.now(),
      latest = Math.max(
        began,
        ...required.map((k) => Date.parse(r.evidence[k]?.finished)),
      );
    if (
      !Number.isFinite(latest) ||
      !(
        await core([
          "clock-guard",
          String(latest),
          String(completed),
          String(31 * 86400000),
        ])
      ).ok
    )
      throw new Error(
        "Clock changed during plan completion; snapshot retained and cleanup protection stays blocked",
      );
    const recoveryAge =
      Date.now() - Date.parse(r.evidence.backup.recoveryPointAt);
    if (
      !Number.isFinite(recoveryAge) ||
      recoveryAge < 0 ||
      recoveryAge > c.rpoHours * 3600000
    )
      throw new Error(
        "Conservative recovery point is unknown, future or outside RPO; snapshot retained and cleanup protection stays blocked",
      );
    r.updated = Date.now();
    r.durationMs = r.updated - began;
    persist();
    if (result.cleanup_blocked === true)
      throw new Error(
        "Fresh backup verified but damaged history remains; cleanup protection stays blocked",
      );
    setCleanupGuard(
      c.repository,
      {
        blocked: false,
        updated: r.updated,
        snapshot: result.snapshot,
      },
      id,
    );
  } catch (error) {
    r.lastError = "plan_failed";
    r.updated = Math.max(r.updated, Date.now());
    persist();
    throw error;
  } finally {
    fs.unlinkSync(path.join(checked(lock), "owner.json"));
    fs.rmdirSync(lock);
  }
  return planStatus(id);
}
export async function planCommand(args) {
  const [command, ...rest] = args;
  if (command === "key-migrate") {
    const { positionals: p } = options(rest, []);
    if (
      p.length !== 2 ||
      fs.existsSync(checked(p[1], false)) ||
      !process.env.MOONRESTORE_DEST_PASSWORD
    )
      throw new Error(
        "Usage: key-migrate SOURCE NEW_REPO; set a private destination password environment variable",
      );
    const result = await replicate(p[0], p[1], { encrypted: true });
    return {
      ...result,
      kind: "key_migration",
      new_repository_key: true,
      old_repository_preserved: true,
      old_offline_keys_revoked: false,
    };
  }
  if (!["plan-save", "plan-list", "plan-run", "plan-status"].includes(command))
    return null;
  const { positionals: p, values: v } = options(
    rest,
    ["accept-anomaly", "recover", "restart"],
    ["accept-anomaly", "recover", "restart"],
  );
  if (command === "plan-save" && p.length === 1 && !Object.keys(v).length)
    return savePlan(JSON.parse(readPrivate(p[0], 65536)));
  if (command === "plan-list" && !p.length && !Object.keys(v).length)
    return listPlans();
  if (command === "plan-status" && p.length === 1 && !Object.keys(v).length)
    return planStatus(p[0]);
  if (command === "plan-run" && p.length === 1)
    return runPlan(p[0], {
      acceptAnomaly: v["accept-anomaly"] === true,
      recover: v.recover === true,
      restart: v.restart === true,
    });
  throw new Error("Invalid plan command");
}
