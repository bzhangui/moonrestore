import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PagedStore, PagedIndex, syncDirectory } from "./paged-store.mjs";
import { PrivateOperation } from "./private-operation.mjs";
import { checked } from "./vault.mjs";
import {
  assess,
  selected,
  selectionPrefixes,
  pagedRecords,
  targetIdentity,
} from "./paged-selection.mjs";
import { publishDirectory } from "./adapter.mjs";
import { checkpoint } from "./activity.mjs";
import {
  fidelityRecord,
  applyFidelity,
  verifyFidelity,
  prepareSparse,
} from "./fidelity.mjs";
const identity = (p) => {
  const s = fs.lstatSync(checked(p), { bigint: true });
  return [s.dev, s.ino].map(String).join(":");
};
const summary = (r) => ({
  ok: r.phase === "completed" && r.bad === 0 && !r.last_error,
  operation: r.id,
  state: r.phase,
  snapshot: r.snapshot,
  restored_files: r.done,
  damaged_files: r.bad ?? 0,
  complete: r.phase === "completed" && r.bad === 0 && !r.last_error,
  post_restore_readback: r.phase === "completed" && !r.last_error,
  metadata_profile_verified: r.metadataComplete === true && !r.last_error,
  all_filesystem_metadata_preserved: false,
  metadata_profile: r.metadataMode,
  metadata_losses: r.losses ?? [],
  last_error: r.last_error ?? null,
  resume_mode: "verified_owned_prefix",
  checkpoint_bytes: r.active?.offset ?? "0",
  target: r.target,
});
export async function createPagedRestore(
  repository,
  snapshot,
  target,
  {
    prefixes = [],
    partial = false,
    permissions = false,
    metadataMode,
    confirmation,
    environment = process.env,
  } = {},
) {
  if (
    typeof partial !== "boolean" ||
    typeof permissions !== "boolean" ||
    (metadataMode !== undefined &&
      !["basic", "portable", "native"].includes(metadataMode))
  )
    throw new Error("Invalid restore policy");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store);
  let journal;
  try {
    metadataMode ??= store.format === 5 ? "native" : "basic";
    const list = selectionPrefixes(store, prefixes),
      destination = targetIdentity(store, target),
      result = assess(store, index, snapshot, list);
    if (result.bad && !partial)
      throw new Error(
        "Damaged selected files; explicit partial rescue required",
      );
    if (
      store.format === 5 &&
      (metadataMode === "basic" ||
        (metadataMode === "native" &&
          (!permissions || result.root.fidelity.platform !== process.platform)))
    )
      throw new Error(
        "Native metadata needs same platform and explicit permissions; portable is an explicit lossy alternative",
      );
    if (store.format !== 5 && metadataMode === "native")
      throw new Error("No native metadata was captured in this snapshot");
    store.core(
      "fidelity-policy",
      {
        session: result.root.fidelity?.platform ?? process.platform,
        previous: process.platform,
        count: permissions ? 1 : 0,
      },
      Buffer.from(metadataMode),
    );
    if (confirmation !== target)
      throw new Error("Confirm the exact NEW restore target");
    const id = randomUUID();
    journal = new PrivateOperation(store, id, { create: true });
    const r = {
      format: 1,
      id,
      binding: journal.binding,
      snapshot,
      target: destination.full,
      parent: destination.parent,
      parentIdentity: destination.identity,
      prefixes: list,
      partial,
      permissions,
      metadataMode,
      health: result.health,
      bad: result.bad,
      phase: "prepared",
      done: 0,
      stage: null,
      treeIdentity: null,
      active: null,
      created: new Date().toISOString(),
    };
    journal.save("head", r);
    return { ...summary(r), ok: true, prepared: true };
  } finally {
    journal?.close();
    index.close();
    store.close();
  }
}
function inspectTree(store, index, root, r, journal, tree) {
  index.db.exec(
    "DROP TABLE IF EXISTS restore_names; DROP TABLE IF EXISTS actual_links; CREATE TABLE restore_names(k TEXT PRIMARY KEY,kind TEXT NOT NULL);",
  );
  let seq = 0,
    dirs = 0;
  for (const record of pagedRecords(store, index, root))
    if (
      ["dir", "file"].includes(record.kind) &&
      selected(index, record.path)?.healthy
    ) {
      index.db
        .prepare("INSERT INTO restore_names VALUES(?,?)")
        .run(record.path, record.kind);
      const file = path.join(tree, record.path),
        receipt = record.kind === "dir" ? "d-" + dirs++ : "f-" + seq++;
      if (fs.existsSync(file)) {
        const s = fs.lstatSync(checked(file), { bigint: true });
        if (record.kind === "dir" ? !s.isDirectory() : !s.isFile())
          throw new Error("Restore staging kind changed");
        if (!journal.exists(receipt))
          throw new Error("Unowned entry in restore staging");
        const saved = journal.read(receipt);
        if (saved.path !== record.path || saved.identity !== identity(file))
          throw new Error("Restore staging identity changed");
      } else if (
        journal.exists(receipt) &&
        !(
          r.active &&
          r.active.sequence === seq - 1 &&
          record.kind === "file" &&
          journal.read(receipt).identity === r.active.identity
        )
      )
        throw new Error("Checkpointed restore entry missing");
    }
  index.db.exec(
    "CREATE TABLE actual_links(k TEXT PRIMARY KEY,expected_group TEXT,n INTEGER NOT NULL,nlink INTEGER NOT NULL);",
  );
  function walk(dir, prefix = "") {
    const it = fs.opendirSync(checked(dir));
    try {
      for (let item = it.readSync(); item; item = it.readSync()) {
        checkpoint("restore_inventory");
        const rel = prefix ? prefix + "/" + item.name : item.name,
          row = index.db
            .prepare("SELECT kind FROM restore_names WHERE k=?")
            .get(rel),
          file = checked(path.join(dir, item.name)),
          s = fs.lstatSync(file);
        if (
          !row ||
          s.isSymbolicLink() ||
          (row.kind === "dir" ? !s.isDirectory() : !s.isFile())
        )
          throw new Error("Unexpected restore staging entry");
        if (s.isDirectory()) walk(file, rel);
        else {
          const k = identity(file),
            group =
              store.format === 5 && r.metadataMode === "native"
                ? fidelityRecord(index, rel).group
                : null,
            prior = index.db
              .prepare("SELECT * FROM actual_links WHERE k=?")
              .get(k);
          if (prior && (group === null || prior.expected_group !== group))
            throw new Error("Unexpected shared restore inode");
          index.db
            .prepare(
              "INSERT INTO actual_links VALUES(?,?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1",
            )
            .run(k, group, s.nlink);
        }
      }
    } finally {
      it.closeSync();
    }
  }
  walk(tree);
  for (const row of index.db.prepare("SELECT * FROM actual_links").iterate())
    if (row.n !== row.nlink)
      throw new Error("External hardlink in restore staging");
}
export async function runPagedRestore(
  repository,
  id,
  { recover = false, environment = process.env } = {},
) {
  if (typeof recover !== "boolean")
    throw new Error("Strict restore recovery flag required");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store),
    session = randomUUID();
  let r,
    journal,
    release,
    fd = null;
  try {
    journal = new PrivateOperation(store, id);
    release = journal.lease(recover);
    r = journal.read("head");
    if (r.id !== id || r.binding !== journal.binding)
      throw new Error("Restore repository binding changed");
    const result = assess(store, index, r.snapshot, r.prefixes);
    if (result.health !== r.health || result.bad !== r.bad)
      throw new Error("Source health changed; restore continuation refused");
    if (identity(r.parent) !== r.parentIdentity)
      throw new Error("Restore parent identity changed");
    if (!r.stage) {
      targetIdentity(store, r.target);
      const disk = fs.statfsSync(r.parent, { bigint: true });
      if (
        disk.bsize * disk.bavail <
        BigInt(result.bytes) +
          16777216n +
          BigInt(result.files + result.dirs + 1) * disk.bsize
      )
        throw new Error("Restore capacity insufficient");
      r.stage = fs.mkdtempSync(path.join(r.parent, ".moonrestore-resume-"));
      fs.mkdirSync(path.join(r.stage, "tree"), { mode: 0o700 });
      fs.mkdirSync(path.join(r.stage, "work"), { mode: 0o700 });
      r.stageIdentity = identity(r.stage);
      r.treeIdentity = identity(path.join(r.stage, "tree"));
      r.workIdentity = identity(path.join(r.stage, "work"));
      journal.save("head", r);
    }
    if (
      path.dirname(r.stage) !== r.parent ||
      !path.basename(r.stage).startsWith(".moonrestore-resume-") ||
      identity(r.stage) !== r.stageIdentity ||
      identity(path.join(r.stage, "work")) !== r.workIdentity
    )
      throw new Error("Restore stage identity changed");
    const published = fs.existsSync(r.target),
      tree = published ? r.target : path.join(r.stage, "tree");
    store.core("restore-publication", {
      previous: r.phase,
      count: published ? 1 : 0,
      sequence: fs.existsSync(path.join(r.stage, "tree")) ? 1 : 0,
    });
    if (
      identity(tree) !== r.treeIdentity ||
      (published && !["publishing", "completed"].includes(r.phase))
    )
      throw new Error("Restore target collision or identity changed");
    inspectTree(store, index, result.root, r, journal, tree);
    if (published && fs.existsSync(path.join(r.stage, "tree")))
      throw new Error("Uncertain restore publication");
    for (const name of fs.readdirSync(path.join(r.stage, "work")))
      if (name !== r.active?.temporary)
        throw new Error(
          "Unexpected restore work file in " +
            r.phase +
            " (active=" +
            Boolean(r.active) +
            ", name=" +
            name +
            ")",
        );
    if (!published) r.phase = "running";
    r.last_error = null;
    journal.save("head", r);
    let seq = 0,
      dirs = 0,
      current,
      active = false,
      position = 0,
      receiptName,
      meta,
      completeFile = false;
    index.db.exec(
      "CREATE TABLE restore_groups(k TEXT PRIMARY KEY,path TEXT,identity TEXT);",
    );
    for (const row of pagedRecords(store, index, result.root)) {
      store.fail("resume-restore");
      if (row.kind === "dir" && selected(index, row.path)) {
        const file = path.join(tree, row.path),
          name = "d-" + dirs++;
        if (!fs.existsSync(file)) {
          if (published) throw new Error("Published directory missing");
          fs.mkdirSync(checked(file, false), { mode: 0o700 });
          journal.save(name, { path: row.path, identity: identity(file) });
          store.fail("restore-directory");
        }
        continue;
      }
      if (row.kind === "file") {
        current = selected(index, row.path);
        active = current?.healthy === true;
        position = 0;
        if (!active) continue;
        meta =
          store.format === 5 && r.metadataMode === "native"
            ? fidelityRecord(index, row.path)
            : null;
        receiptName = "f-" + seq;
        const output = path.join(tree, row.path);
        const completed = fs.existsSync(output);
        completeFile = completed;
        if (!completed) {
          if (published) throw new Error("Published file missing");
          if (r.active && r.active.sequence !== seq)
            throw new Error("Restore active file order mismatch");
          if (!r.active) {
            r.active = {
              sequence: seq,
              path: row.path,
              temporary: randomUUID() + ".part",
              identity: null,
              offset: "0",
            };
            journal.save("head", r);
          }
          const file = checked(
            path.join(r.stage, "work", r.active.temporary),
            false,
          );
          if (!fs.existsSync(file)) {
            if (r.active.identity) throw new Error("Restore work file missing");
            fd = fs.openSync(file, "wx", 0o600);
            r.active.identity = identity(file);
            journal.save("head", r);
            store.fail("restore-work-created");
          } else {
            if (!r.active.identity || identity(file) !== r.active.identity)
              throw new Error("Restore work identity missing/changed");
            fd = fs.openSync(file, "r+");
          }
          if (meta) prepareSparse(file, meta);
          const s = fs.fstatSync(fd);
          if (!s.isFile() || s.nlink !== 1)
            throw new Error("Restore work size/link changed");
          store.core("restore-prefix", {
            entries: String(s.size),
            total: current.size,
            chunks: r.active.offset,
          });
          store.core(
            "restore-writer-new",
            {
              session,
              entries: String(s.size),
              total: current.size,
              chunks: r.active.offset,
              count: published ? 1 : 0,
            },
            Buffer.from(
              JSON.stringify(
                meta?.native.sparse
                  ? meta.native.ranges.map(([start, length]) => ({
                      start,
                      length,
                    }))
                  : null,
              ),
            ),
          );
        } else {
          const saved = journal.read(receiptName);
          if (saved.identity !== identity(output) || saved.path !== row.path)
            throw new Error("Restore completed identity changed");
          fd = fs.openSync(checked(output), "r");
          const s = fs.fstatSync(fd);
          if (s.size !== Number(current.size))
            throw new Error("Completed restore file changed");
          store.core(
            "restore-writer-new",
            {
              session,
              entries: String(s.size),
              total: current.size,
              chunks: String(s.size),
              sequence: 1,
              count: published ? 1 : 0,
            },
            Buffer.from("null"),
          );
        }
        store.core("hash-new", { session });
      } else if (row.kind === "chunk" && active) {
        const bytes = store.chunk(row);
        const plan = store.core("restore-writer-chunk", {
          session,
          count: bytes.length,
        });
        const already = plan.verify;
        if (already) {
          const found = Buffer.alloc(already);
          if (
            fs.readSync(fd, found, 0, already, position) !== already ||
            !found.equals(bytes.subarray(0, already))
          )
            throw new Error("Restore staged prefix changed; never overwritten");
        }
        if (plan.checkpoint) {
          for (const range of plan.writes) {
            const from = Number(range.start),
              to = from + Number(range.length);
            let at = from - position;
            while (position + at < to) {
              const n = fs.writeSync(
                fd,
                bytes,
                at,
                to - position - at,
                position + at,
              );
              if (!n) throw new Error("Restore write stalled");
              at += n;
            }
          }
          fs.ftruncateSync(fd, Number(plan.end));
          fs.fsyncSync(fd);
          store.fail("restore-written");
          r.active.offset = String(plan.end);
          journal.save("head", r);
          store.fail("restore-checkpoint");
        }
        store.core("hash-push", { session }, bytes);
        position = Number(plan.end);
      } else if (row.kind === "end" && active) {
        store.core("restore-writer-finish", { session });
        if (
          position !== Number(current.size) ||
          store.core("hash-finish", { session }) !== current.hash
        )
          throw new Error("Restore full file checksum mismatch");
        if (!completeFile) fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        const output = path.join(tree, current.path);
        if (!fs.existsSync(output)) {
          const work = path.join(r.stage, "work", r.active.temporary),
            group = meta?.group
              ? index.db
                  .prepare("SELECT * FROM restore_groups WHERE k=?")
                  .get(meta.group)
              : null;
          if (group) {
            if (identity(path.join(tree, group.path)) !== group.identity)
              throw new Error("Hardlink donor changed");
            journal.save(receiptName, {
              path: current.path,
              identity: group.identity,
              hash: current.hash,
            });
            fs.linkSync(
              checked(path.join(tree, group.path)),
              checked(output, false),
            );
            fs.unlinkSync(work);
          } else {
            journal.save(receiptName, {
              path: current.path,
              identity: identity(work),
              hash: current.hash,
            });
            store.fail("restore-receipt");
            fs.renameSync(work, checked(output, false));
          }
          syncDirectory(path.dirname(output));
          store.fail("restore-file-published");
        }
        if (meta?.group)
          index.db
            .prepare("INSERT OR IGNORE INTO restore_groups VALUES(?,?,?)")
            .run(meta.group, current.path, identity(output));
        // Replay visits earlier completed files before the interrupted file.
        // Never discard a later file's authenticated work receipt here.
        if (r.active?.sequence === seq) {
          const leftover = checked(
            path.join(r.stage, "work", r.active.temporary),
            false,
          );
          if (fs.existsSync(leftover)) {
            if (
              identity(leftover) !== r.active.identity ||
              fs.statSync(leftover).nlink !== 1
            )
              throw new Error("Restore leftover work identity changed");
            const input = fs.openSync(leftover, "r"),
              buffer = Buffer.alloc(65536);
            store.core("hash-new", { session });
            try {
              while (true) {
                const n = fs.readSync(input, buffer);
                if (!n) break;
                store.core("hash-push", { session }, buffer.subarray(0, n));
              }
            } finally {
              fs.closeSync(input);
            }
            if (store.core("hash-finish", { session }) !== current.hash)
              throw new Error("Restore leftover work content changed");
            fs.unlinkSync(leftover);
          }
          r.active = null;
        }
        seq++;
        r.done = seq;
        journal.save("head", r);
        active = false;
      }
    }
    inspectTree(store, index, result.root, r, journal, tree);
    // Final independent readback covers data just written as well as resumed data.
    for (const row of pagedRecords(store, index, result.root))
      if (row.kind === "file" && selected(index, row.path)?.healthy) {
        const wanted = selected(index, row.path),
          file = checked(path.join(tree, row.path)),
          input = fs.openSync(file, "r"),
          buffer = Buffer.alloc(65536);
        store.core("hash-new", { session });
        try {
          while (true) {
            checkpoint("restore_final_readback");
            const n = fs.readSync(input, buffer);
            if (!n) break;
            store.core("hash-push", { session }, buffer.subarray(0, n));
          }
        } finally {
          fs.closeSync(input);
        }
        if (store.core("hash-finish", { session }) !== wanted.hash)
          throw new Error("Restore independent readback mismatch");
      }
    for (let p = result.root.pages - 1; p >= 0; p--) {
      const { pageFrom } = await import("./paged-store.mjs");
      for (const row of [
        ...pageFrom(store, index.get("pages", p).id).records,
      ].reverse())
        if (
          ["file", "dir"].includes(row.kind) &&
          selected(index, row.path)?.healthy
        ) {
          const file = checked(path.join(tree, row.path));
          if (store.format === 5 && r.metadataMode === "native") {
            const m = fidelityRecord(index, row.path);
            applyFidelity(file, m, { permissions: r.permissions });
            verifyFidelity(file, m);
            store.fail("restore-metadata-applied");
          } else {
            fs.utimesSync(
              file,
              Number(row.mtime_ms) / 1000,
              Number(row.mtime_ms) / 1000,
            );
            if (r.permissions && process.platform !== "win32")
              fs.chmodSync(file, row.mode);
          }
        }
    }
    if (store.format === 5 && r.metadataMode === "native") {
      const m = fidelityRecord(index, "");
      applyFidelity(tree, m, { permissions: r.permissions });
      verifyFidelity(tree, m);
    }
    if (!published) {
      r.phase = "publishing";
      journal.save("head", r);
      store.fail("restore-before-publish");
      targetIdentity(store, r.target);
      publishDirectory(tree, r.target);
      syncDirectory(r.parent);
      store.fail("restore-after-publish");
    }
    // Publication itself must not silently alter the supported native profile.
    if (store.format === 5 && r.metadataMode === "native") {
      for (let p = result.root.pages - 1; p >= 0; p--) {
        const { pageFrom } = await import("./paged-store.mjs");
        for (const row of [
          ...pageFrom(store, index.get("pages", p).id).records,
        ].reverse())
          if (
            ["file", "dir"].includes(row.kind) &&
            selected(index, row.path)?.healthy
          )
            verifyFidelity(
              checked(path.join(r.target, row.path)),
              fidelityRecord(index, row.path),
            );
      }
      verifyFidelity(r.target, fidelityRecord(index, ""));
    }
    r.phase = "completed";
    r.metadataComplete = store.format === 5 && r.metadataMode === "native";
    r.losses = r.metadataComplete
      ? [
          process.platform === "win32"
            ? "ctime_os_managed"
            : "birthtime_and_ctime_information_only",
          "physical_allocation_not_bit_identical",
          "special_mode_bits_and_vendor_specific_attributes_not_archived",
          ...(process.platform === "win32"
            ? ["windows_acl_inheritance_frozen_original_descriptor_archived"]
            : []),
        ]
      : ["extended_metadata_not_restored"];
    journal.save("head", r);
    return summary(r);
  } catch (error) {
    if (r) {
      r.last_error = "restore_verification_or_io_failed";
      if (r.phase !== "completed" && r.phase !== "publishing")
        r.phase = "failed";
      try {
        journal.save("head", r);
      } catch {}
    }
    error.message = "Restore " + id + " failed: " + error.message;
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    store.core("close", { session });
    try {
      release?.();
    } finally {
      journal?.close();
      index.close();
      store.close();
    }
  }
}
export async function pagedRestoreStatus(repository, id) {
  const store = await PagedStore.open(repository);
  let journal;
  try {
    journal = new PrivateOperation(store, id);
    return { ...summary(journal.read("head")), ok: true };
  } finally {
    journal?.close();
    store.close();
  }
}
