// GC never prunes a published snapshot. It only quarantines unreachable packs
// and pages after auditing every root; permanent deletion is a separate action.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  bounded,
  newFile,
  syncDirectory,
} from "./paged-store.mjs";
import { checked } from "./vault.mjs";
import { options } from "./maintenance.mjs";
const id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const folder = (kind) => (kind === "pack" ? "packs" : "pages");
function source(store, item) {
  if (!["pack", "page"].includes(item.kind) || !id(item.physical))
    throw new Error("Invalid GC member");
  return checked(
    path.join(store.repo, folder(item.kind), item.physical),
    false,
  );
}
function auditRoots(store, index) {
  index.db.exec("CREATE TABLE roots(id TEXT PRIMARY KEY);");
  let count = 0;
  for (const snapshot of store.snapshots()) {
    if (++count > 1000000) throw new Error("Snapshot inventory budget");
    indexSnapshot(store, index, snapshot);
    index.db.prepare("INSERT INTO roots VALUES(?)").run(snapshot);
  }
  return count;
}
function scan(store, index, batch) {
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > 1000)
    throw new Error("GC batch must be 1..1000");
  const roots = auditRoots(store, index),
    session = randomUUID();
  store.core("hash-new", { session });
  index.db.exec(
    "CREATE TABLE garbage(k TEXT PRIMARY KEY,payload TEXT NOT NULL);",
  );
  let candidates = 0,
    bytes = 0;
  try {
    store.core("hash-push", { session }, Buffer.from(store.repoId + "\n"));
    for (const row of index.db
      .prepare("SELECT id FROM roots ORDER BY id")
      .iterate())
      store.core("hash-push", { session }, Buffer.from(row.id + "\n"));
    for (const kind of ["page", "pack"]) {
      const directory = fs.opendirSync(path.join(store.repo, folder(kind)));
      try {
        for (
          let item = directory.readSync();
          item;
          item = directory.readSync()
        ) {
          if (!item.isFile() || !id(item.name))
            throw new Error("Unexpected live store member");
          if (
            index.db
              .prepare("SELECT 1 FROM live WHERE k=?")
              .get(kind + ":" + item.name)
          )
            continue;
          const file = checked(path.join(store.repo, folder(kind), item.name)),
            s = fs.lstatSync(file, { bigint: true });
          if (!s.isFile() || s.nlink !== 1n || s.size > 8388704n)
            throw new Error("Unreachable member is linked or oversized");
          const value = {
            kind,
            physical: item.name,
            size: String(s.size),
            fingerprint: [s.dev, s.ino, s.mtimeNs, s.ctimeNs]
              .map(String)
              .join(":"),
          };
          index.db
            .prepare("INSERT INTO garbage VALUES(?,?)")
            .run(kind + ":" + item.name, JSON.stringify(value));
          candidates++;
          if (candidates > 2000000) throw new Error("Garbage inventory budget");
        }
      } finally {
        directory.closeSync();
      }
    }
    const selected = [];
    store.core("gc-planner-new", {
      session,
      sequence: roots,
      count: candidates,
      total: String(batch),
    });
    for (const row of index.db
      .prepare("SELECT payload FROM garbage ORDER BY k")
      .iterate()) {
      const value = JSON.parse(row.payload);
      store.core("hash-push", { session }, Buffer.from(row.payload + "\n"));
      if (store.core("gc-planner-select", { session, total: value.size })) {
        const raw = bounded(source(store, value), 8388704);
        value.sha256 = store.logical(raw);
        selected.push(value);
      }
    }
    const summary = store.core("gc-planner-finish", { session });
    if (
      summary.selected !== selected.length ||
      summary.candidates !== candidates
    )
      throw new Error("GC planner/IO inventory mismatch");
    bytes = summary.bytes;
    const inventory = store.core("hash-finish", { session });
    const confirmation = store.logical(
      Buffer.from(JSON.stringify({ inventory, batch, selected })),
    );
    return {
      ok: true,
      kind: "paged_gc_preview",
      confirmation,
      repository: store.repoId,
      roots,
      candidates,
      selected_count: selected.length,
      selected_bytes: String(bytes),
      snapshot_pruning: false,
      selected,
    };
  } finally {
    store.core("close", { session });
  }
}
function manifest(store, batch) {
  if (!id(batch)) throw new Error("Exact garbage batch required");
  const base = checked(path.join(store.repo, "trash", batch)),
    raw = bounded(path.join(base, "manifest.json"), 1048576);
  if (store.logical(raw) !== batch)
    throw new Error("Quarantine manifest checksum mismatch");
  const r = JSON.parse(raw);
  if (
    r.format !== 1 ||
    r.repository !== store.repoId ||
    !Number.isSafeInteger(r.created) ||
    r.created < 0 ||
    !Array.isArray(r.items) ||
    r.items.length > 1000
  )
    throw new Error("Invalid garbage manifest");
  for (const item of r.items) {
    source(store, item);
    if (
      !id(item.sha256) ||
      typeof item.size !== "string" ||
      !/^(0|[1-9][0-9]{0,7})$/.test(item.size)
    )
      throw new Error("Invalid quarantine member");
  }
  const names = new Set([
    "manifest.json",
    ...r.items.map((item) => item.kind + "-" + item.physical),
  ]);
  for (const name of fs.readdirSync(base))
    if (
      !names.has(name) ||
      fs.lstatSync(path.join(base, name)).isSymbolicLink()
    )
      throw new Error("Unexpected quarantine contents");
  return { base, record: r };
}
export async function garbagePaged(
  repository,
  { batch = 100, confirmation } = {},
) {
  (await import("./plans.mjs")).assertCleanupGuard(repository);
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  try {
    if (confirmation !== undefined) store.lock();
    const result = scan(store, index, batch),
      { selected, ...preview } = result;
    if (confirmation === undefined) return preview;
    if (confirmation !== result.confirmation)
      throw new Error("GC preview expired; re-preview exact inventory");
    if (!selected.length) return { ...preview, quarantined: 0 };
    const record = {
      format: 1,
      repository: store.repoId,
      created: Date.now(),
      preview: confirmation,
      items: selected,
    };
    const raw = Buffer.from(JSON.stringify(record)),
      batchId = store.logical(raw),
      base = checked(path.join(store.repo, "trash", batchId), false);
    fs.mkdirSync(base, { mode: 0o700 });
    newFile(path.join(base, "manifest.json"), raw);
    syncDirectory(base);
    const pending = path.join(store.repo, ".gc-pending.json");
    newFile(
      pending,
      Buffer.from(
        JSON.stringify({ format: 1, batch: batchId, repository: store.repoId }),
      ),
    );
    syncDirectory(store.repo);
    for (const item of selected) {
      const from = source(store, item),
        to = path.join(base, item.kind + "-" + item.physical);
      if (store.logical(bounded(from, 8388704)) !== item.sha256)
        throw new Error("Garbage changed before quarantine");
      fs.linkSync(from, to);
      store.fail("gc-linked");
      fs.unlinkSync(from);
      syncDirectory(path.dirname(from));
      store.fail("gc-moved");
    }
    syncDirectory(base);
    fs.unlinkSync(pending);
    syncDirectory(store.repo);
    return {
      ...preview,
      batch: batchId,
      quarantined: selected.length,
      permanently_deleted: 0,
      minimum_grace_days: 7,
    };
  } finally {
    try {
      index.close();
    } finally {
      store.close();
    }
  }
}
function rollback(store) {
  const pending = path.join(store.repo, ".gc-pending.json");
  if (!fs.existsSync(pending)) return false;
  const p = JSON.parse(bounded(pending, 1024));
  if (p.format !== 1 || p.repository !== store.repoId)
    throw new Error("Maintenance marker identity mismatch");
  const { base, record } = manifest(store, p.batch);
  for (const item of record.items) {
    const original = source(store, item),
      quarantined = checked(
        path.join(base, item.kind + "-" + item.physical),
        false,
      ),
      a = fs.existsSync(original),
      b = fs.existsSync(quarantined);
    if (!a && !b)
      throw new Error("Both original and quarantine member unavailable");
    if (b) {
      if (a) {
        const x = fs.lstatSync(original, { bigint: true }),
          y = fs.lstatSync(quarantined, { bigint: true });
        if (
          x.dev !== y.dev ||
          x.ino !== y.ino ||
          x.nlink !== 2n ||
          y.nlink !== 2n
        )
          throw new Error("Foreign file blocks maintenance rollback");
      }
      if (
        store.logical(
          bounded(quarantined, 8388704, a ? { ownedAlias: original } : {}),
        ) !== item.sha256
      )
        throw new Error("Quarantine changed; preserving pending state");
      if (!a) fs.linkSync(quarantined, original);
      fs.unlinkSync(quarantined);
      syncDirectory(path.dirname(original));
    } else if (store.logical(bounded(original, 8388704)) !== item.sha256)
      throw new Error("Original member changed during rollback");
  }
  fs.unlinkSync(path.join(base, "manifest.json"));
  fs.rmdirSync(base);
  fs.unlinkSync(pending);
  syncDirectory(store.repo);
  return true;
}
export async function recoverPaged(repository, confirmation) {
  const store = await PagedStore.open(repository);
  let index;
  try {
    if (confirmation !== store.repoId)
      throw new Error("Confirm exact repository identity");
    const lock = path.join(store.repo, ".lock");
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(bounded(path.join(lock, "owner.json"), 512));
      if (
        owner.host !== os.hostname() ||
        owner.repository !== store.repoId ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      )
        throw new Error("Foreign or invalid lock");
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") alive = false;
        else throw e;
      }
      if (alive) throw new Error("Paged writer still active");
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
    store.lock({ allowPending: true });
    const maintenanceRolledBack = rollback(store);
    let aliases = 0,
      orphans = 0;
    for (const name of fs.readdirSync(path.join(store.repo, "tmp"))) {
      const m = name.match(
        /^(page|pack|snapshot)-([a-f0-9]{64})-[a-f0-9-]{36}\.part$/,
      );
      if (!m) throw new Error("Unknown temporary member; preserving it");
      const temp = checked(path.join(store.repo, "tmp", name)),
        final = checked(
          path.join(
            store.repo,
            { page: "pages", pack: "packs", snapshot: "snapshots" }[m[1]],
            m[2],
          ),
          false,
        ),
        s = fs.lstatSync(temp);
      if (!s.isFile() || s.isSymbolicLink())
        throw new Error("Unexpected temporary file");
      if (fs.existsSync(final)) {
        const f = fs.lstatSync(final);
        if (
          s.dev === f.dev &&
          s.ino === f.ino &&
          s.nlink === 2 &&
          f.nlink === 2
        ) {
          fs.unlinkSync(temp);
          aliases++;
        } else if (s.nlink !== 1) throw new Error("Foreign temporary alias");
        else orphans++;
      } else if (s.nlink !== 1) throw new Error("Foreign temporary hard link");
      else orphans++;
    }
    index = new PagedIndex(store);
    const roots = auditRoots(store, index);
    return {
      ok: true,
      repository: store.repoId,
      roots,
      maintenance_rolled_back: maintenanceRolledBack,
      owned_aliases_removed: aliases,
      temporary_orphans_preserved: orphans,
    };
  } finally {
    try {
      index?.close();
    } finally {
      store.close();
    }
  }
}
export async function purgePaged(
  repository,
  batch,
  { confirmation, now = Date.now() } = {},
) {
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  try {
    if (confirmation !== undefined && confirmation !== batch)
      throw new Error("Confirm exact quarantine batch");
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("Invalid purge clock");
    (await import("./plans.mjs")).assertCleanupGuard(repository, now);
    if (confirmation) store.lock();
    const { base, record } = manifest(store, batch);
    auditRoots(store, index);
    const oldEnough =
      now - record.created >= 7 * 86400000 && now >= record.created;
    for (const item of record.items) {
      if (
        index.db
          .prepare("SELECT 1 FROM live WHERE k=?")
          .get(item.kind + ":" + item.physical)
      )
        throw new Error("A live root still references this quarantine member");
      const file = path.join(base, item.kind + "-" + item.physical);
      if (
        fs.existsSync(file) &&
        store.logical(bounded(file, 8388704)) !== item.sha256
      )
        throw new Error("Quarantine payload changed");
    }
    if (!confirmation)
      return {
        ok: true,
        batch,
        eligible: oldEnough,
        minimum_grace_days: 7,
        items: record.items.length,
        permanently_deleted: 0,
      };
    if (!oldEnough) throw new Error("Minimum quarantine grace has not elapsed");
    let removed = 0;
    for (const item of record.items) {
      const file = checked(
        path.join(base, item.kind + "-" + item.physical),
        false,
      );
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed++;
      }
    }
    fs.unlinkSync(path.join(base, "manifest.json"));
    fs.rmdirSync(base);
    syncDirectory(path.dirname(base));
    return {
      ok: true,
      batch,
      permanently_deleted: removed,
      snapshots_deleted: 0,
    };
  } finally {
    try {
      index.close();
    } finally {
      store.close();
    }
  }
}
export async function pagedMaintenanceCommand(args) {
  const [command, ...rest] = args;
  if (!["paged-gc", "paged-recover", "paged-purge"].includes(command))
    return null;
  const { positionals: p, values: v } = options(rest, ["batch", "confirm"]);
  if (command === "paged-gc" && p.length === 1)
    return garbagePaged(p[0], {
      batch: v.batch === undefined ? 100 : Number(v.batch),
      confirmation: v.confirm,
    });
  if (command === "paged-recover" && p.length === 1 && v.confirm && !v.batch)
    return recoverPaged(p[0], v.confirm);
  if (command === "paged-purge" && p.length === 2 && !v.batch)
    return purgePaged(...p, { confirmation: v.confirm });
  throw new Error("Invalid paged maintenance arguments");
}
