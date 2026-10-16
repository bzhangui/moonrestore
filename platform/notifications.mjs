// Opt-in, local-only reminders. No mail, webhooks, filenames or remote telemetry.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  readPrivate,
  writePrivate,
  mkdirPrivate,
  stateHome,
} from "./vault.mjs";
import { randomUUID } from "node:crypto";
export function notices() {
  const file = path.join(stateHome(), "notices.json");
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(readPrivate(file, 262144));
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Invalid notices");
  return value;
}
export function notify(job, code, { desktop = false } = {}) {
  const file = path.join(mkdirPrivate(stateHome()), "notices.json"),
    history = notices(),
    now = Date.now();
  if (
    history.some(
      (n) =>
        n.job === job && n.code === code && now - Date.parse(n.time) < 3600000,
    )
  )
    return { recorded: false, deduplicated: true };
  const entry = {
    id: randomUUID(),
    job,
    code,
    time: new Date(now).toISOString(),
    message:
      code === "success"
        ? "备份及配置的校验/副本步骤完成。"
        : code === "device_unavailable"
          ? "备份设备离线；检查连接后重试。"
          : "备份任务未完成；请打开工作台查看。",
  };
  const temporary = path.join(stateHome(), randomUUID() + ".notice");
  writePrivate(temporary, JSON.stringify([entry, ...history].slice(0, 100)));
  fs.renameSync(temporary, file);
  if (desktop && process.platform === "win32") {
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $v=[Console]::In.ReadToEnd()|ConvertFrom-Json; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[Drawing.SystemIcons]::Information; $n.Visible=$true; $n.ShowBalloonTip(2500,'MoonRestore',$v.message,[Windows.Forms.ToolTipIcon]::Info); Start-Sleep -Seconds 3; $n.Dispose()";
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"], shell: false },
    );
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ message: entry.message }));
    child.unref();
  }
  return {
    recorded: true,
    desktop_requested: desktop,
    desktop_delivery_confirmed: false,
  };
}
