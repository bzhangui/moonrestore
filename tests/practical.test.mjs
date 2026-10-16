import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, call, backup, snapshot, forge } from "./helpers.mjs";
import {
  saveJob,
  listJobs,
  changeJob,
  runJob,
  runDue,
} from "../platform/jobs.mjs";
import { TaskManager } from "../platform/activity.mjs";
import { core } from "../platform/maintenance.mjs";
import {
  history,
  searchHistory,
  restorePlan,
  restoreSelected,
  previewText,
} from "../platform/explorer.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { utf8JsonScript } from "../platform/system.mjs";

test(
  "Windows JSON transport preserves Chinese and never evaluates data as PowerShell",
  { skip: process.platform !== "win32" },
  () => {
    const message =
      '受控备份完成：论文 ✓ 中文路径/引号" 和 $(Write-Output unexpected)';
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        utf8JsonScript(
          "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json; [Console]::Write($v.message)",
        ),
      ],
      {
        input: JSON.stringify({ message }),
        encoding: "utf8",
        windowsHide: true,
        shell: false,
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, message);
  },
);
async function owned(work) {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    await work(f);
  } finally {
    previous === undefined
      ? delete process.env.MOONRESTORE_HOME
      : (process.env.MOONRESTORE_HOME = previous);
    f.cleanup();
  }
}
test("metadata and multi-selection restore retain times without changing old public models", () =>
  owned(async (f) => {
    put(f.source, "folder/a.txt", "alpha");
    put(f.source, "b.txt", "beta");
    put(f.source, "skip.txt", "skip");
    const input = path.join(f.source, "folder/a.txt"),
      when = 1700000000;
    fs.utimesSync(input, when, when);
    if (process.platform !== "win32") fs.chmodSync(input, 0o640);
    const b = backup(f),
      model = snapshot(f, b.snapshot);
    assert.ok(model.metadata.length >= 3);
    const target = path.join(f.base, "selected"),
      request = {
        repository: f.repo,
        snapshot: b.snapshot,
        target,
        selections: ["folder/a.txt", "b.txt"],
        restoreModes: true,
      },
      plan = await restorePlan(request);
    assert.equal(plan.files, 2);
    await restoreSelected({ ...request, confirmation: plan.confirmation });
    assert.equal(
      fs.readFileSync(path.join(target, "folder/a.txt"), "utf8"),
      "alpha",
    );
    assert.equal(fs.existsSync(path.join(target, "skip.txt")), false);
    assert.ok(
      Math.abs(
        fs.statSync(path.join(target, "folder/a.txt")).mtimeMs - when * 1000,
      ) < 2,
    );
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(target, "folder/a.txt")).mode & 0o777,
        0o640,
      );
    await assert.rejects(() =>
      restoreSelected({
        ...request,
        target: target + "-changed",
        confirmation: plan.confirmation,
      }),
    );
  }));
test("hostile metadata is rejected before restoration or filesystem attribute changes", () =>
  owned(async (f) => {
    put(f.source, "a.txt", "value");
    const b = backup(f),
      good = snapshot(f, b.snapshot);
    for (const item of [
      { path: "../escape", mtime_ms: "0", mode: 384 },
      { path: "a.txt", mtime_ms: "-1", mode: 384 },
      { path: "a.txt", mtime_ms: "0", mode: 0.5 },
    ]) {
      const id = forge(f, { ...good, metadata: [item] });
      call(["restore", f.repo, id, path.join(f.base, "out")], { status: 1 });
      assert.equal(fs.existsSync(path.join(f.base, "out")), false);
    }
  }));
test("revision-bound job edit pause resume and deletion never delete snapshots", () =>
  owned(async (f) => {
    put(f.source, "a.txt", "one");
    const b = backup(f),
      base = {
        id: "manage",
        repository: f.repo,
        source: f.source,
        reserveBytes: "0",
      };
    await saveJob(base);
    let job = listJobs()[0];
    const revision = job.revision;
    changeJob(job.id, "pause", revision);
    assert.equal((await runDue()).no_due_jobs, true);
    await assert.rejects(() => runJob(job.id));
    assert.throws(() => changeJob(job.id, "delete", revision));
    job = listJobs()[0];
    changeJob(job.id, "resume", job.revision);
    job = listJobs()[0];
    await saveJob(
      { ...base, intervalMinutes: 25 },
      { replace: true, confirmation: job.revision },
    );
    assert.equal(listJobs()[0].intervalMinutes, 25);
    changeJob(job.id, "delete", listJobs()[0].revision);
    assert.equal(listJobs().length, 0);
    assert.equal(call(["list", f.repo]).snapshots[0].id, b.snapshot);
  }));
