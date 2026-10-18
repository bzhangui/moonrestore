// Explicit opt-in scheduler for existing plans. Never registers an OS service,
// accepts anomaly overrides, breaks repository locks or stores credentials.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checked, mkdirPrivate, readPrivate, stateHome } from "./vault.mjs";
import { atomicPrivate, operationId } from "./journal.mjs";
import { loadPlan, runPlan } from "./plans.mjs";
import { core, hash, options } from "./maintenance.mjs";
import { withBudget } from "./activity.mjs";
import { notify } from "./notifications.mjs";
import { taskPreview, installTask } from "./os-schedule.mjs";
const home = () => mkdirPrivate(path.join(stateHome(), "plan-schedules-v1"));
const file = (id) => path.join(home(), operationId(id) + ".json");
const lease = () => path.join(home(), ".runner.lock");
function integer(v, min, max) {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new Error("Schedule integer out of bounds");
  return v;
}
function read(id) {
  const r = JSON.parse(readPrivate(file(id), 16384));
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "format",
          "id",
          "enabled",
          "intervalMinutes",
          "retryMinutes",
          "attemptLimit",
          "maxRuntimeMinutes",
          "planHash",
          "attempts",
          "state",
          "clock",
          "due",
          "reason",
        ].includes(k),
    )
  )
    throw new Error("Unknown scheduler field; credentials are never permitted");
  if (
    r.format !== 1 ||
    r.id !== id ||
    typeof r.enabled !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(r.planHash || "") ||
    !["ready", "running", "retry", "blocked"].includes(r.state) ||
    (r.reason !== null &&
      !["run_failed", "clock_discontinuity", "interrupted"].includes(r.reason))
  )
    throw new Error("Invalid scheduler record");
  integer(r.intervalMinutes, 1, 10080);
  integer(r.retryMinutes, 1, 1440);
  integer(r.attemptLimit, 1, 10);
  integer(r.attempts, 0, 10);
  integer(r.maxRuntimeMinutes, 1, 1440);
  for (const k of ["clock", "due"]) integer(r[k], 0, Number.MAX_SAFE_INTEGER);
  return r;
}
const persist = (r) =>
  atomicPrivate(file(r.id), Buffer.from(JSON.stringify(r)));
