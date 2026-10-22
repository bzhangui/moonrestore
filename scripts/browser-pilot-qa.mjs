// Own the pilot's stdin so automation can stop it gracefully after browser QA.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const project = fileURLToPath(new URL("../", import.meta.url));
const pilot = spawn(process.execPath, ["scripts/ui-pilot.mjs", "0"], {
  cwd: project,
  env: process.env,
  windowsHide: true,
  shell: false,
  stdio: ["pipe", "pipe", "inherit"],
});
pilot.stdin.on("error", () => {});
let buffer = "",
  session,
  finished = false;
const exited = new Promise((resolve) =>
  pilot.once("close", (code) => {
    finished = true;
    resolve(code);
  }),
);
try {
  session = await new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error("Owned UI fixture startup timeout")),
      30000,
    );
    pilot.once("error", reject);
    pilot.once("exit", () =>
      reject(new Error("Owned UI fixture stopped before ready")),
    );
    pilot.stdout.on("data", (b) => {
      buffer += b;
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const r = JSON.parse(line);
          if (
            r.controlled_browser_pilot === true &&
            typeof r.session_file === "string"
          ) {
            clearTimeout(deadline);
            resolve(r.session_file);
          }
        } catch {}
      }
    });
  });
  if (
    !path.resolve(session).startsWith(path.join(project, ".local", "ui-pilot-"))
  )
    throw new Error("Unexpected fixture path");
  const qa = spawn(process.execPath, ["scripts/browser-qa.mjs", session], {
    cwd: project,
    env: process.env,
    windowsHide: true,
    shell: false,
    stdio: "inherit",
  });
  const status = await new Promise((resolve, reject) => {
    qa.once("error", reject);
    qa.once("close", resolve);
  });
  if (status !== 0) throw new Error("Actual browser QA failed");
} finally {
  if (!finished) pilot.stdin.end("stop\n");
  const timeout = Symbol("timeout"),
    timer = {};
  const result = await Promise.race([
    exited,
    new Promise((resolve) => {
      timer.id = setTimeout(() => resolve(timeout), 10000);
    }),
  ]);
  clearTimeout(timer.id);
  if (result === timeout)
    throw new Error(
      "Owned UI fixture stop not confirmed; inspect this exact pilot before deleting its files",
    );
  if (result !== 0) throw new Error("Owned UI fixture did not stop cleanly");
}
