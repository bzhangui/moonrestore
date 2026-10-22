import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fixture, put, tree } from "./helpers.mjs";
import { savePlan, runPlan, listPlans } from "../platform/plans.mjs";
import { assertCleanupGuard } from "../platform/plans.mjs";
import { configureSchedule } from "../platform/plan-scheduler.mjs";
import {
  recoveryReadiness,
  publicReadiness,
  sendReadiness,
} from "../platform/readiness.mjs";
import {
  stateMigrationPreview,
  migrateState,
} from "../platform/state-migration.mjs";
function state(f) {
  const old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private-state");
  return () => {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  };
}
test("recovery goals use verified same-snapshot observations and report missing schedules without running them", async () => {
  const f = fixture(),
    done = state(f);
  try {
    put(f.source, "private-name", "owned content");
    const p = savePlan({
      name: "private-plan",
      type: "files",
      repository: f.repo,
      source: f.source,
      reserveBytes: 0,
      rtoMinutes: 1,
    });
    let r = await recoveryReadiness();
    assert.equal(r.ok, false);
    assert.equal(r.plans[0].goal.rpo_state, "unknown");
    await runPlan(p.id);
    r = await recoveryReadiness();
    assert.equal(r.ok, true);
    assert.equal(r.plans[0].goal.rto_state, "within");
    const recordFile = path.join(
        process.env.MOONRESTORE_HOME,
        "plans-v1",
        p.id + ".json",
      ),
      original = JSON.parse(fs.readFileSync(recordFile));
    assert.ok(
      Date.parse(original.evidence.backup.recoveryPointAt) <=
        Date.parse(original.evidence.backup.finished),
    );
    const oldPoint = structuredClone(original);
    oldPoint.evidence.backup.recoveryPointAt = new Date(
      Date.now() - 25 * 3600000,
    ).toISOString();
    fs.writeFileSync(recordFile, JSON.stringify(oldPoint));
    assert.equal(
      (await recoveryReadiness()).plans[0].goal.rpo_state,
      "exceeded",
    );
    assert.equal(listPlans().plans[0].ok, false);
    delete oldPoint.evidence.backup.recoveryPointAt;
    fs.writeFileSync(recordFile, JSON.stringify(oldPoint));
    assert.equal(
      (await recoveryReadiness()).plans[0].goal.rpo_state,
      "unknown",
    );
    fs.writeFileSync(recordFile, JSON.stringify(original));
    const now = Date.now();
    configureSchedule(p.id, { enabled: true, maxRuntimeMinutes: 1 }, p.id, {
      now,
    });
    r = await recoveryReadiness({ now: now + 61000 });
    assert.equal(r.ok, false);
    assert.equal(r.plans[0].schedule, "missing");
    const redacted = JSON.stringify(publicReadiness(r));
    assert.ok(!/private-plan|private-name|source|[a-f0-9]{64}/.test(redacted));
    assert.equal(publicReadiness(r).missing_plans, 1);
    const planFile = path.join(
        process.env.MOONRESTORE_HOME,
        "plans-v1",
        p.id + ".json",
      ),
      record = JSON.parse(fs.readFileSync(planFile));
    record.evidence.drill.durationMs = 60001;
    fs.writeFileSync(planFile, JSON.stringify(record));
    assert.equal(listPlans().plans[0].rto_goal_met, false);
    assert.equal(
      (await recoveryReadiness()).plans[0].goal.rto_state,
      "exceeded",
    );
    record.evidence.drill.durationMs = 1;
    fs.writeFileSync(planFile, JSON.stringify(record));
    fs.renameSync(f.repo, path.join(f.base, "offline"));
    assert.equal(listPlans().plans[0].unavailable, true);
    assert.equal((await recoveryReadiness()).ok, false);
    for (const endpoint of [
      "https://account:synthetic-password@example.invalid",
      "https://example.invalid/?token=synthetic",
      "https://example.invalid/#private",
    ])
      assert.throws(
        () =>
          savePlan({
            name: "reject",
            type: "files",
            repository: path.join(f.base, "offline"),
            source: f.source,
            remote: {
              endpoint,
              bucket: "controlled",
              allowRemote: true,
              accessKeyEnv: "SYNTHETIC_ACCESS",
              secretKeyEnv: "SYNTHETIC_SECRET",
            },
          }),
        /S3 endpoint/,
      );
    assert.throws(
      () =>
        savePlan({
          name: "reject-pg-dsn",
          type: "postgresql",
          repository: path.join(f.base, "offline"),
          postgres: {
            database: "postgresql://user:synthetic@localhost/db",
            user: "owned",
            dumpExecutable: path.join(f.base, "pg_dump"),
            restoreExecutable: path.join(f.base, "pg_restore"),
          },
        }),
      /credential-bearing URLs/,
    );
  } finally {
    done();
  }
});
test("plan completion rejects a controlled clock rollback after the recovery drill without clearing cleanup protection", async () => {
  const f = fixture(),
    done = state(f),
    originalNow = Date.now;
  try {
    put(f.source, "owned", "synthetic clock case");
    const p = savePlan({
        name: "clock",
        type: "files",
        repository: f.repo,
        source: f.source,
        reserveBytes: 0,
      }),
      file = path.join(
        process.env.MOONRESTORE_HOME,
        "plans-v1",
        p.id + ".json",
      );
    Date.now = () => {
      const record = JSON.parse(fs.readFileSync(file));
      return originalNow() - (record.evidence.drill ? 60000 : 0);
    };
    await assert.rejects(runPlan(p.id), /Clock changed during plan completion/);
    Date.now = originalNow;
    assert.throws(() => assertCleanupGuard(f.repo), /blocked/);
    assert.equal(listPlans().plans[0].ok, false);
  } finally {
    Date.now = originalNow;
    done();
  }
});

