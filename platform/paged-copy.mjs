// Versioned physical-member adapter. No transparent locator rewrite of v4 roots.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { checked, readPrivate } from "./vault.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  bounded,
  newFile,
  syncDirectory,
} from "./paged-store.mjs";
import { backupPaged, verifyPaged, restorePaged } from "./paged-operations.mjs";
import { publishDirectory } from "./adapter.mjs";
import { removeOwned } from "./maintenance.mjs";
import { checkpoint, credentials } from "./activity.mjs";
export const pagedLayout = {
  version: 1,
  format: 4,
  locator: "immutable_pack_sha256_plus_offset",
  mutable_locator_supported: false,
};
export function* physicalMembers(store, index, snapshots) {
  if (
    !Array.isArray(snapshots) ||
    !snapshots.length ||
    snapshots.length > 1000 ||
    new Set(snapshots).size !== snapshots.length
  )
    throw new Error("Select 1..1000 distinct snapshots");
  for (const snapshot of snapshots) indexSnapshot(store, index, snapshot);
  yield "moonrestore";
  yield "repository-id";
  if (store.key) yield "encryption.json";
  for (const row of index.db
    .prepare("SELECT k FROM live ORDER BY k")
    .iterate()) {
    const [kind, physical] = row.k.split(":");
    if (!["pack", "page"].includes(kind) || !/^[a-f0-9]{64}$/.test(physical))
      throw new Error("Physical layout rejected");
    yield (kind === "pack" ? "packs/" : "pages/") + physical;
  }
  for (const id of snapshots)
    yield "snapshots/" + path.basename(store.file("snapshot", id));
}
export function newDestination(
  repository,
  destination,
  prefix = ".moonrestore-paged-copy-",
) {
  const source = checked(repository),
    dest = checked(destination, false),
    parent = checked(path.dirname(dest)),
    normalize = (v) => (process.platform === "win32" ? v.toLowerCase() : v);
  const a = normalize(source),
    b = normalize(dest);
  if (
    fs.existsSync(dest) ||
    a === b ||
    a.startsWith(b + path.sep) ||
    b.startsWith(a + path.sep)
  )
    throw new Error("NEW non-overlapping repository required");
  return { dest, parent, stage: fs.mkdtempSync(path.join(parent, prefix)) };
}
export function layoutFolders(stage) {
  for (const folder of ["pages", "packs", "snapshots", "tmp", "trash"])
    fs.mkdirSync(path.join(stage, folder), { mode: 0o700 });
}
export async function copyPaged(
  repository,
  destination,
  {
    snapshots,
    environment = { ...process.env, ...credentials(repository) },
  } = {},
) {
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store);
  let stage,
    destinationStore,
    copyEnvironment = environment;
  try {
    store.lock();
    if (snapshots === undefined) {
      snapshots = [];
      for (const id of store.snapshots()) {
        if (snapshots.length >= 1000)
          throw new Error("Select at most 1000 snapshots");
        snapshots.push(id);
      }
    }
    let target;
    const existing = fs.existsSync(checked(destination, false));
    if (existing) {
      const normalize = (v) =>
          process.platform === "win32"
            ? path.resolve(v).toLowerCase()
            : path.resolve(v),
        a = normalize(store.repo),
        b = normalize(destination);
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
        throw new Error("Overlapping replica refused");
      copyEnvironment = {
        ...environment,
        MOONRESTORE_PASSWORD:
          process.env.MOONRESTORE_REPLICA_PASSWORD ??
          environment.MOONRESTORE_PASSWORD,
        MOONRESTORE_KEY_FILE:
          process.env.MOONRESTORE_REPLICA_KEY_FILE ??
          environment.MOONRESTORE_KEY_FILE,
      };
      destinationStore = await PagedStore.open(destination, {
        environment: copyEnvironment,
      });
      destinationStore.lock();
      if (
        destinationStore.repoId !== store.repoId ||
        destinationStore.vault?.id !== store.vault?.id ||
        destinationStore.vault?.check !== store.vault?.check
      )
        throw new Error(
          "Replica repository identity/key mismatch; no overwrite",
        );
      for (const id of destinationStore.snapshots()) {
        const audit = new PagedIndex(destinationStore);
        try {
          indexSnapshot(destinationStore, audit, id);
        } finally {
          audit.close();
        }
      }
      target = {
        dest: destinationStore.repo,
        parent: path.dirname(destinationStore.repo),
      };
      stage = destinationStore.repo;
    } else {
      target = newDestination(repository, destination);
      stage = target.stage;
      layoutFolders(stage);
    }
    let members = 0,
      bytes = 0;
    for (const relative of physicalMembers(store, index, snapshots)) {
      checkpoint("paged_replica", { members });
      const raw = bounded(path.join(store.repo, relative), 8388704);
      const final = path.join(stage, relative);
      if (existing && relative === "encryption.json") continue; // Preserve an independently rewrapped clone password.
      if (fs.existsSync(final)) {
        if (store.logical(bounded(final, 8388704)) !== store.logical(raw))
          throw new Error(
            "Immutable replica conflict; damaged data not overwritten",
          );
      } else if (existing) {
        const temporary = path.join(
          stage,
          "tmp",
          "replica-" + randomUUID() + ".part",
        );
        newFile(temporary, raw);
        fs.linkSync(temporary, final);
        fs.unlinkSync(temporary);
        syncDirectory(path.dirname(final));
      } else newFile(final, raw);
      if (
        store.logical(bounded(path.join(stage, relative), 8388704)) !==
        store.logical(raw)
      )
        throw new Error("Replica readback mismatch");
      members++;
      bytes += raw.length;
    }
    for (const snapshot of snapshots)
      await verifyPaged(stage, snapshot, { environment: copyEnvironment });
    syncDirectory(stage);
    if (!existing) publishDirectory(stage, target.dest);
    stage = null;
    syncDirectory(target.parent);
    return {
      ok: true,
      kind: "paged_replica",
      members,
      bytes: String(bytes),
      snapshots: snapshots.length,
      full_snapshot_audit: true,
      physical_independence_verified: false,
      deletions_propagated: false,
      append_only_existing_replica: existing,
    };
  } catch (e) {
    if (stage && !destinationStore) e.staging_retained = true;
    throw e;
  } finally {
    index.close();
    destinationStore?.close();
    store.close();
  }
}
export async function rebuildPaged(
  repository,
  destination,
  {
    snapshots,
    encrypted = true,
    destinationPassword,
    environment = { ...process.env, ...credentials(repository) },
  } = {},
) {
  if (
    typeof encrypted !== "boolean" ||
    (encrypted && typeof destinationPassword !== "string")
  )
    throw new Error("Explicit new encryption password required");
  const store = await PagedStore.open(repository, { environment });
  let stage, temporary;
  try {
    store.lock();
    if (store.format === 5)
      throw new Error(
        "Fidelity rebuild/rekey requires a byte-preserving metadata rewrite; use verified paged-replica. Filesystem round-trip rebuild would change recorded metadata.",
      );
    if (snapshots === undefined) {
      snapshots = [];
      for (const id of store.snapshots()) {
        if (snapshots.length >= 1000)
          throw new Error("Select at most 1000 snapshots");
        snapshots.push(id);
      }
    }
    if (
      !snapshots.length ||
      snapshots.length > 1000 ||
      new Set(snapshots).size !== snapshots.length
    )
      throw new Error("Select 1..1000 distinct snapshots");
    const target = newDestination(
      repository,
      destination,
      ".moonrestore-paged-rebuild-",
    );
    stage = target.stage;
    fs.rmdirSync(stage); // create() exclusively publishes into this exact unused sibling.
    const newEnv = {
      ...environment,
      MOONRESTORE_PASSWORD: destinationPassword ?? "",
      MOONRESTORE_KEY_FILE: "",
    };
    await PagedStore.create(stage, { encrypted, environment: newEnv });
    temporary = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "moonrestore-rebuild-data-"),
    );
    const mapping = [];
    for (const snapshot of snapshots) {
      const root = store.root(snapshot),
        plain = path.join(temporary, "restore-" + mapping.length);
      await restorePaged(repository, snapshot, plain, {
        environment,
        permissions: true,
      });
      const result = await backupPaged(stage, plain, {
        label: root.label,
        environment: newEnv,
        startedAt: root.created,
      });
      await verifyPaged(stage, result.snapshot, { environment: newEnv });
      mapping.push({ from: snapshot, to: result.snapshot });
      removeOwned(plain, temporary, "restore-");
    }
    const destinationStore = await PagedStore.open(stage, {
      environment: newEnv,
    });
    let rotated;
    try {
      rotated =
        store.key && destinationStore.key
          ? store.vault.id !== destinationStore.vault.id
          : null;
    } finally {
      destinationStore.close();
    }
    syncDirectory(stage);
    publishDirectory(stage, target.dest);
    stage = null;
    syncDirectory(target.parent);
    return {
      ok: true,
      kind: "verified_rebuild",
      mapping,
      old_repository_unchanged: true,
      new_master_key: rotated,
      old_copies_revoked: false,
      format: 4,
      physical_independence_verified: false,
      plaintext_staging_used: true,
    };
  } catch (e) {
    if (stage) e.staging_retained = true;
    throw e;
  } finally {
    if (temporary)
      removeOwned(
        temporary,
        fs.realpathSync(os.tmpdir()),
        "moonrestore-rebuild-data-",
      );
    store.close();
  }
}
