import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { checked, mkdirPrivate, stateHome } from "./vault.mjs";
import {
  PagedStore,
  PagedIndex,
  pageFrom,
  indexSnapshot,
  newFile,
  PACK_LIMIT,
  syncDirectory,
} from "./paged-store.mjs";
import { publishDirectory } from "./adapter.mjs";
import { core, options, removeOwned } from "./maintenance.mjs";
const record = (kind, fields = {}) => ({
  kind,
  path: "",
  id: "",
  size: "0",
  pack: "",
  offset: 0,
  ...fields,
});
const statValue = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  mtime: String(s.mtimeNs),
  ctime: String(s.ctimeNs),
});
const attributes = (s) => ({
  mtime_ms: String(s.mtimeMs < 0n ? 0n : s.mtimeMs),
  mode: Number(s.mode & 511n),
});
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
const overlap = (a, b) => {
  a = path.resolve(a);
  b = path.resolve(b);
  if (process.platform === "win32") {
    a = a.toLowerCase();
    b = b.toLowerCase();
  }
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
};

export async function backupPaged(
  repository,
  source,
  { label = "", excludes = [], environment = process.env } = {},
) {
  if (typeof label !== "string" || label.length > 200)
    throw new Error("Invalid paged label");
  if (
    !Array.isArray(excludes) ||
    excludes.length > 64 ||
    Buffer.byteLength(JSON.stringify(excludes)) > 8192
  )
    throw new Error("Invalid exclusion budget");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store),
    ledger = randomUUID();
  const hashSession = randomUUID(),
    chunkSession = randomUUID();
  let sourceRoot;
  let page = [],
    sequence = 0,
    previous = "",
    entries = 0,
    chunks = 0,
    total = 0,
    sourceSequence = 0,
    queue = [],
    packBytes = 6,
    storedBytes = 0,
    reusedBytes = 0;
  try {
    sourceRoot = checked(source);
    if (
      !fs.lstatSync(sourceRoot).isDirectory() ||
      overlap(sourceRoot, store.repo)
    )
      throw new Error("Source/repository overlap or invalid source");
    for (const relative of excludes) store.core("path", { session: relative });
    const skip = (relative) =>
      excludes.some(
        (value) => relative === value || relative.startsWith(value + "/"),
      );
    if (overlap(sourceRoot, index.folder)) {
      const relative = path
        .relative(sourceRoot, index.folder)
        .split(path.sep)
        .join("/");
      if (relative.startsWith("..") || !skip(relative))
        throw new Error(
          "Private state must be outside the source or explicitly excluded",
        );
    }
    store.lock();
    for (const snapshot of store.snapshots())
      indexSnapshot(store, index, snapshot);
    index.clearSnapshot();
    store.core("ledger-new", { session: ledger });
    const flushPage = () => {
      if (!page.length) return;
      const value = { format: 4, sequence, previous, records: page },
        bytes = Buffer.from(JSON.stringify(value));
      store.core("page", { sequence, previous, count: page.length }, bytes);
      const digest = store.logical(bytes);
      store.write("page", digest, bytes);
      store.read("page", digest);
      previous = digest;
      sequence++;
      page = [];
    };
    const emit = (value) => {
      store.core("ledger-record", { session: ledger, record: value });
      if (
        page.length === 128 ||
        Buffer.byteLength(JSON.stringify({ ...value })) +
          Buffer.byteLength(JSON.stringify(page)) >
          250000
      )
        flushPage();
      page.push(value);
      if (value.kind === "dir" || value.kind === "file") entries++;
      if (value.kind === "file") total += Number(value.size);
      if (value.kind === "chunk") chunks++;
    };
    const flushPack = () => {
      if (!queue.length) return;
      const raw = [Buffer.from("MRPK4\n")],
        locations = new Map();
      let offset = 6;
      for (const item of queue)
        if (item.bytes && !locations.has(item.id)) {
          const header = Buffer.alloc(36);
          header.writeUInt32LE(item.bytes.length);
          Buffer.from(item.id, "hex").copy(header, 4);
          locations.set(item.id, { offset, size: String(item.bytes.length) });
          raw.push(header, item.bytes);
          offset += 36 + item.bytes.length;
        }
      let pack;
      if (raw.length > 1) {
        const plain = Buffer.concat(raw),
          compressed = deflateSync(plain),
          use = compressed.length + 32 < plain.length,
          encoded = Buffer.alloc(9);
        encoded.write("MRP4");
        encoded[4] = use ? 1 : 0;
        encoded.writeUInt32LE(plain.length, 5);
        pack = store.logical(plain);
        const payload = Buffer.concat([encoded, use ? compressed : plain]);
        store.write("pack", pack, payload);
        store.pack(pack);
        storedBytes += payload.length;
        store.fail("pack-flushed");
      }
      for (const item of queue) {
        if (item.bytes) {
          const value = record("chunk", {
            id: item.id,
            pack,
            ...locations.get(item.id),
          });
          index.put("objects", index.key("object", item.id), value);
          emit(value);
        } else emit(item);
      }
      queue = [];
      packBytes = 6;
    };
    const enqueue = (value) => {
      if (queue.length >= 128) flushPack();
      queue.push(value);
    };
    const addChunk = (bytes) => {
      const digest = store.logical(bytes),
        existing = index.get("objects", index.key("object", digest));
      if (existing) {
        store.chunk(existing);
        enqueue(existing);
        reusedBytes += bytes.length;
        return;
      }
      if (packBytes + 36 + bytes.length > PACK_LIMIT || queue.length >= 128)
        flushPack();
      queue.push({ id: digest, bytes: Buffer.from(bytes) });
      packBytes += 36 + bytes.length;
    };
    const visit = (folder, prefix = "", depth = 0) => {
      if (depth > 64) throw new Error("Paged source depth exceeded");
      const initial = fs.lstatSync(checked(folder), { bigint: true });
      if (!initial.isDirectory()) throw new Error("Source directory changed");
      index.put("source", sourceSequence++, {
        path: prefix,
        stat: statValue(initial),
      });
      const iterator = fs.opendirSync(folder);
      try {
        for (let item = iterator.readSync(); item; item = iterator.readSync()) {
          store.fail("scan");
          const relative = prefix ? prefix + "/" + item.name : item.name;
          if (skip(relative)) continue;
          store.core("path", { session: relative });
          const file = checked(path.join(folder, item.name)),
            s = fs.lstatSync(file, { bigint: true });
          if (s.isDirectory()) {
            index.path(relative, "dir");
            enqueue(record("dir", { path: relative, ...attributes(s) }));
            visit(file, relative, depth + 1);
          } else if (s.isFile() && s.nlink === 1n) {
            if (s.size > 68719476736n)
              throw new Error("Paged source file budget");
            index.path(relative, "file");
            index.put("source", sourceSequence++, {
              path: relative,
              stat: statValue(s),
            });
            enqueue(
              record("file", {
                path: relative,
                size: String(s.size),
                ...attributes(s),
              }),
            );
            store.core("hash-new", { session: hashSession });
            store.core("chunk-new", { session: chunkSession });
            const fd = fs.openSync(
                file,
                fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
              ),
              buffer = Buffer.alloc(65536);
            let size = 0;
            try {
              if (
                !same(
                  statValue(s),
                  statValue(fs.fstatSync(fd, { bigint: true })),
                )
              )
                throw new Error("Paged source changed before read");
              while (true) {
                store.fail("read-source");
                const n = fs.readSync(fd, buffer, 0, buffer.length, null);
                if (!n) break;
                size += n;
                if (size > Number(s.size)) throw new Error("Paged source grew");
                const bytes = buffer.subarray(0, n);
                store.core("hash-push", { session: hashSession }, bytes);
                for (const hex of store.core(
                  "chunk-push",
                  { session: chunkSession },
                  bytes,
                ))
                  addChunk(Buffer.from(hex, "hex"));
              }
              const tail = store.core("chunk-finish", {
                session: chunkSession,
              });
              if (tail) addChunk(Buffer.from(tail, "hex"));
              const digest = store.core("hash-finish", {
                session: hashSession,
              });
              if (
                size !== Number(s.size) ||
                !same(
                  statValue(s),
                  statValue(fs.fstatSync(fd, { bigint: true })),
                )
              )
                throw new Error("Paged source changed while reading");
              enqueue(record("end", { id: digest, size: String(size) }));
            } finally {
              fs.closeSync(fd);
            }
          } else
            throw new Error("Paged source links/special files unsupported");
        }
      } finally {
        iterator.closeSync();
      }
    };
    visit(sourceRoot);
    flushPack();
    flushPage();
    for (let i = 0; i < sourceSequence; i++) {
      const initial = index.get("source", i),
        current = fs.lstatSync(checked(path.join(sourceRoot, initial.path)), {
          bigint: true,
        });
      if (!same(initial.stat, statValue(current)))
        throw new Error("Source tree changed before snapshot commit");
    }
    store.core("ledger-finish", {
      session: ledger,
      entries: String(entries),
      chunks: String(chunks),
      total: String(total),
    });
    const root = {
      format: 4,
      repository: store.repoId,
      created: new Date().toISOString(),
      label,
      pages: sequence,
      last_page: previous,
      entries,
      chunks,
      bytes: String(total),
      excludes,
    };
    const bytes = Buffer.from(JSON.stringify(root)),
      snapshot = store.logical(bytes);
    store.fail("before-root");
    store.write("snapshot", snapshot, bytes);
    store.fail("root-published");
    indexSnapshot(store, index, snapshot);
    return {
      ok: true,
      format: 4,
      snapshot,
      entries,
      chunks,
      pages: sequence,
      logical_bytes: String(total),
      stored_pack_bytes: String(storedBytes),
      reused_bytes: String(reusedBytes),
      post_commit_verified: true,
      source_modified: false,
    };
  } finally {
    store.core("close", { session: ledger });
    store.core("close", { session: hashSession });
    store.core("close", { session: chunkSession });
    try {
      index.close();
    } finally {
      store.close();
    }
  }
}

