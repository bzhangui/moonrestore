import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32")
  throw new Error("Windows desktop build requires Windows");
const root = fileURLToPath(new URL("../", import.meta.url)),
  compiler = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  ),
  output = path.join(root, ".local", "desktop");
if (!fs.existsSync(compiler))
  throw new Error("Windows .NET Framework C# compiler unavailable");
fs.mkdirSync(output, { recursive: true });
const result = spawnSync(
  compiler,
  [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/out:" + path.join(output, "MoonRestore.exe"),
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    "/r:System.Web.Extensions.dll",
    path.join(root, "platform", "windows", "Launcher.cs"),
  ],
  { cwd: root, stdio: "inherit", shell: false },
);
if (result.status !== 0) throw new Error("Native launcher build failed");
console.log("Native Windows launcher built (unsigned).");
