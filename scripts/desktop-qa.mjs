import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { removeOwned, saveReport } from "../platform/maintenance.mjs";
import { vssPreflight, deviceRelation } from "../platform/system.mjs";
if (process.platform !== "win32") throw new Error("Windows-only QA");
const bundle = path.resolve(process.argv[2] || ""),
  exe = path.join(bundle, "MoonRestore.exe"),
  parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-desktop-qa-"));
try {
  for (const command of ["--check", "--install-check", "--host-check"]) {
    const result = spawnSync(exe, [command], {
      cwd: bundle,
      env: {
        ...process.env,
        MOONRESTORE_HOME: path.join(root, "state"),
        PATH: process.env.SystemRoot + "\\System32",
      },
      timeout: 40000,
      shell: false,
      windowsHide: true,
    });
    if (result.status !== 0)
      throw new Error("Native desktop QA failed: " + command);
  }
  const vss = await vssPreflight(root),
    device = await deviceRelation(root, root);
  const report = {
    version: "0.3.0",
    kind: "windows_desktop_qa",
    ok: true,
    embedded_runtime_without_global_node: true,
    install_preflight_only: true,
    native_host_started_and_stopped: true,
    real_tray_menu_interaction_verified: false,
    desktop_shortcut_created: false,
    vss,
    device,
  };
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  removeOwned(root, parent, "moonrestore-desktop-qa-");
}
