// Optional real OS integration, never part of validate. Human consent required.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { core, removeOwned, saveReport } from "../platform/maintenance.mjs";
import { savePlan, planStatus } from "../platform/plans.mjs";
import {
  configureSchedule,
  schedulerCommand,
  scheduleStatus,
} from "../platform/plan-scheduler.mjs";
import { utf8JsonScript } from "../platform/system.mjs";
if (
  process.platform !== "win32" ||
  process.argv.length !== 3 ||
  process.argv[2] !== "--allow-os-task"
)
  throw new Error(
    "Explicit Windows-only OS task rehearsal: pass --allow-os-task only after authorizing temporary task creation and cleanup",
  );
const parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-plan-qa-")),
  previous = process.env.MOONRESTORE_HOME,
  home = path.join(root, "state");
process.env.MOONRESTORE_HOME = home;
let preview,
  registered = false,
  attempted = false,
  cleanupConfirmed = false,
  result;
function powershell(script, input) {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", utf8JsonScript(script)],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 100000,
      windowsHide: true,
      shell: false,
    },
  );
  if (r.status !== 0)
    throw new Error(
      "Owned plan OS rehearsal failed or current-user permission unavailable",
    );
  return r.stdout;
}
try {
  const source = path.join(root, "source"),
    repository = path.join(root, "repository");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "synthetic.txt"),
    "owned current-user plan rehearsal",
  );
  await core(["init", repository]);
  const p = savePlan({
    name: "仅合成资料的计划任务验收",
    type: "files",
    repository,
    source,
    reserveBytes: 0,
  });
  const configured = configureSchedule(
    p.id,
    { enabled: true, intervalMinutes: 1440 },
    p.id,
  );
  preview = await schedulerCommand(["plan-schedule-preview", p.id]);
  attempted = true;
  await schedulerCommand([
    "plan-schedule-install",
    p.id,
    "--confirm",
    preview.task,
  ]);
  registered = true;
  powershell(
    "$ErrorActionPreference='Stop';$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$service.GetFolder('\\').GetTask($v.task).Run($null)|Out-Null;$end=[DateTime]::UtcNow.AddSeconds(80);do{Start-Sleep -Milliseconds 250;if(Test-Path -LiteralPath $v.schedule){$s=Get-Content -LiteralPath $v.schedule -Raw -Encoding UTF8|ConvertFrom-Json;if($s.clock -gt $v.before -and $s.state -ne 'running'){break}}}while([DateTime]::UtcNow -lt $end)",
    {
      task: preview.task,
      schedule: path.join(home, "plan-schedules-v1", p.id + ".json"),
      before: configured.schedule.clock,
    },
  );
  if (!planStatus(p.id).ok || scheduleStatus(p.id).state !== "ready")
    throw new Error(
      "OS-triggered unified plan did not complete verified recovery evidence",
    );
  await core(["verify", repository, planStatus(p.id).evidence.backup.snapshot]);
  result = {
    format: 1,
    version: JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url)),
    ).version,
    kind: "unified_plan_windows_os_rehearsal",
    ok: true,
    registered_started_and_verified: true,
    current_user_logged_in_only: true,
    real_user_pilot: false,
    overnight_schedule_verified: false,
  };
} finally {
  try {
    if (attempted)
      powershell(
        "$ErrorActionPreference='Stop';$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\\');try{$t=$f.GetTask($v.task)}catch{if($_.Exception.HResult -eq -2147024894){exit 0}else{throw}};$a=$t.Definition.Actions.Item(1);if($t.Definition.RegistrationInfo.Description -ne 'MoonRestore explicit current-user plan' -or $t.Definition.Actions.Count -ne 1 -or $a.Path -ne $v.node -or -not $a.Arguments.Contains($v.home)){throw 'Not the owned task'};$t.Stop(0);$f.DeleteTask($v.task,0)",
        { task: preview.task, node: process.execPath, home },
      );
    cleanupConfirmed = true;
    removeOwned(root, parent, "moonrestore-plan-qa-");
  } finally {
    if (attempted && !cleanupConfirmed)
      console.error(
        JSON.stringify({
          ok: false,
          kind: "os_rehearsal_cleanup_unconfirmed",
          exact_task: preview.task,
          private_fixture_retained: fs.existsSync(root),
          registration_was_confirmed: registered,
          files: saveReport({
            ok: false,
            kind: "os_rehearsal_cleanup_unconfirmed",
            exact_task: preview.task,
            private_fixture: root,
            registration_was_confirmed: registered,
          }),
        }),
      );
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
  }
}
if (result)
  console.log(
    JSON.stringify(
      { ...result, temporary_task_removed: true, files: saveReport(result) },
      null,
      2,
    ),
  );
