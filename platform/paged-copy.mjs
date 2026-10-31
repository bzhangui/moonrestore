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
import { verifyPaged } from "./paged-operations.mjs";
import { publishDirectory } from "./adapter.mjs";
import { removeOwned } from "./maintenance.mjs";
import { checkpoint, credentials } from "./activity.mjs";
import { validateFidelityRoot } from "./fidelity.mjs";
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
  let stage, destinationStore, index;
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
    await PagedStore.create(stage, {
      encrypted,
      fidelity: store.format === 5,
      environment: newEnv,
    });
    destinationStore = await PagedStore.open(stage, { environment: newEnv });
    destinationStore.lock();
    index = new PagedIndex(store);
    const mapping = [];
    for (const snapshot of snapshots) {
      const root = indexSnapshot(store, index, snapshot);
      const copyPage = (pageId) => {
        const raw = store.read("page", pageId);
        destinationStore.write("page", pageId, raw);
        if (!destinationStore.read("page", pageId).equals(raw))
          throw new Error("Rebuild metadata/page bytes changed");
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(raw),
        );
      };
      let next = root.last_page;
      for (let sequence = root.pages - 1; sequence >= 0; sequence--) {
        checkpoint("paged_rebuild_page", { sequence });
        const page = copyPage(next);
        for (const record of page.records)
          if (record.kind === "chunk") {
            if (fs.existsSync(destinationStore.file("pack", record.pack)))
              continue;
            store.pack(record.pack);
            const raw = store.read("pack", record.pack);
            destinationStore.write("pack", record.pack, raw);
            destinationStore.pack(record.pack);
          }
        next = page.previous;
      }
      if (root.fidelity) {
        next = root.fidelity.last_page;
        for (
          let sequence = root.fidelity.pages - 1;
          sequence >= 0;
          sequence--
        ) {
          checkpoint("paged_rebuild_metadata", { sequence });
          next = copyPage(next).previous;
        }
      }
      const raw = Buffer.from(
        JSON.stringify({ ...root, repository: destinationStore.repoId }),
      );
      const snapshotId = destinationStore.logical(raw);
      destinationStore.write("snapshot", snapshotId, raw);
      const audit = new PagedIndex(destinationStore);
      try {
        indexSnapshot(destinationStore, audit, snapshotId);
      } finally {
        audit.close();
      }
      mapping.push({ from: snapshot, to: snapshotId });
    }
    const rotated =
      store.key && destinationStore.key
        ? store.vault.id !== destinationStore.vault.id
        : null;
    destinationStore.close();
    destinationStore = null;
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
      format: store.format,
      logical_pages_preserved: true,
      archived_metadata_bytes_preserved: store.format === 5,
      physical_independence_verified: false,
      plaintext_staging_used: false,
    };
  } catch (e) {
    if (stage) e.staging_retained = true;
    throw e;
  } finally {
    try {
      index?.close();
    } finally {
      try {
        destinationStore?.close();
      } finally {
        store.close();
      }
    }
  }
}