test("monitor heartbeat is explicit and redacted, rejects redirects and does not claim recipient delivery", async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    requests.push(JSON.parse(body));
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/target" });
      res.end();
    } else {
      res.writeHead(204);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const report = {
    kind: "recovery_readiness",
    ok: false,
    observed_at: new Date().toISOString(),
    plans: [],
    issues: [],
  };
  try {
    assert.equal(
      (await sendReadiness(endpoint, report)).recipient_delivery_confirmed,
      false,
    );
    assert.equal(requests[0].total_plans, 0);
    await assert.rejects(sendReadiness(endpoint + "/redirect", report));
    await assert.rejects(
      sendReadiness("http://example.invalid", report, { allowRemote: true }),
    );
    assert.equal(requests.length, 2);
    const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    try {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      await assert.rejects(
        sendReadiness("https://example.invalid", report, { allowRemote: true }),
        /trusted HTTPS/,
      );
    } finally {
      if (previousTls === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("configuration migration is preview-bound, excludes credentials and never overwrites or changes source", () => {
  const f = fixture();
  try {
    const source = path.join(f.base, "old-state"),
      target = path.join(f.base, "new-state");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "jobs.json"), "[]");
    fs.mkdirSync(path.join(source, "keys"));
    fs.writeFileSync(
      path.join(source, "keys", "private-key"),
      "synthetic never copied",
    );
    const before = tree(source);
    const p = stateMigrationPreview(source, target);
    assert.equal(p.credentials_copied, false);
    assert.throws(() => migrateState(source, target, "bad"));
    assert.equal(fs.existsSync(target), false);
    assert.equal(migrateState(source, target, p.confirmation).files, 1);
    assert.deepEqual(tree(source), before);
    assert.equal(fs.existsSync(path.join(target, "keys")), false);
    assert.throws(() => stateMigrationPreview(source, target));
    const another = path.join(f.base, "other");
    fs.writeFileSync(
      path.join(source, "jobs.json"),
      JSON.stringify({ password: "synthetic" }),
    );
    assert.throws(() => stateMigrationPreview(source, another), /Credential/);
    for (const endpoint of [
      "https://user:synthetic@example.invalid",
      "https://example.invalid/?access_token=synthetic",
    ]) {
      fs.writeFileSync(
        path.join(source, "jobs.json"),
        JSON.stringify({ endpoint }),
      );
      assert.throws(() => stateMigrationPreview(source, another), /Credential/);
    }
  } finally {
    f.cleanup();
  }
});
test("migration rejects changed previews, live leases and unfinished operations", () => {
  const f = fixture();
  try {
    const source = path.join(f.base, "old-state"),
      target = path.join(f.base, "new-state");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "jobs.json"), "[]");
    const p = stateMigrationPreview(source, target);
    fs.writeFileSync(path.join(source, "jobs.json"), "[1]");
    assert.throws(
      () => migrateState(source, target, p.confirmation),
      /changed/,
    );
    fs.mkdirSync(path.join(source, "jobs.lock"));
    assert.throws(
      () => stateMigrationPreview(source, target),
      /lease|interrupted/,
    );
    fs.rmdirSync(path.join(source, "jobs.lock"));
    fs.writeFileSync(
      path.join(source, "jobs.json"),
      JSON.stringify({ activeOperation: "unfinished" }),
    );
    assert.throws(() => stateMigrationPreview(source, target), /Unfinished/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    f.cleanup();
  }
});
