import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const project = fileURLToPath(new URL("../", import.meta.url));
const local = path.join(
  project,
  ".local",
  "toolchain",
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
  const match = result.stdout.match(/moonc v(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error("Unknown MoonBit version");
  const version = match.slice(1).map(Number),
    minimum = [0, 10, 15];
  let comparison = 0;
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) {
      comparison = version[i] > minimum[i] ? 1 : -1;
      break;
    }
  }
  if (comparison < 0)
    throw new Error(
      "MoonRestore requires moonc >= 0.10.15; install a compatible SDK or set MOON_BIN/MOON_HOME",
    );
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
