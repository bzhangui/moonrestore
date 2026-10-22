// Current-user interactive Windows task. Preview is read-only; installation is
// explicit and never replaces an existing task. No password or elevation prompt.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stateHome } from "./vault.mjs";
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
  };
}
export function installTask(preview, confirmation) {
  if (process.platform !== "win32")
    throw new Error(
      "Automatic OS registration currently supports Windows only",
    );
  if (
    !/^MoonRestore-[a-f0-9]{20}$/.test(preview.task) ||
    confirmation !== preview.task
  )
    throw new Error("Confirm the exact preview task name");
  // Require a responsive read-only RPC before any registration attempt.
  const health = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$null=$s.GetRunningTasks(0).Count;Write-Output 'scheduler-responsive'",
    ],
    { encoding: "utf8", timeout: 5000, windowsHide: true, shell: false },
  );
  if (
    health.error ||
    health.status !== 0 ||
    health.stdout.trim() !== "scheduler-responsive"
  )
    throw new Error(
      "Windows scheduler health check timed out or failed; registration was not attempted",
    );
  const script =
    "$ErrorActionPreference='Stop';try{$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$folder=$s.GetFolder('\\');$xml=$v.xml.Replace('{{SID}}',$sid);$folder.RegisterTask($v.task,$xml,2,$sid,$null,3,$null)|Out-Null}catch{@{code=$_.Exception.HResult.ToString('X8')}|ConvertTo-Json -Compress;exit 1}";
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", utf8JsonScript(script)],
    {
      input: JSON.stringify(preview),
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      shell: false,
    },
  );
  if (r.error || r.status !== 0) {
    let code =
      r.error?.code === "ETIMEDOUT"
        ? "timeout_registration_unconfirmed"
        : "unavailable";
    try {
      const record = JSON.parse((r.stdout || "").replace(/^\uFEFF/, ""));
      if (/^[A-Fa-f0-9]{8}$/.test(record.code)) code = record.code;
    } catch {}
    throw new Error(
      "OS schedule registration not confirmed; inspect this exact preview task before retrying; code=" +
        code,
    );
  }
  return {
    ok: true,
    task: preview.task,
    registered: true,
    current_user_session_required: true,
    gui_required: false,
  };
}
