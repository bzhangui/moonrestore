import { options } from "./maintenance.mjs";
import { readPrivate } from "./vault.mjs";
import { runEngine } from "./engine-client.mjs";
import { storageCapabilities } from "./storage-capabilities.mjs";
import { bindWalArchive, walHealth } from "./wal-health.mjs";
import { runPlanLoop } from "./plan-runner.mjs";
import { deliverAlert } from "./alert-delivery.mjs";
export async function upgradeCommand(args) {
  const [command, ...rest] = args;
  if (
    ![
      "storage-capabilities",
      "paged-capabilities",
      "paged-replica",
      "paged-rebuild",
      "paged-retirement-preview",
      "paged-retirement-request",
      "paged-retirement-finalize",
      "paged-selected-preview",
      "paged-selected-restore",
      "wal-archive-bind",
      "wal-health",
      "plan-runner",
      "alert-deliver",
      "fidelity-init",
      "paged-restore-create",
      "paged-restore-run",
      "paged-restore-status",
    ].includes(command)
  )
    return null;
  const { positionals: p, values: v } = options(
    rest,
    [
      "confirm",
      "snapshots",
      "plaintext",
      "recover",
      "interval",
      "cycles",
      "selections",
      "partial",
      "cluster",
      "segment-bytes",
      "allow-remote",
      "encrypted",
      "permissions",
      "metadata",
    ],
    [
      "plaintext",
      "recover",
      "partial",
      "allow-remote",
      "encrypted",
      "permissions",
    ],
  );
  if (
    command === "fidelity-init" &&
    p.length === 1 &&
    Object.keys(v).every((k) => k === "encrypted")
  )
    return runEngine("fidelity-init", {
      repository: p[0],
      encrypted: v.encrypted ?? false,
    });
  if (
    command === "paged-restore-create" &&
    p.length === 3 &&
    Object.keys(v).every((k) =>
      ["confirm", "selections", "partial", "permissions", "metadata"].includes(
        k,
      ),
    )
  )
    return runEngine("restore-create", {
      repository: p[0],
      snapshot: p[1],
      target: p[2],
      selections: v.selections
        ? JSON.parse(readPrivate(v.selections, 32768))
        : [],
      partial: v.partial ?? false,
      permissions: v.permissions ?? false,
      ...(v.metadata ? { metadataMode: v.metadata } : {}),
      confirmation: v.confirm,
    });
  if (
    command === "paged-restore-run" &&
    p.length === 2 &&
    Object.keys(v).every((k) => k === "recover")
  )
    return runEngine("restore-run", {
      repository: p[0],
      id: p[1],
      recover: v.recover ?? false,
    });
  if (
    command === "paged-restore-status" &&
    p.length === 2 &&
    !Object.keys(v).length
  )
    return runEngine("restore-status", { repository: p[0], id: p[1] });
  if (
    command === "alert-deliver" &&
    p.length === 2 &&
    Object.keys(v).every((k) => ["confirm", "allow-remote"].includes(k))
  )
    return deliverAlert(p[0], p[1], {
      confirmation: v.confirm,
      allowRemote: v["allow-remote"] ?? false,
    });
  if (
    command === "storage-capabilities" &&
    p.length === 1 &&
    !Object.keys(v).length
  )
    return storageCapabilities(p[0]);
  if (
    command === "paged-capabilities" &&
    p.length === 1 &&
    !Object.keys(v).length
  )
    return runEngine("capabilities", { repository: p[0] });
  if (
    ["paged-replica", "paged-rebuild"].includes(command) &&
    p.length === 2 &&
    Object.keys(v).every((k) => ["snapshots", "plaintext"].includes(k))
  ) {
    if (command === "paged-replica" && v.plaintext)
      throw new Error("Replica never changes encryption");
    return runEngine(command === "paged-replica" ? "replica" : "rebuild", {
      repository: p[0],
      destination: p[1],
      ...(v.snapshots ? { snapshots: v.snapshots.split(",") } : {}),
      ...(command === "paged-rebuild" ? { encrypted: !v.plaintext } : {}),
    });
  }
  if (
    ["paged-retirement-preview", "paged-retirement-request"].includes(
      command,
    ) &&
    p.length === 2 &&
    Object.keys(v).every((k) => k === "confirm")
  )
    return runEngine(
      command === "paged-retirement-preview"
        ? "retirement-preview"
        : "retirement-request",
      {
        repository: p[0],
        config: JSON.parse(readPrivate(p[1], 32768)),
        ...(v.confirm ? { confirmation: v.confirm } : {}),
      },
    );
  if (
    command === "paged-retirement-finalize" &&
    p.length === 2 &&
    Object.keys(v).length === 1 &&
    v.confirm
  )
    return runEngine("retirement-finalize", {
      repository: p[0],
      id: p[1],
      confirmation: v.confirm,
    });
  if (
    ["paged-selected-preview", "paged-selected-restore"].includes(command) &&
    p.length === 3 &&
    Object.keys(v).every((k) =>
      ["confirm", "selections", "partial", "permissions", "metadata"].includes(
        k,
      ),
    )
  )
    return runEngine(
      command === "paged-selected-preview" ? "restore-preview" : "restore",
      {
        repository: p[0],
        snapshot: p[1],
        target: p[2],
        selections: v.selections
          ? JSON.parse(readPrivate(v.selections, 32768))
          : [],
        partial: v.partial ?? false,
        restoreModes: v.permissions ?? false,
        ...(v.metadata ? { metadataMode: v.metadata } : {}),
        ...(v.confirm ? { confirmation: v.confirm } : {}),
      },
      { allowFailure: v.partial === true },
    );
  if (
    command === "wal-archive-bind" &&
    p.length === 1 &&
    Object.keys(v).every((k) =>
      ["confirm", "cluster", "segment-bytes"].includes(k),
    )
  )
    return bindWalArchive(p[0], {
      systemIdentifier: v.cluster,
      segmentBytes: Number(v["segment-bytes"]),
      confirmation: v.confirm,
    });
  if (command === "wal-health" && p.length === 2 && !Object.keys(v).length)
    return walHealth(p[0], JSON.parse(readPrivate(p[1], 32768)));
  if (
    command === "plan-runner" &&
    !p.length &&
    Object.keys(v).every((k) => ["recover", "interval", "cycles"].includes(k))
  )
    return runPlanLoop({
      intervalMs: Number(v.interval ?? 15000),
      cycles: Number(v.cycles ?? 0),
      recover: v.recover ?? false,
    });
  throw new Error("Invalid explicit upgrade command arguments");
}