export async function verifyPaged(
  repository,
  snapshot,
  { environment = process.env } = {},
) {
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store);
  try {
    const root = indexSnapshot(store, index, snapshot);
    return {
      ok: true,
      format: 4,
      snapshot,
      entries: root.entries,
      chunks: root.chunks,
      pages: root.pages,
      logical_bytes: root.bytes,
      content_verified: true,
      disk_index_rebuilt: true,
    };
  } finally {
    try {
      index.close();
    } finally {
      store.close();
    }
  }
}

export async function restorePaged(
  repository,
  snapshot,
  target,
  { environment = process.env, permissions = false } = {},
) {
  if (typeof permissions !== "boolean")
    throw new Error("Permissions opt-in must be boolean");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store),
    session = randomUUID();
  let stage,
    fd = null;
  try {
    const root = indexSnapshot(store, index, snapshot),
      destination = checked(target, false),
      parent = checked(path.dirname(destination));
    if (fs.existsSync(destination) || overlap(destination, store.repo))
      throw new Error("New isolated restore target required");
    const disk = fs.statfsSync(parent, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(root.bytes) + 1048576n)
      throw new Error("Restore free space preflight failed");
    stage = fs.mkdtempSync(path.join(parent, ".moonrestore-paged-restore-"));
    let current,
      used = 0,
      files = 0;
    const finishAttributes = (file, r) => {
      fs.utimesSync(file, Number(r.mtime_ms) / 1000, Number(r.mtime_ms) / 1000);
      if (permissions && process.platform !== "win32")
        fs.chmodSync(file, r.mode);
    };
    for (let seq = 0; seq < root.pages; seq++)
      for (const r of pageFrom(store, index.get("pages", seq).id).records) {
        store.fail("restore");
        if (r.kind === "dir")
          fs.mkdirSync(checked(path.join(stage, r.path), false), {
            mode: 0o700,
          });
        else if (r.kind === "file") {
          const file = checked(path.join(stage, r.path), false);
          checked(path.dirname(file));
          fd = fs.openSync(file, "wx", 0o600);
          current = { file, r };
          used = 0;
          store.core("hash-new", { session });
        } else if (r.kind === "chunk") {
          const bytes = store.chunk(r);
          let n = 0;
          while (n < bytes.length) {
            const wrote = fs.writeSync(fd, bytes, n, bytes.length - n, null);
            if (!wrote) throw new Error("Restore write made no progress");
            n += wrote;
          }
          used += bytes.length;
          store.core("hash-push", { session }, bytes);
        } else {
          if (
            used !== Number(r.size) ||
            store.core("hash-finish", { session }) !== r.id
          )
            throw new Error("Restored stream checksum mismatch");
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          fd = null;
          const verify = fs.openSync(
              checked(current.file),
              fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
            ),
            buffer = Buffer.alloc(65536);
          store.core("hash-new", { session });
          let read = 0;
          try {
            while (true) {
              const n = fs.readSync(verify, buffer, 0, buffer.length, null);
              if (!n) break;
              read += n;
              store.core("hash-push", { session }, buffer.subarray(0, n));
            }
          } finally {
            fs.closeSync(verify);
          }
          if (
            read !== Number(r.size) ||
            store.core("hash-finish", { session }) !== r.id
          )
            throw new Error("Restored disk readback mismatch");
          finishAttributes(current.file, current.r);
          files++;
        }
      }
    for (let seq = root.pages - 1; seq >= 0; seq--)
      for (const r of [
        ...pageFrom(store, index.get("pages", seq).id).records,
      ].reverse())
        if (r.kind === "dir")
          finishAttributes(checked(path.join(stage, r.path)), r);
    syncDirectory(stage);
    store.fail("before-restore-publish");
    checked(parent);
    publishDirectory(stage, destination);
    stage = null;
    syncDirectory(parent);
    return {
      ok: true,
      format: 4,
      snapshot,
      target: destination,
      files,
      logical_bytes: root.bytes,
      preverified: true,
      independent_disk_readback: true,
      overwritten: false,
    };
  } catch (error) {
    if (stage) error.staging_retained = true;
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    store.core("close", { session });
    try {
      index.close();
    } finally {
      store.close();
    }
  }
}

