// Current-user interactive Windows task. Preview is read-only; installation is
// explicit and never replaces an existing task. No password or elevation prompt.
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  stateHome,
  writePrivate,
} from "./vault.mjs";
import { hash, cli } from "./maintenance.mjs";
import { utf8JsonScript } from "./system.mjs";
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
export function taskPreview(id, intervalMinutes, kind = "job") {
  if (
    !/^[A-Za-z0-9_-]{1,48}$/.test(id) ||
    !["job", "plan"].includes(kind) ||
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    intervalMinutes > 10080
  )
    throw new Error("Invalid current-user task parameters");
  const home = stateHome();
  if (/["\r\n]/.test(home + cli + process.execPath))
    throw new Error("Unsupported task argument path");
  const task =
      "MoonRestore-" +
      hash(home + ":" + (kind === "job" ? id : "plan:" + id)).slice(0, 20),
    start = new Date(Date.now() + 60000).toISOString(),
    argumentsText =
      '"' +
      cli +
      '" --home "' +
      home +
      '" ' +
      (kind === "job" ? "job-run " : "plan-run-due --plan ") +
      id,
    content = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>MoonRestore explicit current-user ${kind}</Description></RegistrationInfo><Triggers><TimeTrigger><Repetition><Interval>PT${intervalMinutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="User"><UserId>{{SID}}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT24H</ExecutionTimeLimit></Settings><Actions Context="User"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(path.dirname(path.dirname(cli)))}</WorkingDirectory></Exec></Actions></Task>`;
  return {
    ok: true,
    preview: true,
    task,
    xml: content,
    current_user_session_required: true,
    gui_required: false,
    home,
    credentials_included: false,
    registered: false,
    format: 1,
    id,
    kind,
    interval_minutes: intervalMinutes,
    start_boundary: start,
    arguments: argumentsText,
    executable: process.execPath,
    working_directory: path.dirname(path.dirname(cli)),
  };
}
function schedulerRpc(action, request) {
  if (process.platform !== "win32") throw new Error("Windows scheduler only");
  const principal =
    "$currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$principal=[string]$d.Principal.UserId;if($principal -notmatch '^S-1-'){$principal=(New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value};";
  const identity =
    principal +
    "if($d.Actions.Count -ne 1 -or $d.Triggers.Count -ne 1 -or [Xml.XmlConvert]::ToTimeSpan($d.Triggers.Item(1).Repetition.Interval) -ne [Xml.XmlConvert]::ToTimeSpan($v.interval) -or $d.RegistrationInfo.Description -cne $v.description -or $d.Actions.Item(1).Path -cne $v.executable -or $d.Actions.Item(1).Arguments -cne $v.arguments -or $d.Actions.Item(1).WorkingDirectory -cne $v.working_directory -or $principal -ne $currentSid){throw 'identity mismatch'};";
  const scripts = {
    query:
      "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();try{$t=$s.GetFolder('\\').GetTask($v.task)}catch{if($_.Exception.HResult -eq -2147024894 -or $_.Exception.HResult -eq -2147216625){@{state='absent'}|ConvertTo-Json -Compress;exit 0};throw};$d=$t.Definition;" +
      principal +
      "@{state='present';description=$d.RegistrationInfo.Description;executable=$d.Actions.Item(1).Path;arguments=$d.Actions.Item(1).Arguments;working_directory=$d.Actions.Item(1).WorkingDirectory;actions=$d.Actions.Count;triggers=$d.Triggers.Count;interval=$d.Triggers.Item(1).Repetition.Interval;sid=$principal;current_sid=$currentSid;enabled=$t.Enabled;running=($t.State -eq 4)}|ConvertTo-Json -Compress",
    register:
      "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$s.GetFolder('\\').RegisterTask($v.task,$v.xml.Replace('{{SID}}',$sid),2,$sid,$null,3,$null)|Out-Null;@{completed=$true}|ConvertTo-Json -Compress",
    disable:
      "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.GetFolder('\\').GetTask($v.task);$d=$t.Definition;" +
      identity +
      "$t.Enabled=$false;@{completed=$true}|ConvertTo-Json -Compress",
    remove:
      "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\\');$t=$f.GetTask($v.task);$d=$t.Definition;" +
      identity +
      "if($t.State -eq 4){throw 'task running'};$f.DeleteTask($v.task,0);@{completed=$true}|ConvertTo-Json -Compress",
    run:
      "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$t=$s.GetFolder('\\').GetTask($v.task);$d=$t.Definition;" +
      identity +
      "if($t.State -eq 4 -or -not $t.Enabled){throw 'disabled or running'};$t.Run($null)|Out-Null;@{completed=$true}|ConvertTo-Json -Compress",
  };
  if (!Object.hasOwn(scripts, action))
    throw new Error("Unsupported scheduler operation");
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      utf8JsonScript("$ErrorActionPreference='Stop';" + scripts[action]),
    ],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: action === "register" ? 30000 : 5000,
      maxBuffer: 65536,
      windowsHide: true,
      shell: false,
    },
  );
  if (r.error || r.status !== 0)
    throw new Error(
      "Scheduler operation unconfirmed; inspect exact task before retrying",
    );
  try {
    return JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Scheduler reply invalid; state unconfirmed");
  }
}
export class TaskController {
  constructor({ rpc = schedulerRpc, controlledSimulation = false } = {}) {
    if (rpc !== schedulerRpc && !controlledSimulation)
      throw new Error("Custom scheduler requires controlled simulation");
    this.rpc = rpc;
    this.simulation = controlledSimulation;
  }
  file(task) {
    if (!/^MoonRestore-[a-f0-9]{20}$/.test(task))
      throw new Error("Invalid exact task name");
    return path.join(stateHome(), "os-tasks", task + ".json");
  }
  save(record) {
    const file = this.file(record.task);
    mkdirPrivate(path.dirname(file));
    checked(file, false);
    if (fs.existsSync(file)) readPrivate(file, 65536);
    const temporary = file + "." + randomUUID() + ".tmp";
    writePrivate(temporary, JSON.stringify(record));
    try {
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  load(task) {
    const r = JSON.parse(readPrivate(this.file(task), 65536));
    if (r.format !== 1 || r.task !== task || r.home !== stateHome())
      throw new Error("Task intent identity mismatch");
    return r;
  }
  matches(r, q) {
    const minutes = (v) => {
      const m =
        typeof v === "string" &&
        v.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
      if (!m || !m.slice(1).some(Boolean)) return null;
      const result =
        Number(m[1] ?? 0) * 1440 +
        Number(m[2] ?? 0) * 60 +
        Number(m[3] ?? 0) +
        Number(m[4] ?? 0) / 60;
      return Number.isSafeInteger(result) && result >= 1 && result <= 10080
        ? result
        : null;
    };
    return (
      q.state === "present" &&
      q.actions === 1 &&
      q.triggers === 1 &&
      minutes(q.interval) !== null &&
      minutes(q.interval) === minutes(r.interval) &&
      q.sid === q.current_sid &&
      q.description === r.description &&
      q.executable === r.executable &&
      q.arguments === r.arguments &&
      q.working_directory === r.working_directory &&
      typeof q.enabled === "boolean" &&
      typeof q.running === "boolean"
    );
  }
  query(r) {
    try {
      const q = this.rpc("query", r);
      if (q.state === "absent") return { state: "absent" };
      if (this.matches(r, q)) return { ...q, state: "owned" };
      return { state: "conflict" };
    } catch {
      return { state: "unknown" };
    }
  }
  status(task) {
    const r = this.load(task),
      q = this.query(r);
    return {
      ok: q.state !== "unknown" && q.state !== "conflict",
      task,
      state: q.state,
      registered:
        q.state === "owned" ? true : q.state === "absent" ? false : null,
      enabled: q.enabled ?? null,
      running: q.running ?? null,
      current_user_session_required: true,
      controlled_simulation: this.simulation,
    };
  }
  install(preview, confirmation) {
    if (
      confirmation !== preview?.task ||
      preview.format !== 1 ||
      preview.home !== stateHome()
    )
      throw new Error("Confirm exact fresh preview task name");
    const expected = taskPreview(
      preview.id,
      preview.interval_minutes,
      preview.kind,
    );
    const start = preview.start_boundary;
    if (
      typeof start !== "string" ||
      !Number.isFinite(Date.parse(start)) ||
      new Date(start).toISOString() !== start ||
      Math.abs(Date.now() - Date.parse(start)) > 86400000
    )
      throw new Error("Expired task preview");
    if (
      expected.task !== preview.task ||
      expected.xml.replace(expected.start_boundary, start) !== preview.xml
    )
      throw new Error("Task preview changed; regenerate preview");
    const r = {
      format: 1,
      task: expected.task,
      home: stateHome(),
      description: "MoonRestore explicit current-user " + preview.kind,
      executable: expected.executable,
      arguments: expected.arguments,
      working_directory: expected.working_directory,
      interval: "PT" + preview.interval_minutes + "M",
      phase: "prepared",
      updated: new Date().toISOString(),
    };
    const existing = fs.existsSync(this.file(r.task))
      ? this.load(r.task)
      : null;
    if (
      existing &&
      [
        "executable",
        "arguments",
        "working_directory",
        "description",
        "interval",
      ].some((k) => existing[k] !== r[k])
    )
      throw new Error("Task intent conflict; explicitly reconcile old task");
    const q = this.query(r);
    if (q.state === "owned") {
      this.save({ ...r, phase: "confirmed" });
      return {
        ok: true,
        task: r.task,
        state: "owned",
        registered: true,
        enabled: q.enabled,
        idempotent: true,
        current_user_session_required: true,
        controlled_simulation: this.simulation,
      };
    }
    if (q.state !== "absent")
      throw new Error(
        "Scheduler task conflict or state unconfirmed; registration was not attempted",
      );
    this.save({ ...r, phase: "attempted" });
    try {
      this.rpc("register", { ...r, xml: preview.xml });
    } catch {}
    const after = this.query(r);
    this.save({
      ...r,
      phase: after.state === "owned" ? "confirmed" : "unconfirmed",
    });
    if (after.state !== "owned")
      throw new Error(
        "OS schedule registration not confirmed; inspect exact task before retrying",
      );
    return {
      ok: true,
      task: r.task,
      registered: true,
      idempotent: false,
      current_user_session_required: true,
      gui_required: false,
      controlled_simulation: this.simulation,
    };
  }
  change(task, confirmation, action) {
    if (confirmation !== task || !["disable", "remove"].includes(action))
      throw new Error("Confirm exact owned task action");
    const r = this.load(task),
      before = this.query(r);
    if (before.state === "absent")
      return { ok: true, task, state: "absent", registered: false };
    if (before.state !== "owned" || (action === "remove" && before.running))
      throw new Error(
        "Owned non-running task required; operation not attempted",
      );
    this.save({ ...r, phase: action + "_attempted" });
    try {
      this.rpc(action, r);
    } catch {}
    const q = this.query(r),
      ok =
        action === "remove"
          ? q.state === "absent"
          : q.state === "owned" && q.enabled === false;
    this.save({ ...r, phase: ok ? action + "_confirmed" : "unconfirmed" });
    if (!ok)
      throw new Error(
        "Task change not confirmed; preserve task intent and inspect exact identity",
      );
    return {
      ok: true,
      task,
      state: q.state,
      registered: q.state === "owned",
      enabled: q.enabled ?? null,
    };
  }
  run(task, confirmation) {
    if (confirmation !== task)
      throw new Error("Confirm exact owned task execution");
    const record = this.load(task),
      before = this.query(record);
    if (before.state !== "owned" || before.running || !before.enabled)
      throw new Error(
        "Owned enabled non-running task required; execution not attempted",
      );
    this.rpc("run", record);
    return {
      ok: true,
      task,
      execution_requested: true,
      execution_completed_verified: false,
      controlled_simulation: this.simulation,
    };
  }
}
export function installTask(preview, confirmation) {
  return new TaskController().install(preview, confirmation);
}
export function taskControlCommand(args) {
  const [command, task, flag, confirmation, ...rest] = args;
  if (
    !["os-task-status", "os-task-disable", "os-task-remove"].includes(command)
  )
    return null;
  if (
    rest.length ||
    (command === "os-task-status" && flag !== undefined) ||
    (command !== "os-task-status" &&
      (flag !== "--confirm" || confirmation !== task))
  )
    throw new Error("Expected exact task and confirmation");
  const controller = new TaskController();
  return command === "os-task-status"
    ? controller.status(task)
    : controller.change(
        task,
        confirmation,
        command === "os-task-disable" ? "disable" : "remove",
      );
}
