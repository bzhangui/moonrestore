import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32")
  throw new Error("Windows SDK build requires Windows");
const root = fileURLToPath(new URL("../", import.meta.url)),
  out = path.join(root, ".local", "vss");
fs.mkdirSync(out, { recursive: true });
let env = process.env;
if (!env.VCToolsInstallDir) {
  const where = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const found = spawnSync(
    where,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (found.status !== 0 || !found.stdout.trim())
    throw new Error(
      "Installed Windows SDK/MSVC required; nothing installed automatically",
    );
  const setup = path.join(
    found.stdout.trim(),
    "Common7",
    "Tools",
    "VsDevCmd.bat",
  );
  if (/["\r\n]/.test(setup)) throw new Error("Invalid SDK path");
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", '""' + setup + '" -arch=x64 >nul && set"'],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
  );
  if (result.status !== 0) throw new Error("SDK environment unavailable");
  env = { ...process.env };
  for (const line of result.stdout.split(/\r?\n/)) {
    const n = line.indexOf("=");
    if (n > 0) env[line.slice(0, n)] = line.slice(n + 1);
  }
}
const result = spawnSync(
  "cl.exe",
  [
    "/nologo",
    "/EHsc",
    "/std:c++17",
    "/W4",
    "/WX",
    "/O2",
    "/DUNICODE",
    "/D_UNICODE",
    path.join(root, "platform", "windows", "VssRequester.cpp"),
    "/Fe:" + path.join(out, "MoonRestoreVss.exe"),
    "/Fo:" + path.join(out, "VssRequester.obj"),
  ],
  { cwd: out, env, stdio: "inherit", windowsHide: true, shell: false },
);
if (result.error || result.status !== 0)
  throw new Error("VSS requester build failed");
const probe = spawnSync(path.join(out, "MoonRestoreVss.exe"), ["--protocol"], {
  encoding: "utf8",
  windowsHide: true,
  timeout: 10000,
});
if (probe.status !== 0 || JSON.parse(probe.stdout).protocol !== 1)
  throw new Error("Requester protocol probe failed");
console.log(
  "VSS requester compiled and protocol checked; no snapshot or writer integration verified.",
);
