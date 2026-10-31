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
import {
  operationCommand,
  DurableBackupHost,
  DurableRecoverySession,
} from "../platform/operations.mjs";
import { Journal } from "../platform/journal.mjs";
import { postgresCommand } from "../platform/postgresql.mjs";
import { archiveCommand } from "../platform/archive.mjs";
import { planCommand } from "../platform/plans.mjs";
import { schedulerCommand } from "../platform/plan-scheduler.mjs";
import { attestationCommand } from "../platform/attestation.mjs";
import { protectionCommand } from "../platform/recovery-policy.mjs";
import { rescueKitCommand } from "../platform/rescue-kit.mjs";
import { supportCommand } from "../platform/support.mjs";
import { withParentControl } from "../platform/activity.mjs";
import { readinessCommand } from "../platform/readiness.mjs";
import { stateCommand } from "../platform/state-migration.mjs";
import { remoteAuditCommand } from "../platform/remote-audit.mjs";
import { sqliteRecoveryCommand } from "../platform/sqlite-recovery.mjs";
import { taskControlCommand } from "../platform/os-schedule.mjs";
import { pagedCommand } from "../platform/paged-operations.mjs";
import { pagedMaintenanceCommand } from "../platform/paged-maintenance.mjs";
import { nativeVssCommand } from "../platform/vss-native.mjs";
import { physicalCommand } from "../platform/postgres-physical.mjs";
import { monitorCommand } from "../platform/monitor-receiver.mjs";
import { pagedOperationCommand } from "../platform/paged-journal.mjs";
import { pagedCompat } from "../platform/paged-compat.mjs";
import { upgradeCommand } from "../platform/upgrade-commands.mjs";
import { capabilityCommand } from "../platform/capability-matrix.mjs";
import { applicationContractCommand } from "../platform/application-contract.mjs";
import { receiverCommand } from "../platform/object-receiver.mjs";
import { bundleCommand } from "../platform/bundle-transition.mjs";
if (process.env.MOONRESTORE_INTERNAL !== "1" && process.argv[2] === "--home") {
  if (!process.argv[3])
    throw new Error("--home requires a private state directory");
  process.env.MOONRESTORE_HOME = process.argv[3];
  process.argv.splice(2, 2);
}
if (process.env.MOONRESTORE_INTERNAL !== "1") {
  try {
    const args = process.argv.slice(2);
    const result = await withParentControl(
      async () =>
        capabilityCommand(args) ??
        bundleCommand(args) ??
        (await receiverCommand(args)) ??
        (await applicationContractCommand(args)) ??
        (await upgradeCommand(args)) ??
        (await pagedCompat(args)) ??
        (await operationCommand(args)) ??
        (await readinessCommand(args)) ??
        taskControlCommand(args) ??
        (await pagedCommand(args)) ??
        (await pagedMaintenanceCommand(args)) ??
        (await pagedOperationCommand(args)) ??
        (await nativeVssCommand(args)) ??
        (await physicalCommand(args)) ??
        (await monitorCommand(args)) ??
        (await sqliteRecoveryCommand(args)) ??
        stateCommand(args) ??
        (await remoteAuditCommand(args)) ??
        (await postgresCommand(args)) ??
        (await archiveCommand(args)) ??
        (await planCommand(args)) ??
        (await schedulerCommand(args)) ??
        attestationCommand(args) ??
        (await protectionCommand(args)) ??
        (await rescueKitCommand(args)) ??
        supportCommand(args) ??
        (await advanced(args)) ??
        (await recoveryCommand(args)) ??
        (await applicationCommand(args)) ??
        (await indexCommand(args)) ??
        (await remoteCommand(args)) ??
        (await providerCommand(args)) ??
        (await retentionCommand(args)) ??
        (await jobCommand(args)) ??
        (await workbenchCommand(args)),
    );
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
let durableKind;
if (
  process.env.MOONRESTORE_OPERATION_ID &&
  process.env.MOONRESTORE_INTERNAL === "1"
) {
  const journal = new Journal(
    process.argv[3],
    process.env.MOONRESTORE_OPERATION_ID,
  );
  try {
    durableKind = journal.load().kind;
  } finally {
    journal.close();
  }
}
const host = durableKind
  ? durableKind === "backup"
    ? new DurableBackupHost(
        process.argv[3],
        process.env.MOONRESTORE_OPERATION_ID,
      )
    : new DurableRecoverySession(
        process.argv[3],
        process.env.MOONRESTORE_OPERATION_ID,
      )
  : process.env.MOONRESTORE_RECOVERY_TARGET &&
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
