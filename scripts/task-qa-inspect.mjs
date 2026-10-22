// Read-only alternative to the ScheduledTasks CIM cmdlets. No registration,
// deletion, startup, service restart or privilege changes are performed here.
import { spawnSync } from "node:child_process";
if (process.platform !== "win32")
  throw new Error("Windows-only task inspection");
const script =
  "$ErrorActionPreference='Stop';$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$owned=@($s.GetFolder('\\').GetTasks(0)|Where-Object{$_.Name -like 'MoonRestore-*' -and $_.Definition.RegistrationInfo.Description -eq 'MoonRestore explicit current-user plan' -and $_.Definition.Actions.Item(1).Arguments -match 'moonrestore-plan-qa-'});@{query_completed=$true;owned_qa_tasks=$owned.Count;names=@($owned|ForEach-Object{$_.Name})}|ConvertTo-Json -Compress";
const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  { encoding: "utf8", timeout: 15000, windowsHide: true, shell: false },
);
if (r.status === 0) {
  try {
    const v = JSON.parse(r.stdout.replace(/^\uFEFF/, ""));
    console.log(JSON.stringify(v));
  } catch {
    throw new Error("Task inspection response invalid");
  }
} else {
  console.log(
    JSON.stringify({
      query_completed: false,
      timed_out: r.error?.code === "ETIMEDOUT",
      absence_confirmed: false,
    }),
  );
  process.exitCode = 1;
}
