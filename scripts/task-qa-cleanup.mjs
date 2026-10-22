// Exact controlled-QA cleanup, never a prefix-wide delete. Human authorization
// for this rehearsal is required. All bindings are checked before deletion.
// Removing a registration does not assert that an instance was stopped.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const task = process.argv[2];
if (
  process.platform !== "win32" ||
  !/^MoonRestore-[a-f0-9]{20}$/.test(task || "")
)
  throw new Error("Exact QA task required");
const input = Buffer.from(
  JSON.stringify({
    task,
    node: process.execPath,
    cli: fileURLToPath(new URL("../bin/moonrestore.mjs", import.meta.url)),
  }),
).toString("base64");
const script = String.raw`
$ErrorActionPreference='Stop'
$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json
$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\')
$t=$f.GetTask($v.task);$a=$t.Definition.Actions.Item(1)
$prefix=[string][char]34+$v.cli+[char]34+' --home '+[char]34
if($t.Definition.RegistrationInfo.Description -ne 'MoonRestore explicit current-user plan' -or $t.Definition.Actions.Count -ne 1 -or $a.Path -ne $v.node -or -not $a.Arguments.StartsWith($prefix) -or $a.Arguments -notmatch '\\moonrestore-plan-qa-[A-Za-z0-9]+\\state" plan-run-due --plan [a-f0-9-]{36}$'){throw 'Not an owned synthetic QA task'}
$f.DeleteTask($v.task,0)
@{ok=$true;exact_owned_task_removed=$true}|ConvertTo-Json -Compress
`;
const r = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
  { encoding: "utf8", timeout: 15000, windowsHide: true, shell: false },
);
if (r.status !== 0) throw new Error("Exact task cleanup not confirmed");
console.log(r.stdout.trim());
