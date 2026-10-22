import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { moon, moonEnv, versionCheck } from "./build.mjs";
const project = fileURLToPath(new URL("../", import.meta.url));
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: project,
    env: moonEnv,
    stdio: "inherit",
    shell: false,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 16))
  throw new Error("Node >= 22.16.0 required (SQLite online backup)");
console.log(versionCheck());
run(moon, ["update"]);
run(moon, ["fmt", "--check"]);
for (const target of ["js", "wasm", "wasm-gc", "native"]) {
  run(moon, ["check", "--target", target, "--deny-warn"]);
  run(moon, ["build", "--target", target, "--release", "--deny-warn"]);
  run(moon, ["test", "--target", target, "--deny-warn"]);
  run(moon, ["run", "examples/core", "--target", target]);
}
run(process.execPath, ["scripts/build.mjs"]);
run(process.execPath, [
  "--test",
  "--test-concurrency=4",
  ...(await import("node:fs"))
    .readdirSync(new URL("../tests/", import.meta.url))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => "tests/" + name),
]);
run(process.execPath, ["examples/scenarios.mjs"]);
run(moon, ["coverage", "clean"]);
run(moon, ["test", "--target", "js", "--enable-coverage", "--deny-warn"]);
run(moon, [
  "coverage",
  "report",
  "-p",
  "bzhangui/moonrestore/core",
  "-f",
  "summary",
]);
run(process.execPath, ["scripts/check-package.mjs"]);
run(process.execPath, ["scripts/audit-public.mjs"]);
console.log(
  "All local maintenance checks passed. Remote CI/publication/real hardware durability are separate evidence.",
);
