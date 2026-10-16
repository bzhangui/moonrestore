// Explicit native dialogs and read-only device/VSS diagnostics. No shell strings from paths.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { checked } from "./vault.mjs";
function powershell(script, input, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      error = "";
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 65536) child.kill();
    });
    child.stderr.on("data", (b) => {
      if (error.length < 4096) error += b;
    });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(new Error("Windows operation failed or was cancelled"));
      try {
        resolve(JSON.parse(output.replace(/^\uFEFF/, "")));
      } catch {
        reject(new Error("Invalid Windows response"));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
export async function choosePath(kind) {
  if (process.platform !== "win32")
    throw new Error("Native picker currently requires Windows");
  if (!["folder", "key-open", "key-save"].includes(kind))
    throw new Error("Invalid picker kind");
  const script =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; if($v.kind -eq 'folder'){$d=New-Object Windows.Forms.FolderBrowserDialog; $d.Description='MoonRestore - select a folder';$d.ShowNewFolderButton=$false}else{if($v.kind -eq 'key-open'){$d=New-Object Windows.Forms.OpenFileDialog}else{$d=New-Object Windows.Forms.SaveFileDialog;$d.OverwritePrompt=$true};$d.Filter='Recovery key (*.json)|*.json';$d.CheckPathExists=$true};try{$value=$null;if($d.ShowDialog() -eq [Windows.Forms.DialogResult]::OK){if($v.kind -eq 'folder'){$value=$d.SelectedPath}else{$value=$d.FileName}};@{ok=$true;path=$value}|ConvertTo-Json -Compress}finally{$d.Dispose()}";
  return powershell(script, { kind }, { timeout: 120000 });
}
export function openFolder(directory) {
  const full = checked(directory);
  if (!fs.statSync(full).isDirectory()) throw new Error("Expected folder");
  if (process.platform !== "win32")
    throw new Error("Open-folder currently requires Windows");
  const child = spawn("explorer.exe", [full], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
  return { ok: true, open_requested: true };
}
export async function deviceRelation(first, second) {
  const a = checked(first),
    b = checked(second);
  if (process.platform !== "win32")
    return {
      ok: true,
      relation:
        fs.statSync(a).dev === fs.statSync(b).dev
          ? "same_filesystem"
          : "physical_device_unknown",
      independent_device_verified: false,
    };
  const drives = [a, b].map((v) => /^([a-z]):/i.exec(v)?.[1]);
  if (drives.some((v) => !v))
    return {
      ok: true,
      relation: "physical_device_unknown",
      independent_device_verified: false,
    };
  try {
    return await powershell(
      "$ErrorActionPreference='Stop';$v=[Console]::In.ReadToEnd()|ConvertFrom-Json;$a=Get-Partition -DriveLetter $v.first;$b=Get-Partition -DriveLetter $v.second;@{ok=$true;relation=$(if($a.DiskNumber -eq $b.DiskNumber){'same_reported_disk'}else{'different_reported_disks'});independent_device_verified=$false}|ConvertTo-Json -Compress",
      { first: drives[0], second: drives[1] },
    );
  } catch {
    return {
      ok: true,
      relation: "physical_device_unknown",
      independent_device_verified: false,
    };
  }
}
export async function vssPreflight(source) {
  checked(source);
  if (process.platform !== "win32")
    return { ok: false, supported_platform: false, shadow_copy_created: false };
  const status = await powershell(
    "$ErrorActionPreference='Stop';$s=Get-Service VSS; $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent());@{service_status=$s.Status.ToString();administrator=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress",
    {},
  );
  return {
    ok: true,
    ...status,
    shadow_copy_created: false,
    application_consistency_verified: false,
    backup_mode: "live_files_with_change_detection",
    note: "Read-only readiness check; not a VSS requester. Writers and snapshot lifecycle require a separate privileged adapter.",
  };
}
