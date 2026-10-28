// Supervised current-user worker. No installation, account password or elevated
// service; the administrator may run this entry under a separately authorized host.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  mkdirPrivate,
  stateHome,
  readPrivate,
  writePrivate,
  checked,
} from "./vault.mjs";
import { runDuePlans } from "./plan-scheduler.mjs";
import { activity, checkpoint } from "./activity.mjs";
export async function runPlanLoop({
  intervalMs = 15000,
  cycles = 0,
  recover = false,
  runner = runDuePlans,
  controlledSimulation = false,
} = {}) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1000 ||
    intervalMs > 60000 ||
    !Number.isSafeInteger(cycles) ||
    cycles < 0 ||
    cycles > 10080 ||
    typeof recover !== "boolean" ||
    (runner !== runDuePlans && !controlledSimulation)
  )
    throw new Error("Invalid supervised runner limits");
  const root = mkdirPrivate(path.join(stateHome(), "runner-v1")),
    lock = path.join(root, ".lock"),
    id = randomUUID();
  if (fs.existsSync(lock)) {
    const v = JSON.parse(
      readPrivate(path.join(checked(lock), "owner.json"), 1024),
    );
    if (
      !recover ||
      v.host !== os.hostname() ||
      !Number.isSafeInteger(v.pid) ||
      v.pid < 1
    )
      throw new Error(
        "Runner active/foreign; exact dead-lease recovery required",
      );
    let dead = false;
    try {
      process.kill(v.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") dead = true;
      else throw e;
    }
    if (!dead) throw new Error("Runner owner still active");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  writePrivate(
    path.join(lock, "owner.json"),
    JSON.stringify({ id, pid: process.pid, host: os.hostname() }),
  );
  let ticks = 0,
    failures = 0;
  try {
    while (cycles === 0 || ticks < cycles) {
      checkpoint("supervised_runner", { ticks });
      const r = await runner();
      ticks++;
      if (!r.ok) failures++;
      if (cycles !== 0 && ticks >= cycles) break;
      await delay(intervalMs, undefined, { signal: activity()?.signal });
    }
    return {
      ok: failures === 0,
      ticks,
      failed_ticks: failures,
      supervised_current_user: true,
      os_service_installed: false,
      logout_execution_verified: false,
      production_availability_guaranteed: false,
      controlled_simulation: runner !== runDuePlans,
    };
  } finally {
    const owner = JSON.parse(
      readPrivate(path.join(checked(lock), "owner.json"), 1024),
    );
    if (owner.id !== id || owner.pid !== process.pid)
      throw new Error("Runner ownership changed; cleanup refused");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
}