// Two explicit, read-only donors. Publication is always into a new repository;
// neither source is repaired in place and partial materialization is not success.
export async function repairPaged(
  repository,
  donor,
  snapshot,
  destination,
  {
    environment = { ...process.env, ...credentials(repository) },
    donorEnvironment = { ...process.env, ...credentials(donor) },
  } = {},
) {
  if (!/^[a-f0-9]{64}$/.test(snapshot))
    throw new Error("Exact repair snapshot required");
  const sources = [];
  let target, stage, output;
  try {
    sources.push(await PagedStore.open(repository, { environment }));
    sources.push(
      await PagedStore.open(donor, { environment: donorEnvironment }),
    );
    const [a, b] = sources;
    if (
      a.repo === b.repo ||
      a.format !== b.format ||
      a.repoId !== b.repoId ||
      a.vault?.id !== b.vault?.id ||
      a.vault?.check !== b.vault?.check
    )
      throw new Error(
        "Repair donors must have the same repository identity, format and master key",
      );
    target = newDestination(
      repository,
      destination,
      ".moonrestore-paged-repair-",
    );
    stage = target.stage;
    const canonical = (v) =>
      process.platform === "win32"
        ? path.resolve(v).toLowerCase()
        : path.resolve(v);
    if (
      canonical(stage).startsWith(canonical(b.repo) + path.sep) ||
      canonical(target.dest).startsWith(canonical(b.repo) + path.sep) ||
      canonical(b.repo).startsWith(canonical(target.dest) + path.sep) ||
      canonical(target.dest) === canonical(b.repo)
    )
      throw new Error("Repair target overlaps donor");
    layoutFolders(stage);
    const headers = [
      "moonrestore",
      "repository-id",
      ...(a.key ? ["encryption.json"] : []),
    ];
    const pinned = headers.map((relative) =>
      bounded(path.join(a.repo, relative), 4096),
    );
    for (let i = 0; i < headers.length; i++)
      newFile(path.join(stage, headers[i]), pinned[i]);
    output = await PagedStore.open(stage, { environment });
    output.lock();
    let recovered = 0,
      copied = 0;
    const copy = (kind, id) => {
      checkpoint("paged_repair_member", { members: copied });
      if (fs.existsSync(output.file(kind, id))) return output.read(kind, id);
      let raw,
        selected = -1;
      for (let i = 0; i < sources.length; i++)
        try {
          if (kind === "pack") sources[i].pack(id);
          raw = sources[i].read(kind, id);
          selected = i;
          break;
        } catch {}
      if (selected < 0)
        throw new Error("No healthy authorized donor for required " + kind);
      output.write(kind, id, raw);
      if (kind === "pack") output.pack(id);
      else if (!output.read(kind, id).equals(raw))
        throw new Error("Repair readback mismatch");
      if (selected === 1) recovered++;
      copied++;
      return raw;
    };
    copy("snapshot", snapshot);
    const root = output.root(snapshot);
    validateFidelityRoot(root);
    let next = root.last_page;
    for (let i = root.pages - 1; i >= 0; i--) {
      const page = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(copy("page", next)),
      );
      if (
        page.sequence !== i ||
        !Array.isArray(page.records) ||
        page.records.length > 128
      )
        throw new Error("Repair content chain mismatch");
      for (const r of page.records)
        if (r.kind === "chunk") copy("pack", r.pack);
      next = page.previous;
    }
    if (next !== "") throw new Error("Repair content chain incomplete");
    if (root.fidelity) {
      next = root.fidelity.last_page;
      for (let i = root.fidelity.pages - 1; i >= 0; i--) {
        const page = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(copy("page", next)),
        );
        if (
          page.sequence !== i ||
          !Array.isArray(page.records) ||
          page.records.length > 128
        )
          throw new Error("Repair metadata chain mismatch");
        next = page.previous;
      }
      if (next !== "") throw new Error("Repair metadata chain incomplete");
    }
    const audit = new PagedIndex(output);
    try {
      indexSnapshot(output, audit, snapshot);
    } finally {
      audit.close();
    }
    for (const source of sources) {
      if (
        source.repoId !==
        bounded(path.join(source.repo, "repository-id"), 64).toString()
      )
        throw new Error("Donor identity changed");
    }
    for (let i = 0; i < headers.length; i++)
      if (!bounded(path.join(a.repo, headers[i]), 4096).equals(pinned[i]))
        throw new Error("Primary header changed during repair");
    output.close();
    output = null;
    syncDirectory(stage);
    publishDirectory(stage, target.dest);
    stage = null;
    syncDirectory(target.parent);
    return {
      ok: true,
      kind: "paged_two_donor_repair",
      format: a.format,
      snapshot,
      members: copied,
      donor_members: recovered,
      sources_changed: false,
      full_snapshot_audit: true,
      archived_metadata_bytes_preserved: a.format === 5,
      new_repository_only: true,
      physical_independence_verified: false,
    };
  } catch (error) {
    if (stage) error.staging_retained = true;
    throw error;
  } finally {
    try {
      output?.close();
    } finally {
      for (const source of sources) source.close();
    }
  }
}