test("legacy job upgrade preserves an exact private rollback config without overwriting it", () =>
  owned(async (f) => {
    put(f.source, "a.txt", "legacy");
    await saveJob({ id: "legacy", repository: f.repo, source: f.source });
    const file = path.join(process.env.MOONRESTORE_HOME, "jobs.json");
    const c = JSON.parse(fs.readFileSync(file));
    const fields = [
      "paused",
      "notify",
      "automatic",
      "retryLimit",
      "retryMinutes",
      "retries",
      "nextAttempt",
      "maxRuntimeMinutes",
      "lastBackup",
      "lastVerified",
      "lastDrill",
      "lastReplica",
    ];
    for (const j of c.jobs) for (const field of fields) delete j[field];
    const original = JSON.stringify(c);
    fs.writeFileSync(file, original);
    assert.equal(listJobs()[0].id, "legacy");
    changeJob("legacy", "pause", listJobs()[0].revision);
    const saved = path.join(
      process.env.MOONRESTORE_HOME,
      "jobs-v02-before-upgrade.json",
    );
    assert.equal(fs.readFileSync(saved, "utf8"), original);
    changeJob("legacy", "resume", listJobs()[0].revision);
    assert.equal(fs.readFileSync(saved, "utf8"), original);
    fs.writeFileSync(file, original);
    assert.equal(listJobs()[0].id, "legacy");
  }));

test("offline retries are bounded and do not silently accept a replacement repository", () =>
  owned(async (f) => {
    put(f.source, "a", "one");
    await saveJob({
      id: "offline",
      repository: f.repo,
      source: f.source,
      retryLimit: 1,
      retryMinutes: 1,
    });
    const moved = f.repo + "-offline";
    fs.renameSync(f.repo, moved);
    try {
      const first = await runJob("offline");
      assert.equal(first.failure_code, "device_unavailable");
      assert.ok(first.retry_at);
      assert.equal((await runDue()).no_due_jobs, true);
      assert.equal((await runJob("offline")).retry_at, undefined);
    } finally {
      fs.renameSync(moved, f.repo);
    }
  }));
test("configured secondary copy is audited and evidence clocks stay separate", () =>
  owned(async (f) => {
    put(f.source, "data", "payload");
    const secondary = path.join(f.base, "secondary");
    call(["init", secondary]);
    await saveJob({
      id: "replicated",
      repository: f.repo,
      source: f.source,
      secondaryRepository: secondary,
      reserveBytes: "0",
    });
    const result = await runJob("replicated");
    assert.equal(result.ok, true);
    assert.equal(result.replica.destination_audited, true);
    assert.equal(result.replica.independent_physical_device_verified, false);
    const job = listJobs()[0];
    for (const key of [
      "lastBackup",
      "lastVerified",
      "lastDrill",
      "lastReplica",
    ])
      assert.ok(job[key]);
    assert.equal(call(["list", secondary]).snapshots.length, 1);
  }));
test("search traverses history batches and text previews verify only the selected file", () =>
  owned(async (f) => {
    put(f.source, "report.md", "<script>not executed</script>");
    const first = backup(f);
    put(f.source, "report.md", "second");
    backup(f);
    const list = await history(f.repo, { query: "" });
    assert.equal(list.total, 2);
    let page = await searchHistory(f.repo, { query: "report.md" });
    assert.equal(page.results.length, 1);
    assert.equal(page.next, 1);
    page = await searchHistory(f.repo, {
      query: "report.md",
      offset: page.next,
      state: page.state,
    });
    assert.equal(page.results.length, 1);
    assert.equal(page.next, null);
    const text = await previewText(f.repo, first.snapshot, "report.md");
    assert.equal(text.text, "<script>not executed</script>");
    assert.equal(text.executable, false);
    await assert.rejects(() =>
      searchHistory(f.repo, { query: ".*", state: "stale" }),
    );
  }));
