// Explicit Windows-only owned Task Scheduler roundtrip; no existing tasks touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { core, removeOwned, saveReport } from "../platform/maintenance.mjs";
import {
  saveJob,
  schedulePreview,
  scheduleInstall,
} from "../platform/jobs.mjs";
if (process.platform !== "win32")
  throw new Error("Windows-only integration; not silently skipped");
const parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-scheduler-")),
  previous = process.env.MOONRESTORE_HOME;
process.env.MOONRESTORE_HOME = path.join(root, "state");
let preview;
function powershell(command, input) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 55000,
      windowsHide: true,
      shell: false,
    },
  );
  if (r.status !== 0)
    throw new Error("Owned scheduler test failed or permission unavailable");
  return r;
}
try {
  const source = path.join(root, "source"),
    repository = path.join(root, "vault");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "data"), "synthetic scheduled backup");
  await core(["init", repository]);
  await saveJob({
    id: "controlled-scheduler",
    repository,
    source,
    reserveBytes: "0",
  });
  preview = schedulePreview("controlled-scheduler");
  scheduleInstall("controlled-scheduler", preview.task);
  powershell(
    "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; Start-ScheduledTask -TaskName $v.task; $end=[DateTime]::UtcNow.AddSeconds(40); do { Start-Sleep -Milliseconds 250; if(Test-Path -LiteralPath $v.state){$j=Get-Content -LiteralPath $v.state -Raw|ConvertFrom-Json;if($j.jobs[0].lastRun.finished){break}} } while([DateTime]::UtcNow -lt $end)",
    {
      task: preview.task,
      state: path.join(process.env.MOONRESTORE_HOME, "jobs.json"),
    },
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(process.env.MOONRESTORE_HOME, "jobs.json")),
  );
  if (config.jobs[0].lastRun?.ok !== true)
    throw new Error("Scheduled backup did not finish successfully");
  const report = {
    format: 1,
    version: JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url)),
    ).version,
    kind: "windows_scheduler_roundtrip",
    ok: true,
    current_user: true,
    registered_started_and_verified: true,
    overnight_schedule_verified: false,
    controlled_sample: true,
  };
  if (previous === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = previous;
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  if (preview)
    powershell(
      "$ErrorActionPreference='Stop'; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $t=Get-ScheduledTask -TaskName $v.task -ErrorAction SilentlyContinue; if($t){if($t.Description -ne 'MoonRestore controlled current-user backup job' -or $t.Actions[0].Execute -ne $v.node -or -not $t.Actions[0].Arguments.Contains($v.home)){throw 'Refusing cleanup of non-owned task'}; Stop-ScheduledTask -TaskName $v.task -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $v.task -Confirm:$false}",
      {
        task: preview.task,
        node: process.execPath,
        home: path.join(root, "state"),
      },
    );
  if (previous === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = previous;
  removeOwned(root, parent, "moonrestore-scheduler-");
}
