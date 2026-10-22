import { randomUUID } from "node:crypto";
import { listPlans } from "./plans.mjs";
import { scheduledPlans } from "./plan-scheduler.mjs";
import { core, options } from "./maintenance.mjs";
import { notify } from "./notifications.mjs";
const millis = (v) => (Number.isSafeInteger(v) && v >= 0 ? String(v) : "-1");

export async function recoveryReadiness({
  now = Date.now(),
  recordNotices = false,
} = {}) {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    typeof recordNotices !== "boolean"
  )
    throw new Error("Invalid readiness observation");
  const inventory = listPlans(now),
    issues = [];
  let schedules = [];
  try {
    schedules = scheduledPlans(now).schedules;
  } catch {
    issues.push("schedule_inventory_invalid");
  }
  const rows = inventory.plans.map((p) => {
    const s = schedules.find((s) => s.id === p.id),
      point = Date.parse(p.evidence?.backup?.recoveryPointAt),
      age = now - point;
    return {
      plan: p,
      schedule: s,
      input: {
        age_ms: millis(age),
        rpo_ms: String((p.config.rpoHours ?? 24) * 3600000),
        observed_ms: millis(p.observed_restore_ms),
        rto_ms: String((p.config.rtoMinutes ?? 0) * 60000),
        evidence_current: p.ok === true && !p.unavailable,
        enabled: s?.enabled === true,
        blocked: s?.state === "blocked",
        running: s?.state === "running",
        previous: String(s?.clock ?? now),
        now: String(now),
        due: String(s?.due ?? now),
        grace_ms: String(
          Math.min(86400000, (s?.maxRuntimeMinutes ?? 30) * 60000),
        ),
      },
    };
  });
  const plans = [];
  for (let start = 0; start < rows.length; start += 32) {
    const batch = rows.slice(start, start + 32),
      evaluated = await core([
        "recovery-goals",
        JSON.stringify(batch.map((r) => r.input)),
      ]);
    for (let i = 0; i < batch.length; i++) {
      const { plan: p, schedule: s } = batch[i],
        decision = evaluated.results[i],
        scheduleState = s ? decision.schedule : "not_configured";
      const reasons = [];
      if (!decision.goal.evidence_current)
        reasons.push(
          p.unavailable ? "plan_unavailable" : "evidence_incomplete",
        );
      if (decision.goal.rpo_state !== "within")
        reasons.push("rpo_" + decision.goal.rpo_state);
      if (["unknown", "exceeded"].includes(decision.goal.rto_state))
        reasons.push("rto_" + decision.goal.rto_state);
      if (
        [
          "missing",
          "running_overdue",
          "blocked",
          "clock_discontinuity",
        ].includes(scheduleState)
      )
        reasons.push("schedule_" + scheduleState);
      const row = {
        id: p.id,
        name: p.config.name,
        ready: reasons.length === 0 && issues.length === 0,
        goal: decision.goal,
        schedule: scheduleState,
        reasons,
        stages: p.stages,
        observed_restore_ms: p.observed_restore_ms ?? null,
        real_independent_copy_verified:
          p.evidence?.replica?.independent_device_verified === true ||
          p.evidence?.remote?.real_provider_verified === true,
      };
      plans.push(row);
      if (recordNotices && reasons.length)
        notify(
          p.id,
          reasons.some((r) => r === "schedule_missing")
            ? "schedule_missing"
            : "readiness_incomplete",
        );
    }
  }
  return {
    ok: plans.length > 0 && issues.length === 0 && plans.every((p) => p.ready),
    format: 1,
    kind: "recovery_readiness",
    observed_at: new Date(now).toISOString(),
    plans,
    issues,
    local_observer_only: true,
    production_rto_guaranteed: false,
  };
}
export function publicReadiness(report) {
  if (report?.kind !== "recovery_readiness" || !Array.isArray(report.plans))
    throw new Error("Readiness report required");
  const count = (predicate) => report.plans.filter(predicate).length;
  return {
    format: 1,
    kind: "moonrestore_readiness_heartbeat",
    report_id: randomUUID(),
    observed_at: report.observed_at,
    ready: report.ok === true,
    total_plans: report.plans.length,
    ready_plans: count((p) => p.ready),
    missing_plans: count((p) => p.schedule === "missing"),
    incomplete_plans: count((p) => !p.goal.evidence_current),
    rpo_exceeded: count((p) => p.goal.rpo_state === "exceeded"),
    rto_exceeded: count((p) => p.goal.rto_state === "exceeded"),
    independent_copies_verified: count((p) => p.real_independent_copy_verified),
    inventory_valid: report.issues.length === 0,
    production_rto_guaranteed: false,
  };
}
export async function sendReadiness(
  endpoint,
  report,
  { allowRemote = false, timeoutMs = 5000 } = {},
) {
  const url = new URL(endpoint),
    loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    typeof allowRemote !== "boolean" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!loopback && (!allowRemote || url.protocol !== "https:")) ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "https:" &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  )
    throw new Error("Explicit trusted HTTPS monitor endpoint required");
  const token = process.env.MOONRESTORE_MONITOR_TOKEN;
  if (
    token !== undefined &&
    (typeof token !== "string" ||
      !token.length ||
      Buffer.byteLength(token) > 2048 ||
      /[\x00-\x20\x7f]/.test(token))
  )
    throw new Error("Invalid monitor token");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(publicReadiness(report)),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("Monitor endpoint rejected heartbeat");
  return {
    ok: true,
    accepted_by_endpoint: true,
    recipient_delivery_confirmed: false,
  };
}
export async function readinessCommand(args) {
  const [c, ...rest] = args;
  if (!["readiness", "watchdog-check", "readiness-send"].includes(c))
    return null;
  const { positionals: p, values: v } = options(
    rest,
    ["notify", "allow-remote"],
    ["notify", "allow-remote"],
  );
  if (c === "readiness" && !p.length && !Object.keys(v).length)
    return recoveryReadiness();
  if (c === "watchdog-check" && !p.length && !("allow-remote" in v))
    return recoveryReadiness({ recordNotices: v.notify === true });
  if (c === "readiness-send" && p.length === 1 && !("notify" in v))
    return sendReadiness(p[0], await recoveryReadiness(), {
      allowRemote: v["allow-remote"] === true,
    });
  throw new Error("Invalid readiness command");
}
