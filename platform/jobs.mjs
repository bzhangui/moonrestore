import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
} from "./vault.mjs";
import {
  core,
  capacity,
  health,
  drill,
  repositoryIdentity,
  options,
  cli,
  hash,
} from "./maintenance.mjs";
import { withBudget, checkpoint } from "./activity.mjs";
import { replicate } from "./maintenance.mjs";
import { notify } from "./notifications.mjs";

const jobId = (value) => {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value)
  )
    throw new Error("Job ID must be 1..48 ASCII letters/digits/_/-");
  return value;
};
const count = (v, min, max) => {
  if (
    !/^[0-9]+$/.test(String(v)) ||
    !Number.isSafeInteger(Number(v)) ||
    Number(v) < min ||
    Number(v) > max
  )
    throw new Error("Invalid job budget");
  return Number(v);
};
function configPath() {
  return path.join(stateHome(), "jobs.json");
}
function readConfig() {
  if (!fs.existsSync(configPath())) return { format: 1, jobs: [] };
  const c = JSON.parse(readPrivate(configPath(), 1048576));
  if (
    c.format !== 1 ||
    !Array.isArray(c.jobs) ||
    c.jobs.length > 100 ||
    Object.keys(c).some((k) => !["format", "jobs"].includes(k))
  )
    throw new Error("Invalid jobs configuration");
  const ids = new Set(),
    repositories = new Set();
  for (const j of c.jobs) {
    jobId(j.id);
    count(j.intervalMinutes, 1, 10080);
    count(j.drillEvery, 1, 365);
    count(j.maxDropPercent, 1, 100);
    if (
      typeof j.repository !== "string" ||
      !path.isAbsolute(j.repository) ||
      typeof j.source !== "string" ||
      !path.isAbsolute(j.source) ||
      typeof j.allowEmpty !== "boolean" ||
      !/^(0|[1-9][0-9]{0,18})$/.test(j.reserveBytes) ||
      !Array.isArray(j.excludes) ||
      j.excludes.length > 128 ||
      j.excludes.some((x) => typeof x !== "string" || x.length > 1024) ||
      typeof j.repositoryIdentity !== "string" ||
      !/^[a-f0-9-]{36}$/.test(j.repositoryIdentity) ||
      ids.has(j.id) ||
      repositories.has(j.repositoryIdentity)
    )
      throw new Error("Invalid job record");
    if (
      j.lastRun &&
      (!Number.isFinite(Date.parse(j.lastRun.started)) ||
        typeof j.lastRun.ok !== "boolean")
    )
      throw new Error("Invalid job history");
    if (j.previousEntries !== undefined) count(j.previousEntries, 0, 100000);
    if (j.successfulRuns !== undefined)
      count(j.successfulRuns, 0, Number.MAX_SAFE_INTEGER);
    for (const key of ["paused", "notify", "automatic"])
      if (j[key] !== undefined && typeof j[key] !== "boolean")
        throw new Error("Invalid job switch");
    count(j.retryLimit ?? 2, 0, 3);
    count(j.retryMinutes ?? 15, 1, 1440);
    count(j.maxRuntimeMinutes ?? 30, 1, 1440);
    count(j.retries ?? 0, 0, 3);
    if (
      j.secondaryRepository !== undefined &&
      (typeof j.secondaryRepository !== "string" ||
        !path.isAbsolute(j.secondaryRepository) ||
        typeof j.secondaryIdentity !== "string" ||
        !/^[a-f0-9-]{36}$/.test(j.secondaryIdentity))
    )
      throw new Error("Invalid secondary repository");
    if (
      j.nextAttempt !== undefined &&
      !Number.isFinite(Date.parse(j.nextAttempt))
    )
      throw new Error("Invalid retry time");
    if (
      Object.keys(j).some(
        (k) =>
          ![
            "id",
            "repository",
            "source",
            "intervalMinutes",
            "drillEvery",
            "reserveBytes",
            "maxDropPercent",
            "allowEmpty",
            "excludes",
            "repositoryIdentity",
            "lastRun",
            "lastSuccess",
            "successfulRuns",
            "previousEntries",
            "paused",
            "notify",
            "automatic",
            "retryLimit",
            "retryMinutes",
            "retries",
            "nextAttempt",
            "maxRuntimeMinutes",
            "secondaryRepository",
            "secondaryIdentity",
            "lastBackup",
            "lastVerified",
            "lastDrill",
            "lastReplica",
          ].includes(k),
      )
    )
      throw new Error("Unknown job field");
    ids.add(j.id);
    repositories.add(j.repositoryIdentity);
  }
  return c;
}
function atomicConfig(c) {
  mkdirPrivate(stateHome());
  const text = JSON.stringify(c, null, 2);
  if (Buffer.byteLength(text) > 1048576)
    throw new Error("Job configuration byte budget exceeded");
  const target = configPath();
  if (fs.existsSync(target)) {
    const original = readPrivate(target);
    const previous = JSON.parse(original);
    const backup = path.join(stateHome(), "jobs-v02-before-upgrade.json");
    if (
      previous.jobs.every(
        (j) =>
          !("paused" in j) &&
          !("automatic" in j) &&
          !("maxRuntimeMinutes" in j),
      ) &&
      !fs.existsSync(backup)
    )
      writePrivate(backup, original);
  }
  const temp = path.join(stateHome(), `jobs-${randomUUID()}.tmp`);
  writePrivate(temp, text);
  fs.renameSync(temp, target);
}
function acquire() {
  mkdirPrivate(stateHome());
  const file = path.join(stateHome(), ".jobs.lock");
  fs.mkdirSync(file, { mode: 0o700 });
  try {
    writePrivate(
      path.join(file, "owner.json"),
      JSON.stringify({ pid: process.pid, host: os.hostname() }),
    );
  } catch (e) {
    fs.rmdirSync(file);
    throw e;
  }
  return () => {
    fs.unlinkSync(checked(path.join(file, "owner.json")));
    fs.rmdirSync(checked(file));
  };
}
export async function saveJob(input, { replace = false, confirmation } = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        ![
          "id",
          "repository",
          "source",
          "intervalMinutes",
          "drillEvery",
          "reserveBytes",
          "maxDropPercent",
          "allowEmpty",
          "excludes",
          "notify",
          "automatic",
          "retryLimit",
          "retryMinutes",
          "maxRuntimeMinutes",
          "secondaryRepository",
        ].includes(k),
    )
  )
    throw new Error("Invalid job fields");
  const job = {
    id: jobId(input.id),
    repository: checked(input.repository),
    source: checked(input.source),
    intervalMinutes: count(input.intervalMinutes ?? 1440, 1, 10080),
    drillEvery: count(input.drillEvery ?? 7, 1, 365),
    reserveBytes: String(input.reserveBytes ?? 268435456),
    maxDropPercent: count(input.maxDropPercent ?? 30, 1, 100),
    allowEmpty: input.allowEmpty ?? false,
    excludes: input.excludes ?? [],
  };
  if (
    typeof job.allowEmpty !== "boolean" ||
    !Array.isArray(job.excludes) ||
    job.excludes.length > 128 ||
    job.excludes.some((x) => typeof x !== "string" || x.startsWith("--"))
  )
    throw new Error("Invalid job options");
  if (!/^(0|[1-9][0-9]{0,18})$/.test(job.reserveBytes))
    throw new Error("Invalid reserve");
  Object.assign(job, {
    paused: false,
    notify: input.notify ?? false,
    automatic: input.automatic ?? false,
    retryLimit: count(input.retryLimit ?? 2, 0, 3),
    retryMinutes: count(input.retryMinutes ?? 15, 1, 1440),
    maxRuntimeMinutes: count(input.maxRuntimeMinutes ?? 30, 1, 1440),
  });
  if (typeof job.notify !== "boolean" || typeof job.automatic !== "boolean")
    throw new Error("Invalid notifications option");
  const plan = await core([
    "plan",
    job.repository,
    job.source,
    ...job.excludes.flatMap((x) => ["--exclude", x]),
  ]);
  if (plan.entries === 0 && !job.allowEmpty)
    throw new Error("Empty source requires explicit permission");
  job.repositoryIdentity = repositoryIdentity(job.repository);
  if (input.secondaryRepository) {
    job.secondaryRepository = checked(input.secondaryRepository);
    for (const base of [job.repository, job.source]) {
      const a = process.platform === "win32" ? base.toLowerCase() : base,
        b =
          process.platform === "win32"
            ? job.secondaryRepository.toLowerCase()
            : job.secondaryRepository;
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
        throw new Error("Secondary/source/repository overlap");
    }
    job.secondaryIdentity = repositoryIdentity(job.secondaryRepository);
    if (job.secondaryIdentity === job.repositoryIdentity)
      throw new Error("Secondary must be a different repository");
    await core(["list", job.secondaryRepository]);
  }
  const unlock = acquire();
  try {
    const c = readConfig(),
      index = c.jobs.findIndex((j) => j.id === job.id);
    if (index >= 0 && !replace)
      throw new Error("Job already exists; not overwritten");
    if (
      replace &&
      (index < 0 || hash(JSON.stringify(c.jobs[index])) !== confirmation)
    )
      throw new Error("Job changed; refresh before editing");
    if (
      c.jobs.some(
        (j) =>
          j.id !== job.id && j.repositoryIdentity === job.repositoryIdentity,
      )
    )
      throw new Error(
        "One dataset/job per repository is required for unambiguous retention",
      );
    if (index < 0 && c.jobs.length >= 100)
      throw new Error("Job budget exceeded");
    if (index >= 0) {
      const previous = c.jobs[index];
      if (
        previous.repositoryIdentity === job.repositoryIdentity &&
        previous.source === job.source &&
        JSON.stringify(previous.excludes) === JSON.stringify(job.excludes)
      ) {
        for (const key of [
          "lastRun",
          "lastSuccess",
          "successfulRuns",
          "previousEntries",
          "lastBackup",
          "lastVerified",
          "lastDrill",
        ])
          if (previous[key] !== undefined) job[key] = previous[key];
      }
      job.paused = previous.paused ?? false;
      if (previous.secondaryIdentity !== job.secondaryIdentity)
        delete job.lastSuccess;
      else if (previous.lastReplica !== undefined)
        job.lastReplica = previous.lastReplica;
      c.jobs[index] = job;
    } else c.jobs.push(job);
    atomicConfig(c);
  } finally {
    unlock();
  }
  return { ok: true, job: job.id, registered_with_os: false };
}
export function listJobs() {
  return readConfig().jobs.map((j) => ({
    ...j,
    revision: hash(JSON.stringify(j)),
    overdue:
      !j.paused &&
      (j.nextAttempt
        ? Date.parse(j.nextAttempt) <= Date.now()
        : !j.lastRun ||
          Date.parse(j.lastRun.started) > Date.now() ||
          Date.now() - Date.parse(j.lastRun.started) >
            j.intervalMinutes * 60000),
  }));
}
export function changeJob(id, action, confirmation) {
  const unlock = acquire();
  try {
    const c = readConfig(),
      index = c.jobs.findIndex((j) => j.id === jobId(id));
    if (index < 0 || hash(JSON.stringify(c.jobs[index])) !== confirmation)
      throw new Error("Job changed; refresh before modifying");
    if (action === "delete") c.jobs.splice(index, 1);
    else if (["pause", "resume"].includes(action)) {
      c.jobs[index].paused = action === "pause";
      delete c.jobs[index].nextAttempt;
      c.jobs[index].retries = 0;
    } else throw new Error("Unknown job action");
    atomicConfig(c);
    return {
      ok: true,
      action,
      job: id,
      backup_data_deleted: false,
      os_schedule_changed: false,
    };
  } finally {
    unlock();
  }
}
export async function runJob(id, { now = Date.now() } = {}) {
  const unlock = acquire();
  try {
    const config = readConfig(),
      job = config.jobs.find((j) => j.id === jobId(id));
    if (!job) throw new Error("Job not found");
    if (job.paused) throw new Error("Job is paused");
    return await withBudget(job.maxRuntimeMinutes ?? 30, async () => {
      const result = {
        job: job.id,
        started: new Date(now).toISOString(),
        ok: false,
      };
      try {
        if (!fs.existsSync(job.repository)) {
          result.failure_code = "device_unavailable";
          throw new Error("Backup device is offline");
        }
        if (repositoryIdentity(job.repository) !== job.repositoryIdentity) {
          result.failure_code = "wrong_device";
          throw new Error("Wrong backup device");
        }
        const plan = await core([
          "plan",
          job.repository,
          job.source,
          ...job.excludes.flatMap((x) => ["--exclude", x]),
        ]);
        const sourceAssessment = await core([
          "source-state",
          String(plan.entries),
          String(job.previousEntries ?? 0),
          String(job.allowEmpty),
          String(job.maxDropPercent),
        ]);
        if (sourceAssessment.state === 1)
          throw new Error("Unexpected empty source");
        if (sourceAssessment.state === 2)
          throw new Error("Source entries dropped beyond threshold");
        const space = await capacity(job.repository, job.source, {
          reserve: job.reserveBytes,
          excludes: job.excludes,
        });
        if (!space.ok) throw new Error("Capacity preflight rejected");
        const backed = await core([
          "backup",
          job.repository,
          job.source,
          "--label",
          `job:${job.id}`,
          ...job.excludes.flatMap((x) => ["--exclude", x]),
        ]);
        job.lastBackup = new Date().toISOString();
        const verified = await health(job.repository, backed.snapshot);
        if (!verified.ok) throw new Error("Post-backup verification failed");
        job.lastVerified = new Date().toISOString();
        const runs = (job.successfulRuns ?? 0) + 1;
        if (runs === 1 || runs % job.drillEvery === 0) {
          const restored = await drill(job.repository, backed.snapshot);
          if (!restored.ok) throw new Error("Restore drill failed");
          result.drill = restored.files;
          job.lastDrill = new Date().toISOString();
        }
        if (job.secondaryRepository) {
          checkpoint("secondary_copy");
          if (!fs.existsSync(job.secondaryRepository)) {
            result.failure_code = "device_unavailable";
            result.failed_stage = "secondary";
            throw new Error("Secondary device is offline");
          }
          if (
            repositoryIdentity(job.secondaryRepository) !==
            job.secondaryIdentity
          )
            throw new Error("Secondary device identity changed");
          result.replica = await replicate(
            job.repository,
            job.secondaryRepository,
          );
          if (!result.replica.ok)
            throw new Error("Secondary verification failed");
          job.lastReplica = new Date().toISOString();
        }
        result.ok = true;
        result.snapshot = backed.snapshot;
        result.report = verified.files;
        job.lastSuccess = new Date().toISOString();
        job.successfulRuns = runs;
        job.previousEntries = plan.entries;
      } catch (e) {
        result.error = e.message;
      }
      if (result.ok) {
        job.retries = 0;
        delete job.nextAttempt;
      } else if (
        result.failure_code === "device_unavailable" &&
        (job.retries ?? 0) < (job.retryLimit ?? 2)
      ) {
        job.retries = (job.retries ?? 0) + 1;
        job.nextAttempt = new Date(
          Date.now() + (job.retryMinutes ?? 15) * 60000,
        ).toISOString();
        result.retry_at = job.nextAttempt;
      } else delete job.nextAttempt;
      result.finished = new Date().toISOString();
      job.lastRun = result;
      atomicConfig(config);
      try {
        notify(
          job.id,
          result.ok ? "success" : result.failure_code || "failed",
          { desktop: job.notify ?? false },
        );
      } catch {
        result.notification_record_failed = true;
      }
      return result;
    });
  } finally {
    unlock();
  }
}
export async function runDue() {
  const due = listJobs().filter((j) => j.overdue),
    results = [];
  for (const j of due) results.push(await runJob(j.id));
  return {
    ok: results.every((r) => r.ok),
    results,
    no_due_jobs: due.length === 0,
  };
}
export function recoverJobs(confirm) {
  if (confirm !== "recover-stopped-local-job")
    throw new Error("Explicit stopped-job confirmation required");
  const dir = checked(path.join(stateHome(), ".jobs.lock")),
    owner = JSON.parse(readPrivate(path.join(dir, "owner.json"), 1024));
  if (
    owner.host !== os.hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  )
    throw new Error("Foreign or invalid job lock");
  try {
    process.kill(owner.pid, 0);
    throw new Error("Job process is still running");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  fs.unlinkSync(path.join(dir, "owner.json"));
  fs.rmdirSync(dir);
  return { ok: true, recovered: true };
}
const xml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
export function schedulePreview(id) {
  const job = listJobs().find((j) => j.id === jobId(id));
  if (!job) throw new Error("Job not found");
  const task = "MoonRestore-" + hash(stateHome() + ":" + id).slice(0, 20),
    start = new Date(Date.now() + 60000).toISOString();
  const argumentsText =
    '"' + cli + '" --home "' + stateHome() + '" job-run ' + id;
  const content = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>MoonRestore controlled current-user backup job</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT${job.intervalMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="User"><UserId>{{SID}}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT12H</ExecutionTimeLimit></Settings><Actions Context="User"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(path.dirname(path.dirname(cli)))}</WorkingDirectory></Exec></Actions></Task>`;
  return {
    ok: true,
    preview: true,
    task,
    xml: content,
    current_user_session_required: true,
    home: stateHome(),
  };
}
export function scheduleInstall(id, confirmation) {
  if (process.platform !== "win32")
    throw new Error(
      "Automatic OS registration currently supports Windows only",
    );
  const p = schedulePreview(id);
  if (confirmation !== p.task)
    throw new Error("Confirm the exact preview task name");
  // Fixed script; arguments and XML are data, never interpolated PowerShell code.
  const script =
    "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; if(Get-ScheduledTask -TaskName $v.task -ErrorAction SilentlyContinue){throw 'Task already exists; not overwritten'}; $xml=$v.xml.Replace('{{SID}}',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value); Register-ScheduledTask -TaskName $v.task -Xml $xml|Out-Null";
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      input: JSON.stringify(p),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      shell: false,
    },
  );
  if (r.status !== 0)
    throw new Error("OS schedule registration failed or task already exists");
  return {
    ok: true,
    task: p.task,
    registered: true,
    current_user_session_required: true,
  };
}
export async function jobCommand(args) {
  const c = args[0];
  if (
    ![
      "job-add",
      "jobs",
      "job-run",
      "run-due",
      "jobs-recover",
      "schedule-preview",
      "schedule-install",
    ].includes(c)
  )
    return null;
  const { positionals: p, values: v } = options(
    args.slice(1),
    [
      "repo",
      "source",
      "every-minutes",
      "drill-every",
      "reserve-bytes",
      "max-drop-percent",
      "allow-empty",
      "exclude",
      "confirm",
    ],
    ["allow-empty"],
  );
  if (c === "jobs" || c === "run-due") {
    if (p.length || Object.keys(v).length)
      throw new Error("No arguments allowed");
    return c === "jobs" ? { ok: true, jobs: listJobs() } : runDue();
  }
  if (p.length !== 1) throw new Error("Exactly one job ID required");
  if (c === "job-add") {
    if (Object.keys(v).some((k) => k === "confirm"))
      throw new Error("Invalid job option");
    return saveJob({
      id: p[0],
      repository: v.repo,
      source: v.source,
      intervalMinutes: v["every-minutes"],
      drillEvery: v["drill-every"],
      reserveBytes: v["reserve-bytes"],
      maxDropPercent: v["max-drop-percent"],
      allowEmpty: v["allow-empty"],
      excludes: v.exclude,
    });
  }
  if (c === "jobs-recover") {
    if (Object.keys(v).length) throw new Error("Unexpected options");
    return recoverJobs(p[0]);
  }
  if (c === "job-run" || c === "schedule-preview") {
    if (Object.keys(v).length) throw new Error("Unexpected options");
    return c === "job-run" ? runJob(p[0]) : schedulePreview(p[0]);
  }
  if (Object.keys(v).some((k) => k !== "confirm"))
    throw new Error("Unexpected options");
  return scheduleInstall(p[0], v.confirm);
}
