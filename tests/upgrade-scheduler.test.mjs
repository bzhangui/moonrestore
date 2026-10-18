import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put } from "./helpers.mjs";
import { savePlan, runPlan, planStatus } from "../platform/plans.mjs";
import {
  configureSchedule,
  scheduleStatus,
  runDuePlans,
  recoverScheduleLease,
} from "../platform/plan-scheduler.mjs";
import { supportSummary } from "../platform/support.mjs";
import { negotiateProvider } from "../platform/contracts.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
import { taskPreview, installTask } from "../platform/os-schedule.mjs";
function state(f) {
  const old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private-state");
  return () => {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  };
}
test("plan health rejects old-snapshot, missing replica, future and in-progress evidence", async () => {
  const f = fixture(),
    done = state(f);
  try {
    put(f.source, "private-name", "content");
    const p = savePlan({
      name: "plan",
      type: "files",
      repository: f.repo,
      source: f.source,
      reserveBytes: 0,
      replica: path.join(f.base, "replica"),
    });
    assert.equal((await runPlan(p.id)).ok, true);
    const file = path.join(
        process.env.MOONRESTORE_HOME,
        "plans-v1",
        p.id + ".json",
      ),
      original = JSON.parse(fs.readFileSync(file));
    for (const [stage, point, expected] of [
      [
        "verified",
        { snapshot: "0".repeat(64), finished: new Date().toISOString() },
        "different_snapshot",
      ],
      ["replica", undefined, "unknown"],
      [
        "drill",
        {
          ...original.evidence.drill,
          finished: new Date(Date.now() + 600000).toISOString(),
        },
        "future",
      ],
      ["remote", undefined, "unknown"],
    ]) {
      const r = structuredClone(original);
      if (stage === "remote") r.config.remote = { endpoint: "synthetic" }; // Does not connect.
      r.evidence[stage] = point;
      fs.writeFileSync(file, JSON.stringify(r));
      const s = planStatus(p.id);
      assert.equal(s.ok, false);
      assert.equal(s.stages[stage].state, expected);
    }
    fs.writeFileSync(file, JSON.stringify(original));
    fs.mkdirSync(file + ".lock");
    assert.equal(planStatus(p.id).ok, false);
    fs.rmdirSync(file + ".lock");
    assert.equal(
      planStatus(p.id, Date.now() + 25 * 3600000).stages.backup.state,
      "stale",
    );
  } finally {
    done();
  }
});
test("scheduler runs actual plans once per due tick and refuses duplicate/live lease recovery", async () => {
  const f = fixture(),
    done = state(f);
  try {
    put(f.source, "a", "controlled");
    const p = savePlan({
        name: "scheduled",
        type: "files",
        repository: f.repo,
        source: f.source,
        reserveBytes: 0,
      }),
      now = Date.now();
    assert.throws(() =>
      configureSchedule(p.id, { enabled: true, password: "never" }, p.id),
    );
    assert.throws(() => configureSchedule(p.id, { enabled: true }, "wrong"));
    configureSchedule(p.id, { enabled: true, intervalMinutes: 60 }, p.id, {
      now,
    });
    const first = runDuePlans({ now });
    await assert.rejects(() => runDuePlans({ now }), /Scheduler active/);
    assert.throws(
      () => recoverScheduleLease("recover-stopped-plan-scheduler"),
      /active/,
    );
    assert.equal((await first).results[0].ok, true);
    assert.equal(planStatus(p.id).ok, true);
    assert.equal((await runDuePlans({ now: now + 1 })).no_due_plans, true);
    assert.equal(scheduleStatus(p.id, now + 60001).overdue, false);
    assert.equal(
      (await runDuePlans({ now: now - 1 })).results[0].code,
      "clock_discontinuity",
    );
    assert.equal(scheduleStatus(p.id, now).state, "blocked");
    fs.renameSync(f.repo, path.join(f.base, "offline"));
    assert.equal(
      configureSchedule(p.id, { enabled: false }, p.id).schedule.enabled,
      false,
    );
  } finally {
    done();
  }
});
test("bounded schedule retries and opt-in checks never capture raw errors or retry anomalies forever", async () => {
  const f = fixture(),
    done = state(f);
  try {
    put(f.source, "secret-filename", "controlled");
    const p = savePlan({
        name: "private-plan-name",
        type: "files",
        repository: f.repo,
        source: f.source,
      }),
      now = Date.now(),
      runner = async () => {
        throw new Error("SECRET_TOKEN_AND_PRIVATE_PATH");
      };
    configureSchedule(
      p.id,
      { enabled: true, attemptLimit: 2, retryMinutes: 1 },
      p.id,
      { now },
    );
    await assert.rejects(
      () => runDuePlans({ now, runner }),
      /controlled simulation/,
    );
    assert.equal(
      (await runDuePlans({ now, runner, controlledSimulation: true }))
        .results[0].retry,
      true,
    );
    assert.equal(
      (
        await runDuePlans({
          now: now + 59999,
          runner,
          controlledSimulation: true,
        })
      ).no_due_plans,
      true,
    );
    assert.equal(
      (
        await runDuePlans({
          now: now + 60000,
          runner,
          controlledSimulation: true,
        })
      ).results[0].retry,
      false,
    );
    assert.equal(
      (
        await runDuePlans({
          now: now + 120000,
          runner,
          controlledSimulation: true,
        })
      ).no_due_plans,
      true,
    );
    assert.equal(scheduleStatus(p.id, now + 120000).attempts, 2);
    const exhausted = await runDuePlans({
      now: now + 120000,
      runner,
      controlledSimulation: true,
    });
    assert.equal(exhausted.ok, false);
    assert.equal(exhausted.blocked_plans[0].id, p.id);
    const record = fs.readFileSync(
      path.join(
        process.env.MOONRESTORE_HOME,
        "plan-schedules-v1",
        p.id + ".json",
      ),
      "utf8",
    );
    assert.equal(record.includes("SECRET_TOKEN"), false);
    const summary = JSON.stringify(supportSummary());
    for (const value of [
      f.base,
      "private-plan-name",
      "secret-filename",
      p.id,
      "SECRET_TOKEN",
    ])
      assert.equal(summary.includes(value), false);
    assert.equal(
      negotiateProvider({
        provider: "s3",
        contract: 1,
        required: ["conditional_create"],
      }).negotiated,
      true,
    );
    for (const request of [
      { provider: "local", contract: 2, required: [] },
      { provider: "windows_vss", contract: 1, required: [] },
      { provider: "local", contract: 1, required: ["versioned_read"] },
      {
        provider: "local",
        contract: 1,
        required: [],
        executable: "not-loaded",
      },
    ])
      assert.throws(() => negotiateProvider(request));
  } finally {
    done();
  }
});

