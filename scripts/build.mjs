import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCompilerVersion } from "./compiler-version.mjs";
const project = fileURLToPath(new URL("../", import.meta.url));
const sdkName = fs.existsSync(
  path.join(project, ".local", "toolchain-0.10.18", "bin"),
)
  ? "toolchain-0.10.18"
  : "toolchain";
const local = path.join(
  project,
  ".local",
  sdkName,
  "bin",
  process.platform === "win32" ? "moon.exe" : "moon",
);
export const moon =
  process.env.MOON_BIN ||
  (fs.existsSync(local)
    ? local
    : process.platform === "win32"
      ? "moon.exe"
      : "moon");
export const moonEnv = {
  ...process.env,
  ...(fs.existsSync(local) && !process.env.MOON_BIN
    ? {
        MOON_HOME: path.dirname(path.dirname(local)),
        PATH: path.dirname(local) + path.delimiter + process.env.PATH,
      }
    : {}),
};
export function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: project,
    env: moonEnv,
    stdio: "inherit",
    shell: false,
  });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error("Command failed: " + command + " " + args.join(" "));
}
export function versionCheck() {
  const result = spawnSync(moon, ["version", "--all"], {
    encoding: "utf8",
    env: moonEnv,
  });
  if (result.status !== 0) throw new Error("MoonBit unavailable");
  assertCompilerVersion(result.stdout);
  return result.stdout.trim();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 16))
    throw new Error("Node >= 22.16.0 required (SQLite online backup)");
  versionCheck();
  run(moon, ["update"]);
  run(moon, ["build", "--target", "js", "--release", "--deny-warn"]);
  run(process.execPath, ["scripts/build-fidelity.mjs"]);
  if (process.platform !== "win32") {
    const dir = path.join(project, "_build", "host");
    fs.mkdirSync(dir, { recursive: true });
    run(process.env.CC || "cc", [
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "platform/rename_noreplace.c",
      "-o",
      path.join(dir, "rename_noreplace"),
    ]);
  }
}
