// Expensive format4 work stays in a bounded child, leaving HTTP/task cancellation
// responsive. The private parent-control file is checked at engine checkpoints.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { mkdirPrivate, stateHome, writePrivate } from "./vault.mjs";
import { atomicPrivate } from "./journal.mjs";
import { activity, credentials } from "./activity.mjs";
export function runEngine(
  action,
  payload,
  { env = {}, allowFailure = false } = {},
) {
  const context = activity();
  if (context?.signal?.aborted)
    return Promise.reject(new Error("Engine operation cancelled"));
  const body = JSON.stringify({ action, payload });
  if (Buffer.byteLength(body) > 65536)
    return Promise.reject(new Error("Engine input budget"));
  return new Promise((resolve, reject) => {
    const replicaCredentials = payload.destination
      ? credentials(payload.destination)
      : {};
    const folder = mkdirPrivate(path.join(stateHome(), "control")),
      file = path.join(folder, "parent-control-" + randomUUID() + ".json");
    writePrivate(
      file,
      JSON.stringify({ parent_pid: process.pid, cancel: false }),
    );
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../bin/engine-worker.mjs", import.meta.url))],
      {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          ...credentials(payload.repository),
          ...env,
          ...(replicaCredentials.MOONRESTORE_PASSWORD !== undefined
            ? {
                MOONRESTORE_REPLICA_PASSWORD:
                  replicaCredentials.MOONRESTORE_PASSWORD,
              }
            : {}),
          ...(replicaCredentials.MOONRESTORE_KEY_FILE !== undefined
            ? {
                MOONRESTORE_REPLICA_KEY_FILE:
                  replicaCredentials.MOONRESTORE_KEY_FILE,
              }
            : {}),
          MOONRESTORE_PARENT_CONTROL: file,
          MOONRESTORE_HOME: stateHome(),
        },
      },
    );
    let output = "",
      used = 0,
      error = "",
      cancelled = false,
      killTimer,
      finished = false;
    const decoder = new StringDecoder("utf8");
    const cancel = () => {
      if (cancelled || finished) return;
      cancelled = true;
      try {
        atomicPrivate(
          file,
          Buffer.from(
            JSON.stringify({ parent_pid: process.pid, cancel: true }),
          ),
        );
      } catch {
        child.kill();
      }
      killTimer = setTimeout(() => child.kill(), 10000);
    };
    const timer = setTimeout(cancel, context?.budgetMs ?? 1800000);
    context?.signal?.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
    child.stdout.on("data", (b) => {
      used += b.length;
      if (used > 41943040) {
        cancel();
        return;
      }
      output += decoder.write(b);
    });
    child.stderr.on("data", (b) => {
      error += b.toString("utf8");
      let n;
      while ((n = error.indexOf("\n")) >= 0) {
        const line = error.slice(0, n);
        error = error.slice(n + 1);
        if (line.startsWith("MR_PROGRESS:"))
          try {
            context?.progress?.(JSON.parse(line.slice(12)));
          } catch {}
      }
      if (error.length > 65536) error = "";
    });
    let failed;
    child.on("error", () => {
      failed = new Error("Engine worker unavailable");
    });
    child.on("close", (code) => {
      output += decoder.end();
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      context?.signal?.removeEventListener("abort", cancel);
      try {
        fs.unlinkSync(file);
      } catch {}
      if (cancelled)
        return reject(
          new Error("Engine operation cancelled; committed snapshots retained"),
        );
      if (failed) return reject(failed);
      try {
        const r = JSON.parse(output.trim());
        if (code !== 0 && !allowFailure)
          throw new Error(r.error ?? "Engine operation failed");
        resolve(r);
      } catch (e) {
        reject(
          new Error(
            e.message === "Unexpected end of JSON input"
              ? "Engine result unavailable"
              : e.message,
          ),
        );
      }
    });
  });
}
