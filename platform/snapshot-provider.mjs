// Provider lifecycle contract. No privileged VSS implementation is installed.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checked, mkdirPrivate, stateHome } from "./vault.mjs";
import { core, drill, options, removeOwned } from "./maintenance.mjs";
import { checkpoint } from "./activity.mjs";
import { vssPreflight } from "./system.mjs";

export async function backupWithSnapshotProvider(repository, source, provider) {
  repository = checked(repository);
  source = checked(source);
  if (
    !provider ||
    typeof provider.create !== "function" ||
    typeof provider.release !== "function" ||
    !["controlled_simulation", "windows_vss"].includes(provider.kind)
  )
    throw new Error("Invalid snapshot provider");
  if (provider.kind === "windows_vss")
    throw new Error(
      "Native VSS requester is not installed or validated; live-copy fallback refused",
    );
  let lease, result, failure;
  try {
    checkpoint("snapshot_provider_create");
    lease = await provider.create(source);
    if (
      !lease ||
      typeof lease.id !== "string" ||
      !lease.id ||
      lease.id.length > 128 ||
      lease.writersReady !== true
    )
      throw new Error("Snapshot writers are not ready; no backup requested");
    const point = checked(lease.path),
      normalize = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
    const a = normalize(source),
      b = normalize(point),
      r = normalize(repository);
    if (
      !fs.statSync(point).isDirectory() ||
      a === b ||
      b.startsWith(a + path.sep) ||
      a.startsWith(b + path.sep) ||
      r === b ||
      r.startsWith(b + path.sep) ||
      b.startsWith(r + path.sep)
    )
      throw new Error(
        "Snapshot mount must be isolated from source and repository",
      );
    const backup = await core([
      "backup",
      repository,
      point,
      "--label",
      "Controlled snapshot-provider rehearsal",
    ]);
    const audit = await core(["audit", repository, backup.snapshot], {
        env: { MOONRESTORE_READ_ONLY: "1" },
      }),
      restored = await drill(repository, backup.snapshot);
    result = {
      ok: audit.ok && restored.ok,
      kind: "snapshot_provider_rehearsal",
      snapshot: backup.snapshot,
      provider: provider.kind,
      application_consistency_verified: false,
      real_vss_verified: false,
      recovery_drill: restored.ok,
      post_restore_readback: restored.post_restore_readback === true,
    };
  } catch (error) {
    failure = error;
  } finally {
    // Cancellation and writer/audit failures must not skip exact lease release.
    if (lease)
      try {
        await provider.release(lease);
      } catch {
        const releaseFailure = new Error(
          "Snapshot lease release failed; inspect the provider-owned resource before retrying",
        );
        if (failure)
          failure = new AggregateError(
            [failure, releaseFailure],
            "Snapshot work and lease release both failed",
          );
        else failure = releaseFailure;
      }
  }
  if (failure) throw failure;
  return { ...result, lease_released: true };
}
export async function vssPlan(source) {
  const readiness = await vssPreflight(checked(source));
  return {
    ok: true,
    kind: "vss_readiness_plan",
    readiness,
    native_requester_available: false,
    shadow_copy_created: false,
    application_consistency_verified: false,
    required_lifecycle: [
      "requester authorization and supported local volume",
      "writer metadata and writer-health check",
      "prepare snapshot set with writers (never nowriters fallback)",
      "create and expose only the owned snapshot",
      "read immutable point, back up, audit and recovery drill",
      "backup-complete notification and exact owned snapshot release",
      "verify release even after cancellation or partial failure",
    ],
    next_action:
      "Use sqlite-backup for SQLite, or explicitly stop/quiesce the application. Live file copy is not application-consistent.",
  };
}
export async function providerRehearsal(repository) {
  // Self-contained synthetic files only. This never pretends to freeze user apps.
  const parent = mkdirPrivate(path.join(stateHome(), "provider-rehearsals")),
    owned = fs.mkdtempSync(path.join(parent, "provider-stage-")),
    source = path.join(owned, "synthetic-source"),
    point = path.join(owned, "synthetic-point");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "example.txt"),
    "Synthetic provider lifecycle rehearsal only.",
  );
  const id = randomUUID();
  let active = false;
  const provider = {
    kind: "controlled_simulation",
    async create() {
      fs.cpSync(source, point, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      active = true;
      return { id, path: point, writersReady: true };
    },
    async release(lease) {
      if (lease.id !== id || lease.path !== point || !active)
        throw new Error("Not an owned lease");
      active = false;
    },
  };
  try {
    return {
      ...(await backupWithSnapshotProvider(repository, source, provider)),
      synthetic_data_only: true,
    };
  } finally {
    removeOwned(owned, parent, "provider-stage-");
  }
}
export async function providerCommand(args) {
  if (!["vss-plan", "provider-rehearsal"].includes(args[0])) return null;
  const { positionals: p } = options(args.slice(1), []);
  if (p.length !== 1) throw new Error("Expected one source/repository path");
  return args[0] === "vss-plan" ? vssPlan(p[0]) : providerRehearsal(p[0]);
}