test(
  "cooperative cancellation cleans locks and never exposes a partial snapshot",
  { timeout: 20000 },
  () =>
    owned(async (f) => {
      put(f.source, "controlled.bin", Buffer.alloc(32 * 1024 * 1024, 7));
      const manager = new TaskManager();
      manager.start(() => core(["backup", f.repo, f.source]));
      const deadline = Date.now() + 10000;
      while (
        manager.state().status === "running" &&
        !(manager.state().progress.read_bytes > 0) &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      if (manager.state().status === "running")
        manager.cancel(manager.state().id);
      await manager.close();
      assert.ok(["cancelled", "completed"].includes(manager.state().status));
      assert.equal(fs.existsSync(path.join(f.repo, ".lock")), false);
      for (const entry of call(["list", f.repo]).snapshots)
        call(["verify", f.repo, entry.id]);
      assert.equal(
        fs.readdirSync(path.join(process.env.MOONRESTORE_HOME, "control"))
          .length,
        0,
      );
    }),
);
test("workbench encryption lifecycle never echoes credentials and recovery drill uses its own key", () =>
  owned(async (f) => {
    const app = await startWorkbench({ port: 0 }),
      repository = path.join(f.base, "encrypted"),
      password = "controlled-unique-password",
      next = "new-controlled-long-password";
    const request = async (route, body) => {
      const r = await fetch(app.origin + "/api/" + route, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      assert.ok(!text.includes(password));
      assert.ok(!text.includes(next));
      return { status: r.status, body: JSON.parse(text) };
    };
    try {
      const initialized = await request("init-encrypted", {
        repository,
        password,
        confirmation: repository,
      });
      assert.equal(initialized.status, 200);
      assert.equal(initialized.body.ok, true);
      put(f.source, "secret.txt", "value");
      const b = call(["backup", repository, f.source], {
        env: { MOONRESTORE_PASSWORD: password },
      });
      const key = path.join(f.base, "recovery-key.json");
      assert.equal(
        (
          await request("key-export", {
            repository,
            output: key,
            confirmation: repository,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request("password-change", {
            repository,
            newPassword: next,
            confirmation: repository,
          })
        ).status,
        200,
      );
      call(["list", repository], {
        env: { MOONRESTORE_PASSWORD: password },
        status: 1,
      });
      call(["list", repository], { env: { MOONRESTORE_PASSWORD: next } });
      assert.equal((await request("lock-session", {})).status, 200);
      assert.equal(
        (
          await request("key-drill", {
            repository,
            snapshot: b.snapshot,
            recoveryKeyFile: key,
          })
        ).body.ok,
        true,
      );
      const state = await fetch(app.origin + "/api/task", {
        headers: { Authorization: "Bearer " + app.token },
      });
      assert.ok(!(await state.text()).includes(password));
    } finally {
      await app.close();
    }
  }));
test("broad file searches paginate within snapshots without returning chunk arrays", () =>
  owned(async (f) => {
    for (let n = 0; n < 205; n++)
      put(f.source, "sample-" + n + ".txt", String(n));
    backup(f);
    const first = await searchHistory(f.repo, { query: "sample-" });
    assert.equal(first.results.length, 200);
    assert.equal(first.next, 0);
    assert.ok(first.nextEntry > 0);
    assert.equal("chunks" in first.results[0], false);
    const second = await searchHistory(f.repo, {
      query: "sample-",
      offset: first.next,
      entryOffset: first.nextEntry,
      state: first.state,
    });
    assert.equal(second.results.length, 5);
    assert.equal(second.next, null);
    assert.equal(
      new Set([...first.results, ...second.results].map((e) => e.path)).size,
      205,
    );
  }));
test(
  "automatic workbench runs only explicitly opted-in jobs",
  { timeout: 15000 },
  () =>
    owned(async (f) => {
      put(f.source, "data", "one");
      await saveJob({
        id: "auto",
        repository: f.repo,
        source: f.source,
        reserveBytes: "0",
        automatic: false,
      });
      const app = await startWorkbench({
        port: 0,
        autoRun: true,
        autoIntervalMs: 1000,
      });
      try {
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal(call(["list", f.repo]).snapshots.length, 0);
        const job = listJobs()[0];
        await saveJob(
          {
            id: job.id,
            repository: f.repo,
            source: f.source,
            reserveBytes: "0",
            automatic: true,
          },
          { replace: true, confirmation: job.revision },
        );
        const end = Date.now() + 10000;
        while (!listJobs()[0].lastSuccess && Date.now() < end)
          await new Promise((r) => setTimeout(r, 100));
        assert.ok(listJobs()[0].lastSuccess);
        assert.equal(call(["list", f.repo]).snapshots.length, 1);
      } finally {
        await app.close();
      }
    }),
);
test(
  "a failed bind never leaves an automatic backup loop behind",
  { timeout: 10000 },
  () =>
    owned(async (f) => {
      put(f.source, "data", "one");
      await saveJob({
        id: "bind",
        repository: f.repo,
        source: f.source,
        reserveBytes: "0",
        automatic: true,
      });
      const occupying = http.createServer();
      await new Promise((resolve) => occupying.listen(0, "127.0.0.1", resolve));
      try {
        await assert.rejects(() =>
          startWorkbench({
            port: occupying.address().port,
            autoRun: true,
            autoIntervalMs: 1000,
          }),
        );
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal(call(["list", f.repo]).snapshots.length, 0);
      } finally {
        await new Promise((resolve) => occupying.close(resolve));
      }
    }),
);
test("cancelling a nonexistent task cannot unlock a concurrent confirmed direct operation", () =>
  owned(async (f) => {
    const app = await startWorkbench({ port: 0 });
    const request = async (route, body) => {
      const r = await fetch(app.origin + "/api/" + route, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          Origin: app.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    let pending;
    try {
      const repository = path.join(f.base, "encrypted");
      pending = request("init-encrypted", {
        repository,
        password: "controlled-test-password",
        confirmation: repository,
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        (await request("task-cancel", { id: "unknown" })).status,
        400,
      );
      assert.equal((await request("job-save", {})).status, 409);
      assert.equal((await pending).status, 200);
    } finally {
      await pending;
      await app.close();
    }
  }));