export async function migratePaged(
  repository,
  snapshot,
  target,
  { encrypted = false } = {},
) {
  const source = checked(repository),
    destination = checked(target, false);
  if (overlap(source, destination) || fs.existsSync(destination))
    throw new Error("Migration requires a new independent repository");
  await core(["audit", source, snapshot], {
    env: { MOONRESTORE_READ_ONLY: "1" },
  });
  const parent = mkdirPrivate(path.join(stateHome(), "paged-migrations")),
    owned = fs.mkdtempSync(path.join(parent, "migration-")),
    material = path.join(owned, "source");
  let complete = false;
  try {
    await core(["restore", source, snapshot, material], {
      env: { MOONRESTORE_RECOVERY_TARGET: material },
    });
    await PagedStore.create(destination, { encrypted });
    const result = await backupPaged(destination, material, {
      label: "Verified legacy snapshot migration",
    });
    await verifyPaged(destination, result.snapshot);
    complete = true;
    return {
      ...result,
      migration: true,
      legacy_snapshot: snapshot,
      legacy_modified: false,
      new_repository: destination,
    };
  } finally {
    if (complete) removeOwned(owned, parent, "migration-");
  }
}

export async function pagedCommand(args) {
  const [command, ...rest] = args;
  if (
    ![
      "paged-init",
      "paged-backup",
      "paged-verify",
      "paged-restore",
      "paged-migrate",
    ].includes(command)
  )
    return null;
  const { positionals: p, values: v } = options(
    rest,
    ["encrypted", "label", "permissions", "confirm", "exclude"],
    ["encrypted", "permissions"],
  );
  const only = (...keys) => Object.keys(v).every((key) => keys.includes(key));
  if (command === "paged-init" && p.length === 1 && only("encrypted"))
    return PagedStore.create(p[0], { encrypted: !!v.encrypted });
  if (command === "paged-backup" && p.length === 2 && only("label", "exclude"))
    return backupPaged(p[0], p[1], {
      label: v.label ?? "",
      excludes: v.exclude ?? [],
    });
  if (command === "paged-verify" && p.length === 2 && !Object.keys(v).length)
    return verifyPaged(...p);
  if (
    command === "paged-restore" &&
    p.length === 3 &&
    only("permissions", "confirm") &&
    v.confirm === p[2]
  )
    return restorePaged(...p, { permissions: !!v.permissions });
  if (
    command === "paged-migrate" &&
    p.length === 3 &&
    only("encrypted", "confirm") &&
    v.confirm === p[2]
  )
    return migratePaged(...p, { encrypted: !!v.encrypted });
  throw new Error(
    "Invalid paged command options; migration/restore requires exact NEW target confirmation",
  );
}