test("workbench automatic loop runs opted-in unified plans but never a merely saved plan", async () => {
  const f = fixture(),
    done = state(f);
  let app;
  try {
    put(f.source, "a", "automatic synthetic sample");
    const p = savePlan({
      name: "opt-in",
      type: "files",
      repository: f.repo,
      source: f.source,
      reserveBytes: 0,
    });
    app = await startWorkbench({
      port: 0,
      autoRun: true,
      autoIntervalMs: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(planStatus(p.id).evidence.backup, undefined);
    configureSchedule(p.id, { enabled: true, intervalMinutes: 1440 }, p.id);
    const began = Date.now();
    while (!planStatus(p.id).ok && Date.now() - began < 60000)
      await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(planStatus(p.id).ok, true);
    while (
      scheduleStatus(p.id).state === "running" &&
      Date.now() - began < 60000
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(scheduleStatus(p.id).state, "ready");
    assert.equal(scheduleStatus(p.id).overdue, false);
  } finally {
    if (app) await app.close();
    done();
  }
});

test("unified plan OS preview is data-only, no-overwrite and needs exact installation confirmation", () => {
  const f = fixture(),
    done = state(f);
  try {
    const p = taskPreview("12345678-1234-4123-8123-123456789abc", 15, "plan");
    assert.equal(p.registered, false);
    assert.equal(p.gui_required, false);
    assert.equal(p.current_user_session_required, true);
    assert.ok(
      p.xml.includes(
        "plan-run-due --plan 12345678-1234-4123-8123-123456789abc",
      ),
    );
    assert.ok(p.xml.includes("InteractiveToken"));
    assert.ok(p.xml.includes("IgnoreNew"));
    assert.equal(p.xml.includes("Password"), false);
    assert.throws(() => installTask(p, "wrong")); // No OS write.
    assert.throws(() => taskPreview("../../escape", 15, "plan"));
    assert.throws(() => taskPreview("safe", 0, "plan"));
    assert.notEqual(
      p.task,
      taskPreview("12345678-1234-4123-8123-123456789abc", 15, "job").task,
    );
  } finally {
    done();
  }
});
