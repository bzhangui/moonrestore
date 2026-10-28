import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url)),
  folder = path.join(root, "_build", "host");
fs.mkdirSync(folder, { recursive: true });
const output = path.join(
  folder,
  process.platform === "win32" ? "fidelity.exe" : "fidelity",
);
const compiler =
  process.platform === "win32"
    ? path.join(
        process.env.SystemRoot ?? "C:/Windows",
        "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
      )
    : (process.env.CC ?? "cc");
const args =
  process.platform === "win32"
    ? [
        "/nologo",
        "/warnaserror+",
        "/optimize+",
        "/target:exe",
        "/out:" + output,
        "/r:System.Web.Extensions.dll",
        "/r:System.Numerics.dll",
        path.join(root, "platform", "windows", "Fidelity.cs"),
      ]
    : [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "platform/fidelity-posix.c",
        "-o",
        output,
      ];
const r = spawnSync(compiler, args, {
  cwd: root,
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});
if (r.status !== 0) throw new Error("Fidelity helper build failed");
console.log(
  "Least-privilege fidelity helper built; no source metadata modified.",
);
