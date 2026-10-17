#!/usr/bin/env node
import { Host } from "../platform/adapter.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { advanced } from "../platform/maintenance.mjs";
import { retentionCommand } from "../platform/retention.mjs";
import { jobCommand } from "../platform/jobs.mjs";
import { workbenchCommand } from "../platform/workbench.mjs";
import { RecoverySession } from "../platform/recovery-target.mjs";
import { recoveryCommand } from "../platform/recovery.mjs";
import { applicationCommand } from "../platform/applications.mjs";
import { indexCommand } from "../platform/search-index.mjs";
import { remoteCommand } from "../platform/remote.mjs";
import { providerCommand } from "../platform/snapshot-provider.mjs";
if (process.env.MOONRESTORE_INTERNAL !== "1" && process.argv[2] === "--home") {
  if (!process.argv[3])
    throw new Error("--home requires a private state directory");
  process.env.MOONRESTORE_HOME = process.argv[3];
  process.argv.splice(2, 2);
}
if (process.env.MOONRESTORE_INTERNAL !== "1") {
  try {
    const args = process.argv.slice(2);
    const result =
      (await advanced(args)) ??
      (await recoveryCommand(args)) ??
      (await applicationCommand(args)) ??
      (await indexCommand(args)) ??
      (await remoteCommand(args)) ??
      (await providerCommand(args)) ??
      (await retentionCommand(args)) ??
      (await jobCommand(args)) ??
      (await workbenchCommand(args));
    if (result !== null) {
      console.log(JSON.stringify(result));
      if (result.ok === false) process.exitCode = 1;
      process.exit(process.exitCode || 0);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
const host =
  process.env.MOONRESTORE_RECOVERY_TARGET &&
  process.env.MOONRESTORE_INTERNAL === "1"
    ? new RecoverySession({
        repository: process.argv[3],
        target: process.env.MOONRESTORE_RECOVERY_TARGET,
      })
    : new Host();
globalThis.__moonrestore_host = host;
const built = new URL(
  "../_build/js/release/build/cmd/main/main.js",
  import.meta.url,
);
if (!fs.existsSync(fileURLToPath(built))) {
  console.error(
    "MoonRestore 尚未构建。请在项目目录执行：moon build --target js --release",
  );
  process.exitCode = 2;
} else {
  try {
    await import(built.href);
  } catch (e) {
    console.error(`MoonRestore failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try {
      host.clean();
    } catch (e) {
      console.error(`Cleanup failed: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (process.env.MOONRESTORE_PROFILE === "1") {
    const usage = process.resourceUsage();
    console.error(
      JSON.stringify({
        profile: true,
        max_rss_kib: usage.maxRSS,
        user_cpu_us: usage.userCPUTime,
        system_cpu_us: usage.systemCPUTime,
      }),
    );
  }
}
