// Shared CLI / GUI / plan engine. Commands remain explicit and format aware.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { checked, writePrivate, rewrapVault, rememberKey } from "./vault.mjs";
import { atomicPrivate } from "./journal.mjs";
import { PagedStore, PagedIndex, indexSnapshot } from "./paged-store.mjs";
import { backupPaged, verifyPaged, restorePaged } from "./paged-operations.mjs";
import {
  createPagedOperation,
  runPagedOperation,
  pagedOperationStatus,
  sourceInventory,
} from "./paged-journal.mjs";
import { pagedBinding } from "./paged-cache.mjs";
import {
  pagedRecords,
  previewPagedRestore,
  restorePagedSelection,
  catalogPaged,
} from "./paged-selection.mjs";
import { removeOwned, saveReport } from "./maintenance.mjs";
import { checkpoint } from "./activity.mjs";
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("Unknown engine fields");
}
function flag(v) {
  if (v !== undefined && typeof v !== "boolean")
    throw new Error("Strict boolean required");
  return v === true;
}
async function inventory(repository) {
  const store = await PagedStore.open(repository);
  try {
    const snapshots = [];
    let damaged = 0,
      count = 0;
    for (const candidate of store.snapshotCandidates()) {
      if (++count > 100000)
        throw new Error("Use paginated history: inventory output budget");
      if (candidate.damaged) {
        damaged++;
        continue;
      }
      try {
        const id = candidate.id,
          r = store.root(id);
        snapshots.push({
          id,
          created: r.created,
          label: r.label,
          entries: r.entries,
          bytes: r.bytes,
        });
      } catch {
        damaged++;
      }
    }
    return {
      ok: damaged === 0,
      format: store.format ?? 4,
      snapshots,
      damaged_roots: damaged,
      content_verified: false,
    };
  } finally {
    store.close();
  }
}
async function textPreview(repository, snapshot, relative) {
  if (
    typeof relative !== "string" ||
    !/\.(txt|md|csv|json|ya?ml|toml|log|mbt|js|ts|py|c|h|html|css|svg)$/i.test(
      relative,
    )
  )
    throw new Error("Only small text files can be previewed");
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  try {
    store.core("path", { session: relative });
    const root = indexSnapshot(store, index, snapshot, {
      verifyContents: false,
      verifyObjects: false,
    });
    let active = false,
      meta,
      parts = [],
      bytes = 0;
    for (const r of pagedRecords(store, index, root)) {
      if (r.kind === "file") {
        active = r.path === relative;
        if (active) {
          meta = r;
          if (BigInt(r.size) > 131072n)
            throw new Error("Text preview size budget");
        }
      } else if (r.kind === "chunk" && active) {
        const b = store.chunk(r);
        bytes += b.length;
        if (bytes > 131072) throw new Error("Text preview size budget");
        parts.push(b);
      } else if (r.kind === "end" && active) {
        const data = Buffer.concat(parts);
        if (
          bytes !== Number(meta.size) ||
          store.logical(data) !== r.id ||
          data.includes(0)
        )
          throw new Error("Text preview integrity failed");
        return {
          ok: true,
          text: new TextDecoder("utf-8", { fatal: true }).decode(data),
          scope: "selected_file_only",
          executable: false,
        };
      }
    }
    throw new Error("Selected text file not found");
  } finally {
    index.close();
    store.close();
  }
}
async function compare(repository, before, after) {
  const store = await PagedStore.open(repository),
    a = new PagedIndex(store),
    b = new PagedIndex(store);
  try {
    a.db.exec(
      "CREATE TABLE entries(k TEXT PRIMARY KEY,payload BLOB NOT NULL);",
    );
    const first = indexSnapshot(store, a, before, {
      verifyContents: false,
      verifyObjects: false,
    });
    let current;
    for (const r of pagedRecords(store, a, first)) {
      if (r.kind === "file") current = r;
      else if (r.kind === "dir" || r.kind === "end") {
        const p = r.kind === "dir" ? r.path : current.path,
          k = a.key("compare", p);
        a.db.prepare("INSERT INTO entries VALUES(?,?)").run(
          k,
          a.encode("compare", k, {
            path: p,
            kind: r.kind === "dir" ? "dir" : "file",
            hash: r.id,
            size: r.kind === "dir" ? "0" : current.size,
          }),
        );
      }
    }
    const second = indexSnapshot(store, b, after, {
        verifyContents: false,
        verifyObjects: false,
      }),
      changes = [];
    let added = 0,
      removed = 0,
      modified = 0;
    for (const r of pagedRecords(store, b, second)) {
      if (r.kind === "file") current = r;
      else if (r.kind === "dir" || r.kind === "end") {
        const p = r.kind === "dir" ? r.path : current.path,
          k = a.key("compare", p),
          row = a.db.prepare("SELECT payload FROM entries WHERE k=?").get(k),
          v = {
            path: p,
            kind: r.kind === "dir" ? "dir" : "file",
            hash: r.id,
            size: r.kind === "dir" ? "0" : current.size,
          };
        let change;
        if (!row) {
          added++;
          change = "added";
        } else {
          const old = a.decode("compare", k, row.payload);
          if (
            old.hash !== v.hash ||
            old.kind !== v.kind ||
            old.size !== v.size
          ) {
            modified++;
            change = "modified";
          }
          a.db.prepare("DELETE FROM entries WHERE k=?").run(k);
        }
        if (change && changes.length < 100) changes.push({ path: p, change });
      }
    }
    for (const row of a.db.prepare("SELECT k,payload FROM entries").iterate()) {
      removed++;
      if (changes.length < 100)
        changes.push({
          path: a.decode("compare", row.k, row.payload).path,
          change: "removed",
        });
    }
    return {
      ok: true,
      before,
      after,
      added,
      removed,
      modified,
      changes,
      truncated: added + removed + modified > changes.length,
      content_verified: false,
    };
  } finally {
    a.close();
    b.close();
    store.close();
  }
}
async function history(
  repository,
  { offset = 0, query = "", from = "", to = "" } = {},
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    typeof query !== "string" ||
    query.length > 200
  )
    throw new Error("Invalid history filters");
  const date = (v) => {
    if (!v) return null;
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d\d-\d\d$/.test(v) ||
      !Number.isFinite(Date.parse(v + "T00:00:00Z")) ||
      new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v
    )
      throw new Error("Invalid history date");
    return Date.parse(v + "T00:00:00Z");
  };
  const start = date(from),
    end = date(to);
  if (start !== null && end !== null && start > end)
    throw new Error("Reversed dates");
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  try {
    index.db.exec(
      "CREATE TABLE roots(id TEXT PRIMARY KEY,created TEXT,payload BLOB NOT NULL);",
    );
    let damaged = 0,
      count = 0;
    for (const candidate of store.snapshotCandidates()) {
      if (++count > 1000000) throw new Error("Snapshot inventory budget");
      if (candidate.damaged) {
        damaged++;
        continue;
      }
      try {
        const id = candidate.id,
          root = store.root(id),
          key = index.key("history", id);
        index.db
          .prepare("INSERT INTO roots VALUES(?,?,?)")
          .run(id, root.created, index.encode("history", key, root));
      } catch {
        damaged++;
      }
    }
    let total = 0;
    const snapshots = [];
    for (const row of index.db
      .prepare("SELECT * FROM roots ORDER BY created DESC,id")
      .iterate()) {
      const r = index.decode(
        "history",
        index.key("history", row.id),
        row.payload,
      );
      if (
        query &&
        !r.label.toLowerCase().includes(query.toLowerCase()) &&
        !row.id.includes(query)
      )
        continue;
      if (
        (start !== null && Date.parse(r.created) < start) ||
        (end !== null && Date.parse(r.created) >= end + 86400000)
      )
        continue;
      if (total >= offset && snapshots.length < 100)
        snapshots.push({
          id: row.id,
          created: r.created,
          label: r.label,
          entries: r.entries,
          bytes: r.bytes,
          format: store.format ?? 4,
          metadata_verified: true,
          content_verified: false,
        });
      total++;
    }
    return {
      ok: damaged === 0,
      format: store.format ?? 4,
      total,
      offset,
      snapshots,
      more: offset + snapshots.length < total,
      damaged_roots: damaged,
    };
  } finally {
    index.close();
    store.close();
  }
}
async function plan(repository, source, excludes = []) {
  const store = await PagedStore.open(repository);
  try {
    const r = sourceInventory(store, source, excludes);
    return {
      ok: true,
      entries: r.entries,
      files: r.files,
      logical_bytes: r.logical_bytes,
      inventory: r.digest,
      format: store.format ?? 4,
    };
  } finally {
    store.close();
  }
}
async function drill(repository, snapshot, { prefix = "" } = {}) {
  const parent = fs.realpathSync(os.tmpdir()),
    owned = fs.mkdtempSync(path.join(parent, "moonrestore-paged-drill-")),
    target = path.join(owned, "restored");
  let result;
  try {
    const prefixes = prefix ? [prefix] : [],
      preview = await previewPagedRestore(repository, snapshot, target, {
        prefixes,
        metadataMode: "portable",
      });
    result = await restorePagedSelection(repository, snapshot, target, {
      prefixes,
      metadataMode: "portable",
      confirmation: preview.confirmation,
    });
    return {
      ...result,
      kind: "restore_drill",
      real_user_pilot: false,
      temporary_cleanup: true,
    };
  } finally {
    removeOwned(owned, parent, "moonrestore-paged-drill-");
  }
}
async function key(repository, action, p) {
  const store = await PagedStore.open(repository);
  try {
    if (!store.key) throw new Error("Encrypted repository required");
    if (action === "unlock") {
      if (p.remember) rememberKey(store.vault, store.key);
      return { ok: true, unlocked: true, persisted_password: false };
    }
    if (action === "key-export") {
      const output = checked(p.output, false),
        canonical = (v) => (process.platform === "win32" ? v.toLowerCase() : v),
        a = canonical(output),
        b = canonical(store.repo);
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
        throw new Error("Recovery key must be separate from repository");
      let ancestor = path.dirname(output);
      while (path.dirname(ancestor) !== ancestor) {
        if (
          fs.existsSync(path.join(ancestor, ".git")) &&
          !a.startsWith(canonical(path.join(ancestor, ".local")) + path.sep)
        )
          throw new Error(
            "Private recovery key must not enter public source tree",
          );
        ancestor = path.dirname(ancestor);
      }
      writePrivate(
        output,
        JSON.stringify({
          format: 1,
          repository: store.vault.id,
          key: store.key.toString("hex"),
        }),
      );
      return {
        ok: true,
        recovery_key_exported: true,
        output: p.output,
        keep_separate: true,
      };
    }
    if (action === "password-change") {
      store.lock();
      atomicPrivate(
        path.join(store.repo, "encryption.json"),
        Buffer.from(
          JSON.stringify(rewrapVault(store.vault, store.key, p.newPassword)),
        ),
      );
      return { ok: true, password_rewrapped: true, master_key_rotated: false };
    }
  } finally {
    store.close();
  }
}
export async function engineAction(action, p) {
  switch (action) {
    case "fidelity-init":
      fields(p, ["repository", "encrypted"]);
      return PagedStore.create(p.repository, {
        encrypted: flag(p.encrypted),
        fidelity: true,
      });
    case "restore-create":
      fields(p, [
        "repository",
        "snapshot",
        "target",
        "selections",
        "partial",
        "permissions",
        "metadataMode",
        "confirmation",
      ]);
      return import("./paged-restore.mjs").then((m) =>
        m.createPagedRestore(p.repository, p.snapshot, p.target, {
          prefixes: p.selections ?? [],
          partial: flag(p.partial),
          permissions: flag(p.permissions),
          metadataMode: p.metadataMode,
          confirmation: p.confirmation,
        }),
      );
    case "restore-run":
      fields(p, ["repository", "id", "recover"]);
      return import("./paged-restore.mjs").then((m) =>
        m.runPagedRestore(p.repository, p.id, { recover: flag(p.recover) }),
      );
    case "restore-status":
      fields(p, ["repository", "id"]);
      return import("./paged-restore.mjs").then((m) =>
        m.pagedRestoreStatus(p.repository, p.id),
      );
    case "scrub":
    case "scrub-status":
      fields(p, [
        "repository",
        "snapshot",
        "maxFiles",
        "maxBytes",
        "maxAgeHours",
      ]);
      return import("./paged-scrub.mjs").then((m) =>
        m.scrubPaged(p.repository, {
          snapshot: p.snapshot,
          maxFiles: p.maxFiles ?? 100,
          maxBytes: p.maxBytes ?? "268435456",
          maxAgeHours: p.maxAgeHours ?? 24,
          statusOnly: action === "scrub-status",
        }),
      );
    case "capabilities":
      fields(p, ["repository"]);
      {
        const store = await PagedStore.open(p.repository);
        try {
          return {
            ok: true,
            protocol: 1,
            format: store.format ?? 4,
            selected_restore: true,
            resumable_restore: "verified_owned_prefix",
            fidelity_format: store.format === 5,
            partial_rescue: true,
            resumable_backup: "rescan_verified_reuse",
            encrypted: !!store.key,
            maximum_files: 1000000,
            maximum_snapshot_bytes: "1099511627776",
            maximum_file_bytes: "68719476736",
            budgets_not_scale_certification: true,
            metadata_profile:
              store.format === 5
                ? [
                    "file_bytes",
                    "relative_paths",
                    "nanosecond_times",
                    "protected_effective_windows_acl_or_posix_xattr",
                    "ads_on_windows",
                    "sparse_ranges",
                    "selected_internal_hardlinks",
                  ]
                : [
                    "file_bytes",
                    "relative_paths",
                    "mtime",
                    "optional_posix_modes",
                  ],
            not_preserved:
              store.format === 5
                ? [
                    "ctime",
                    "posix_birthtime_restore",
                    "all_filesystem_metadata",
                    "bit_identical_physical_layout",
                    "windows_acl_inheritance_topology",
                  ]
                : [
                    "ACL",
                    "ADS",
                    "xattr",
                    "sparse_extents",
                    "hardlink_relationships",
                  ],
            physical_power_loss_verified: false,
          };
        } finally {
          store.close();
        }
      }
    case "replica":
      fields(p, ["repository", "destination", "snapshots"]);
      return import("./paged-copy.mjs").then((m) =>
        m.copyPaged(p.repository, p.destination, { snapshots: p.snapshots }),
      );
    case "rebuild":
      fields(p, ["repository", "destination", "snapshots", "encrypted"]);
      return import("./paged-copy.mjs").then((m) =>
        m.rebuildPaged(p.repository, p.destination, {
          snapshots: p.snapshots,
          encrypted: flag(p.encrypted ?? true),
          destinationPassword: process.env.MOONRESTORE_DEST_PASSWORD,
        }),
      );
    case "retirement-preview":
      fields(p, ["repository", "config"]);
      return import("./paged-retention.mjs").then((m) =>
        m.retirementPreview(p.repository, p.config),
      );
    case "retirement-request":
      fields(p, ["repository", "config", "confirmation"]);
      return import("./paged-retention.mjs").then((m) =>
        m.requestRetirement(p.repository, p.config, p.confirmation),
      );
    case "retirement-finalize":
      fields(p, ["repository", "id", "confirmation"]);
      return import("./paged-retention.mjs").then((m) =>
        m.finalizeRetirement(p.repository, p.id, p.confirmation),
      );
    case "init":
      fields(p, ["repository", "encrypted"]);
      return PagedStore.create(p.repository, { encrypted: flag(p.encrypted) });
    case "backup":
      fields(p, [
        "repository",
        "source",
        "label",
        "excludes",
        "operation",
        "recover",
      ]);
      {
        const op =
          p.operation ??
          (
            await createPagedOperation(p.repository, p.source, {
              label: p.label ?? "",
              excludes: p.excludes ?? [],
            })
          ).operation;
        return runPagedOperation(p.repository, op, {
          recover: flag(p.recover),
        });
      }
    case "operation-create":
      fields(p, ["repository", "source", "label", "excludes"]);
      return createPagedOperation(p.repository, p.source, {
        label: p.label ?? "",
        excludes: p.excludes ?? [],
      });
    case "operation-run":
      fields(p, ["repository", "id", "recover"]);
      return runPagedOperation(p.repository, p.id, {
        recover: flag(p.recover),
      });
    case "operation-status":
      fields(p, ["repository", "id"]);
      return pagedOperationStatus(p.repository, p.id);
    case "plan":
      fields(p, ["repository", "source", "excludes"]);
      return plan(p.repository, p.source, p.excludes ?? []);
    case "history":
      fields(p, ["repository", "offset", "query", "from", "to"]);
      return history(p.repository, p);
    case "inventory":
      fields(p, ["repository"]);
      return inventory(p.repository);
    case "measure":
      fields(p, ["repository", "snapshot"]);
      {
        const store = await PagedStore.open(p.repository);
        try {
          const root = store.root(p.snapshot);
          return {
            ok: true,
            logical_bytes: root.bytes,
            entries: root.entries,
            content_verified: false,
          };
        } finally {
          store.close();
        }
      }
    case "catalog":
      fields(p, ["repository", "snapshot", "offset", "query"]);
      return catalogPaged(p.repository, p.snapshot, p);
    case "text-preview":
      fields(p, ["repository", "snapshot", "path"]);
      return textPreview(p.repository, p.snapshot, p.path);
    case "compare":
      fields(p, ["repository", "before", "after"]);
      return compare(p.repository, p.before, p.after);
    case "verify":
      fields(p, ["repository", "snapshot"]);
      if (p.snapshot === "all") {
        let count = 0,
          failed = 0;
        const store = await PagedStore.open(p.repository);
        try {
          for (const candidate of store.snapshotCandidates()) {
            checkpoint("paged_full_audit");
            if (candidate.damaged) {
              failed++;
              continue;
            }
            const id = candidate.id;
            try {
              await verifyPaged(p.repository, id);
              count++;
            } catch {
              failed++;
            }
          }
          return {
            ok: failed === 0,
            checked_snapshots: count,
            failed_snapshots: failed,
            format: store.format ?? 4,
          };
        } finally {
          store.close();
        }
      }
      return verifyPaged(p.repository, p.snapshot);
    case "audit":
      fields(p, ["repository", "snapshot"]);
      {
        try {
          return { ...(await engineAction("verify", p)), kind: "integrity" };
        } catch {
          return {
            ok: false,
            kind: "integrity",
            error_code: "INTEGRITY_REJECTED",
          };
        }
      }
    case "drill":
      fields(p, ["repository", "snapshot", "prefix"]);
      return drill(p.repository, p.snapshot, p);
    case "restore-preview":
      fields(p, [
        "repository",
        "snapshot",
        "target",
        "prefix",
        "selections",
        "restoreModes",
        "partial",
        "metadataMode",
      ]);
      return previewPagedRestore(p.repository, p.snapshot, p.target, {
        prefixes: p.selections ?? (p.prefix ? [p.prefix] : []),
        partial: flag(p.partial),
        permissions: flag(p.restoreModes),
        metadataMode: p.metadataMode,
      });
    case "restore":
      fields(p, [
        "repository",
        "snapshot",
        "target",
        "prefix",
        "selections",
        "restoreModes",
        "partial",
        "confirmation",
        "metadataMode",
      ]);
      return restorePagedSelection(p.repository, p.snapshot, p.target, {
        prefixes: p.selections ?? (p.prefix ? [p.prefix] : []),
        partial: flag(p.partial),
        permissions: flag(p.restoreModes),
        metadataMode: p.metadataMode,
        confirmation: p.confirmation,
      });
    case "restore-direct":
      fields(p, ["repository", "snapshot", "target"]);
      return restorePaged(p.repository, p.snapshot, p.target);
    case "key-export":
      fields(p, ["repository", "output", "confirmation"]);
      if (p.confirmation !== p.repository)
        throw new Error("Exact key-export repository confirmation required");
      return key(p.repository, action, p);
    case "password-change":
      fields(p, ["repository", "newPassword", "confirmation"]);
      if (p.confirmation !== p.repository || typeof p.newPassword !== "string")
        throw new Error("Password change confirmation required");
      return key(p.repository, action, p);
    case "unlock":
      fields(p, ["repository", "remember"]);
      flag(p.remember);
      return key(p.repository, action, p);
    default:
      throw new Error("Unsupported engine capability");
  }
}