function assertIdle() {
  if (fs.existsSync(lease()))
    throw new Error(
      "Scheduler active/interrupted; stop the owner and explicitly recover its lease",
    );
}
function acquireLease() {
  assertIdle();
  const lock = lease();
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    atomicPrivate(
      path.join(lock, "owner.json"),
      Buffer.from(JSON.stringify({ host: os.hostname(), pid: process.pid })),
    );
  } catch (e) {
    fs.rmdirSync(lock);
    throw e;
  }
  return () => {
    fs.unlinkSync(checked(path.join(lock, "owner.json")));
    fs.rmdirSync(lock);
  };
}
export function configureSchedule(
  id,
  config,
  confirmation,
  { now = Date.now() } = {},
) {
  operationId(id);
  if (confirmation !== id) throw new Error("Confirm the exact plan UUID");
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (k) =>
        ![
          "enabled",
          "intervalMinutes",
          "retryMinutes",
          "attemptLimit",
          "maxRuntimeMinutes",
        ].includes(k),
    ) ||
    typeof config.enabled !== "boolean"
  )
    throw new Error("Strict schedule fields required; no secrets");
  integer(now, 0, Number.MAX_SAFE_INTEGER - 31 * 86400000);
  const release = acquireLease();
  try {
    // Disabling must work even if the drive is offline or a session key expired.
    if (config.enabled === false && fs.existsSync(file(id))) {
      const r = read(id);
      r.enabled = false;
      persist(r);
      return { ok: true, schedule: r, os_registered: false };
    }
    const p = loadPlan(id),
      r = {
        format: 1,
        id,
        enabled: config.enabled,
        intervalMinutes: integer(config.intervalMinutes ?? 1440, 1, 10080),
        retryMinutes: integer(config.retryMinutes ?? 15, 1, 1440),
        attemptLimit: integer(config.attemptLimit ?? 3, 1, 10),
        maxRuntimeMinutes: integer(config.maxRuntimeMinutes ?? 30, 1, 1440),
        planHash: hash(
          JSON.stringify({ config: p.config, binding: p.binding }),
        ),
        attempts: 0,
        state: "ready",
        clock: now,
        due: now,
        reason: null,
      };
    persist(r);
    return { ok: true, schedule: r, os_registered: false };
  } finally {
    release();
  }
}
export function scheduleStatus(id, now = Date.now()) {
  const r = read(id);
  integer(now, 0, Number.MAX_SAFE_INTEGER);
  const discontinuous = now < r.clock || now - r.clock > 31 * 86400000;
  return {
    ...r,
    overdue:
      r.enabled &&
      r.state !== "blocked" &&
      r.state !== "running" &&
      r.attempts < r.attemptLimit &&
      !discontinuous &&
      now >= r.due,
    clock_discontinuity: discontinuous,
    lease_present: fs.existsSync(lease()),
    credentials_stored: false,
    execution_requires_running_runner: true,
  };
}
export function scheduledPlans(now = Date.now()) {
  const ids = fs.readdirSync(home()).filter((n) => n.endsWith(".json"));
  if (ids.length > 1000) throw new Error("Schedule count budget");
  return {
    ok: true,
    schedules: ids.sort().map((n) => scheduleStatus(n.slice(0, -5), now)),
  };
}
export async function runDuePlans({
  now = Date.now(),
  runner = runPlan,
  controlledSimulation = false,
  only,
} = {}) {
  if (only !== undefined) {
    operationId(only);
    read(only);
  }
  integer(now, 0, Number.MAX_SAFE_INTEGER - 31 * 86400000);
  if (runner !== runPlan && controlledSimulation !== true)
    throw new Error("Custom runner requires controlled simulation");
  const release = acquireLease(); // Exclusive across CLI and workbench processes.
  try {
    const results = [];
    for (const s of scheduledPlans(now).schedules) {
      if (only !== undefined && s.id !== only) continue;
      if (results.length >= 1) break; // One due plan per tick; bounded foreground work.
      if (!s.enabled || s.state === "blocked") continue;
      const r = read(s.id);
      if (s.clock_discontinuity || r.state === "running") {
        r.state = "blocked";
        r.reason = s.clock_discontinuity
          ? "clock_discontinuity"
          : "interrupted";
        persist(r);
        results.push({ id: r.id, ok: false, code: r.reason });
        continue;
      }
      if (!s.overdue) continue; // Do not spawn a core process for each future schedule.
      const decision = await core([
        "schedule-due",
        String(r.enabled),
        String(r.state === "blocked"),
        String(r.attempts),
        String(r.attemptLimit),
        String(r.clock),
        String(now),
        String(r.due),
        String(31 * 86400000),
      ]);
      if (!decision.due) continue;
      r.state = "running";
      r.clock = now;
      persist(r);
      try {
        const p = loadPlan(r.id);
        if (
          hash(JSON.stringify({ config: p.config, binding: p.binding })) !==
          r.planHash
        )
          throw new Error("Plan changed; explicitly reconfigure the schedule");
        const result = await withBudget(r.maxRuntimeMinutes, () =>
          runner(r.id),
        );
        if (result.ok !== true) throw new Error("Plan incomplete");
        r.attempts = 0;
        r.state = "ready";
        r.reason = null;
        r.due = now + r.intervalMinutes * 60000;
        results.push({ id: r.id, ok: true });
      } catch (error) {
        r.attempts++;
        const requiresAction =
          /anomaly|clock|identity|reconfigure|unlock|password|key unavailable|active operation|Foreign.*lease/i.test(
            String(error.message),
          );
        r.state =
          requiresAction || r.attempts >= r.attemptLimit ? "blocked" : "retry";
        r.reason = "run_failed";
        r.due = now + r.retryMinutes * 60000;
        results.push({
          id: r.id,
          ok: false,
          code: "run_failed",
          retry: r.state === "retry",
        });
      }
      persist(r);
      try {
        notify(r.id, r.reason || "success");
      } catch {
        /* A local notice is not backup evidence. */
      }
    }
    const blocked = scheduledPlans(now)
      .schedules.filter(
        (s) =>
          s.enabled &&
          s.state === "blocked" &&
          (only === undefined || s.id === only),
      )
      .map((s) => ({ id: s.id, code: s.reason }));
    return {
      ok: results.every((r) => r.ok) && blocked.length === 0,
      results,
      blocked_plans: blocked,
      no_due_plans: results.length === 0,
      controlled_simulation: runner !== runPlan,
    };
  } finally {
    release();
  }
}
export function recoverScheduleLease(confirmation) {
  if (confirmation !== "recover-stopped-plan-scheduler")
    throw new Error("Explicit stopped-runner confirmation required");
  const lock = checked(lease()),
    owner = path.join(lock, "owner.json"),
    r = JSON.parse(readPrivate(owner, 1024));
  if (r.host !== os.hostname() || !Number.isSafeInteger(r.pid) || r.pid <= 0)
    throw new Error("Foreign scheduler lease");
  try {
    process.kill(r.pid, 0);
    throw new Error("Scheduler owner still active");
  } catch (e) {
    if (e.code !== "ESRCH") throw e;
  }
  fs.unlinkSync(owner);
  fs.rmdirSync(lock);
  // A running plan or child operation is NOT recovered/restarted here.
  return { ok: true, lease_recovered: true, operation_recovered: false };
}
export async function schedulerCommand(args) {
  const [c, ...a] = args;
  if (
    ![
      "plan-schedule",
      "plan-schedules",
      "plan-run-due",
      "plan-scheduler-recover",
      "plan-schedule-preview",
      "plan-schedule-install",
    ].includes(c)
  )
    return null;
  const { positionals: p, values: v } = options(a, ["confirm", "plan"]);
  if (c === "plan-schedule" && p.length === 2 && Object.keys(v).length === 1)
    return configureSchedule(
      p[0],
      JSON.parse(readPrivate(p[1], 16384)),
      v.confirm,
    );
  if (c === "plan-schedules" && !p.length && !Object.keys(v).length)
    return scheduledPlans();
  if (c === "plan-run-due" && !p.length && !Object.keys(v).length)
    return runDuePlans();
  if (
    c === "plan-run-due" &&
    !p.length &&
    Object.keys(v).length === 1 &&
    v.plan
  )
    return runDuePlans({ only: v.plan });
  if (
    ["plan-schedule-preview", "plan-schedule-install"].includes(c) &&
    p.length === 1 &&
    Object.keys(v).every((k) => k === "confirm")
  ) {
    const r = read(p[0]);
    if (!r.enabled)
      throw new Error("Enable the plan schedule explicitly first");
    const preview = taskPreview(
      p[0],
      Math.min(r.intervalMinutes, r.retryMinutes),
      "plan",
    );
    if (c === "plan-schedule-preview" && !Object.keys(v).length) return preview;
    if (c === "plan-schedule-install" && Object.keys(v).length === 1)
      return installTask(preview, v.confirm);
  }
  if (
    c === "plan-scheduler-recover" &&
    !p.length &&
    Object.keys(v).length === 1
  )
    return recoverScheduleLease(v.confirm);
  throw new Error("Invalid plan scheduler command");
}
