import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const project = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, ["scripts/package.mjs"], {
  cwd: project,
  env: { ...process.env, MOONRESTORE_BUNDLE_RUNTIME: "1" },
  stdio: "inherit",
  shell: false,
});
process.exitCode = result.status ?? 1;
