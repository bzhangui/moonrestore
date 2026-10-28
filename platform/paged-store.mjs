// Format-4 OS adapter. MoonBit owns CDC, logical hashes, record boundaries and
// aggregate validation. SQLite is a disposable, bounded disk index, not truth.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
  createVault,
  unlockVault,
  storageId,
  seal,
  unseal,
} from "./vault.mjs";
import { publishDirectory } from "./adapter.mjs";
import { checkpoint } from "./activity.mjs";
import { indexFidelity } from "./fidelity.mjs";

export const PAGE_LIMIT = 262144,
  PACK_LIMIT = 8388608;
const empty = Buffer.alloc(0),
  id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
let bridge;
export async function storageCore() {
  if (!bridge) {
    const built = new URL(
      "../_build/js/release/build/cmd/storage/storage.js",
      import.meta.url,
    );
    if (!fs.existsSync(built))
      throw new Error("Build storage core first: npm run build");
    await import(built.href);
    bridge = globalThis.__moonrestore_storage;
    if (!bridge) throw new Error("Storage bridge unavailable");
  }
  return (action, args = {}, bytes = empty) => {
    const request = {
      action,
      session: "",
      sequence: 0,
      previous: "",
      count: 0,
      entries: "0",
      chunks: "0",
      total: "0",
      ...args,
    };
    const reply = JSON.parse(bridge.command(JSON.stringify(request), bytes));
    if (!reply.ok) throw new Error("MoonBit storage validation rejected");
    return reply.value;
  };
}
export function decodeJson(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function bounded(file, limit, { ownedAlias } = {}) {
  const full = checked(file),
    before = fs.lstatSync(full, { bigint: true });
  const alias =
    ownedAlias === undefined
      ? null
      : fs.lstatSync(checked(ownedAlias), { bigint: true });
  const linked =
    alias &&
    before.nlink === 2n &&
    alias.nlink === 2n &&
    alias.isFile() &&
    before.dev === alias.dev &&
    before.ino === alias.ino &&
    full !== path.resolve(ownedAlias);
  if (
    !before.isFile() ||
    (before.nlink !== 1n && !linked) ||
    before.size > BigInt(limit)
  )
    throw new Error("Paged input is not a bounded regular file");
  const fd = fs.openSync(
    full,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== before.nlink
    )
      throw new Error("Paged input changed");
    const bytes = Buffer.alloc(Number(opened.size));
    let position = 0;
    while (position < bytes.length) {
      const n = fs.readSync(
        fd,
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (!n) throw new Error("Truncated paged input");
      position += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      after.nlink !== opened.nlink
    )
      throw new Error("Paged input changed during read");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
export function newFile(file, bytes) {
  checked(path.dirname(file));
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function syncDirectory(folder) {
  if (process.platform !== "win32") {
    const fd = fs.openSync(folder, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export class PagedStore {
  static async create(
    repository,
    { encrypted = false, fidelity = false, environment = process.env } = {},
  ) {
    if (typeof encrypted !== "boolean" || typeof fidelity !== "boolean")
      throw new Error("Encrypted flag required");
    const target = checked(repository, false),
      parent = checked(path.dirname(target));
    if (fs.existsSync(target))
      throw new Error("Paged repository target must not exist");
    const { storageCapabilities } = await import("./storage-capabilities.mjs");
    if (!storageCapabilities(parent).ok)
      throw new Error(
        "Format4 requires verified conditional hardlinks and exclusive publication; filesystem unsupported",
      );
    const core = await storageCore(),
      vault = encrypted ? createVault(environment.MOONRESTORE_PASSWORD) : null;
    const stage = fs.mkdtempSync(path.join(parent, ".moonrestore-paged-init-"));
    try {
      for (const d of ["pages", "packs", "snapshots", "tmp", "trash"])
        fs.mkdirSync(path.join(stage, d), { mode: 0o700 });
      newFile(path.join(stage, "repository-id"), Buffer.from(randomUUID()));
      newFile(
        path.join(stage, "moonrestore"),
        Buffer.from(
          fidelity
            ? encrypted
              ? "moonrestore-fidelity-encrypted-v5\n"
              : "moonrestore-fidelity-repository-v5\n"
            : encrypted
              ? "moonrestore-paged-encrypted-v4\n"
              : "moonrestore-paged-repository-v4\n",
        ),
      );
      if (vault)
        newFile(
          path.join(stage, "encryption.json"),
          Buffer.from(JSON.stringify(vault.config)),
        );
      syncDirectory(stage);
      publishDirectory(stage, target);
      syncDirectory(parent);
      return {
        ok: true,
        repository: target,
        format: fidelity ? 5 : 4,
        encrypted,
        legacy_modified: false,
      };
    } finally {
      vault?.key.fill(0);
      if (fs.existsSync(stage)) {
        for (const n of fs.readdirSync(stage)) {
          const p = path.join(stage, n);
          if (fs.lstatSync(p).isDirectory()) fs.rmdirSync(p);
          else fs.unlinkSync(p);
        }
        fs.rmdirSync(stage);
      }
    }
  }
  static async open(repository, { environment = process.env } = {}) {
    const core = await storageCore(),
      repo = checked(repository),
      magic = bounded(path.join(repo, "moonrestore"), 64).toString();
    if (
      ![
        "moonrestore-paged-repository-v4\n",
        "moonrestore-paged-encrypted-v4\n",
        "moonrestore-fidelity-repository-v5\n",
        "moonrestore-fidelity-encrypted-v5\n",
      ].includes(magic)
    )
      throw new Error("Explicit format-4/5 repository required");
    for (const d of ["pages", "packs", "snapshots", "tmp", "trash"])
      if (!fs.lstatSync(checked(path.join(repo, d))).isDirectory())
        throw new Error("Invalid paged layout");
    const repoId = bounded(path.join(repo, "repository-id"), 64).toString();
    if (!/^[a-f0-9-]{36}$/.test(repoId))
      throw new Error("Invalid repository identity");
    const vault = magic.includes("encrypted")
      ? decodeJson(bounded(path.join(repo, "encryption.json"), 4096))
      : null;
    const key = vault ? unlockVault(vault, environment) : null;
    const store = new PagedStore(repo, repoId, core, vault, key);
    store.format = magic.includes("v5") ? 5 : 4;
    return store;
  }
  constructor(repo, repoId, core, vault, key) {
    this.repo = repo;
    this.repoId = repoId;
    this.core = core;
    this.vault = vault;
    this.key = key;
    this.locked = false;
    this.lastPack = null;
  }
  logical(bytes) {
    return this.core("digest", {}, bytes);
  }
  file(kind, digest) {
    if (!id(digest) || !["page", "pack", "snapshot"].includes(kind))
      throw new Error("Invalid paged identity");
    return checked(
      path.join(
        this.repo,
        { page: "pages", pack: "packs", snapshot: "snapshots" }[kind],
        storageId(this.key, kind, digest),
      ),
      false,
    );
  }
  encode(kind, digest, bytes) {
    return this.key
      ? seal(this.key, this.vault, kind, digest, bytes)
      : Buffer.from(bytes);
  }
  decode(kind, digest, bytes) {
    if (!this.key) return bytes;
    const item = unseal(
      this.key,
      this.vault,
      kind,
      storageId(this.key, kind, digest),
      bytes,
    );
    if (item.id !== digest) throw new Error("Paged envelope identity mismatch");
    return item.bytes;
  }
  read(kind, digest) {
    const maximum =
      kind === "pack" ? PACK_LIMIT + 32 : kind === "page" ? PAGE_LIMIT : 65536;
    const bytes = this.decode(
      kind,
      digest,
      bounded(this.file(kind, digest), maximum + 64),
    );
    if (kind !== "pack" && this.logical(bytes) !== digest)
      throw new Error("Paged content SHA-256 mismatch");
    return bytes;
  }
  write(kind, digest, bytes) {
    if (!this.locked) throw new Error("Paged writer lock required");
    const final = this.file(kind, digest);
    if (fs.existsSync(final)) {
      if (kind === "pack") this.pack(digest);
      else this.read(kind, digest);
      return false;
    }
    const temporary = path.join(
      this.repo,
      "tmp",
      kind +
        "-" +
        storageId(this.key, kind, digest) +
        "-" +
        randomUUID() +
        ".part",
    );
    newFile(temporary, this.encode(kind, digest, bytes));
    this.fail("stored");
    fs.linkSync(temporary, final);
    this.fail("stored-linked");
    fs.unlinkSync(temporary);
    syncDirectory(path.dirname(final));
    this.fail("stored-visible");
    return true;
  }
  fail(stage) {
    checkpoint("paged_" + stage);
    const io = process.env.MOONRESTORE_TEST_IO?.split(":");
    if (
      io?.[1] === stage &&
      ["ENOSPC", "EIO", "EACCES", "EROFS"].includes(io[0])
    )
      throw Object.assign(new Error("Controlled IO fault " + io[0]), {
        code: io[0],
      });
    if (process.env.MOONRESTORE_TEST_FAILURE === "paged-" + stage)
      throw new Error("Injected paged failure at " + stage);
    if (process.env.MOONRESTORE_TEST_CRASH === "paged-" + stage)
      process.exit(86);
  }
  lock({ allowPending = false, operation } = {}) {
    if (
      !allowPending &&
      fs.existsSync(path.join(this.repo, ".gc-pending.json"))
    )
      throw new Error("Interrupted paged maintenance; use paged-recover");
    const lock = path.join(this.repo, ".lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    this.locked = true;
    try {
      newFile(
        path.join(lock, "owner.json"),
        Buffer.from(
          JSON.stringify({
            pid: process.pid,
            host: os.hostname(),
            repository: this.repoId,
            ...(operation ? { operation } : {}),
          }),
        ),
      );
    } catch (error) {
      this.locked = false;
      fs.rmdirSync(lock);
      throw error;
    }
  }
  unlock() {
    if (this.locked) {
      fs.unlinkSync(checked(path.join(this.repo, ".lock", "owner.json")));
      fs.rmdirSync(path.join(this.repo, ".lock"));
      this.locked = false;
    }
  }
  close() {
    try {
      this.unlock();
    } finally {
      this.key?.fill(0);
      this.lastPack = null;
    }
  }
  pack(digest) {
    const file = this.file("pack", digest),
      stat = fs.lstatSync(checked(file), { bigint: true });
    const observed = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.nlink,
    ]
      .map(String)
      .join(":");
    if (this.lastPack?.id === digest && this.lastPack.observed === observed)
      return this.lastPack.raw;
    const encoded = this.read("pack", digest);
    if (
      encoded.length < 9 ||
      encoded.toString("ascii", 0, 4) !== "MRP4" ||
      ![0, 1].includes(encoded[4])
    )
      throw new Error("Invalid object pack envelope");
    const size = encoded.readUInt32LE(5);
    if (size < 6 || size > PACK_LIMIT) throw new Error("Pack expansion budget");
    const raw = encoded[4]
      ? inflateSync(encoded.subarray(9), { maxOutputLength: PACK_LIMIT })
      : encoded.subarray(9);
    if (
      raw.length !== size ||
      raw.subarray(0, 6).toString() !== "MRPK4\n" ||
      this.logical(raw) !== digest
    )
      throw new Error("Object pack checksum mismatch");
    this.lastPack = { id: digest, raw, observed };
    return raw;
  }
  chunk(record) {
    checkpoint("paged_chunk_verify");
    const raw = this.pack(record.pack),
      at = record.offset,
      length = Number(record.size);
    if (
      !Number.isInteger(at) ||
      at < 6 ||
      !Number.isInteger(length) ||
      length < 1 ||
      length > 1048576 ||
      at + 36 + length > raw.length ||
      raw.readUInt32LE(at) !== length ||
      raw.subarray(at + 4, at + 36).toString("hex") !== record.id
    )
      throw new Error("Object pack location mismatch");
    const bytes = raw.subarray(at + 36, at + 36 + length);
    if (this.logical(bytes) !== record.id)
      throw new Error("Chunk checksum mismatch");
    return bytes;
  }
  root(snapshot) {
    const root = decodeJson(this.read("snapshot", snapshot));
    const keys = [
      "format",
      "repository",
      "created",
      "label",
      "pages",
      "last_page",
      "entries",
      "chunks",
      "bytes",
      "excludes",
      ...(this.format === 5 ? ["fidelity"] : []),
    ];
    if (
      Object.keys(root).some((k) => !keys.includes(k)) ||
      root.format !== (this.format ?? 4) ||
      (this.format === 5 && !root.fidelity) ||
      root.repository !== this.repoId ||
      typeof root.created !== "string" ||
      !Number.isFinite(Date.parse(root.created)) ||
      typeof root.label !== "string" ||
      root.label.length > 200 ||
      !Number.isSafeInteger(root.pages) ||
      root.pages < 0 ||
      root.pages > 1000000 ||
      !Number.isSafeInteger(root.entries) ||
      root.entries < 0 ||
      root.entries > 1000000 ||
      !Number.isSafeInteger(root.chunks) ||
      root.chunks < 0 ||
      root.chunks > 32000000 ||
      typeof root.bytes !== "string" ||
      !/^(0|[1-9][0-9]{0,12})$/.test(root.bytes) ||
      BigInt(root.bytes) > 1099511627776n ||
      (root.pages === 0
        ? root.last_page !== "" ||
          root.entries !== 0 ||
          root.chunks !== 0 ||
          root.bytes !== "0"
        : !id(root.last_page))
    )
      throw new Error("Invalid paged snapshot root");
    if (
      !Array.isArray(root.excludes) ||
      root.excludes.length > 64 ||
      Buffer.byteLength(JSON.stringify(root.excludes)) > 8192
    )
      throw new Error("Invalid paged excludes");
    for (const value of root.excludes) this.core("path", { session: value });
    return root;
  }
  *snapshotCandidates() {
    const dir = fs.opendirSync(path.join(this.repo, "snapshots"));
    try {
      for (let item = dir.readSync(); item; item = dir.readSync()) {
        if (!item.isFile() || !id(item.name))
          throw new Error("Unexpected paged snapshot member");
        if (!this.key) yield { id: item.name };
        else {
          try {
            const raw = bounded(
                path.join(this.repo, "snapshots", item.name),
                65600,
              ),
              value = unseal(this.key, this.vault, "snapshot", item.name, raw);
            if (this.logical(value.bytes) !== value.id)
              throw new Error("Snapshot identity mismatch");
            yield { id: value.id };
          } catch {
            yield { damaged: true, physical: item.name };
          }
        }
      }
    } finally {
      dir.closeSync();
    }
  }
  *snapshots() {
    for (const candidate of this.snapshotCandidates()) {
      if (candidate.damaged) throw new Error("Damaged encrypted snapshot root");
      yield candidate.id;
    }
  }
}

export class PagedIndex {
  constructor(store) {
    this.store = store;
    const parent = mkdirPrivate(path.join(stateHome(), "paged-indexes"));
    this.folder = fs.mkdtempSync(path.join(parent, "index-"));
    this.parent = parent;
    this.db = new DatabaseSync(path.join(this.folder, "index.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA max_page_count=2097152; CREATE TABLE pages(seq INTEGER PRIMARY KEY,payload BLOB NOT NULL); CREATE TABLE paths(k TEXT PRIMARY KEY,kind TEXT NOT NULL); CREATE TABLE objects(k TEXT PRIMARY KEY,payload BLOB NOT NULL); CREATE TABLE source(seq INTEGER PRIMARY KEY,payload BLOB NOT NULL); CREATE TABLE live(k TEXT PRIMARY KEY);",
    );
    // One private disposable transaction avoids a durable fsync for every cache
    // row. Nothing ever reuses this index after restart; close rolls it back.
    // Repository objects and roots retain their separate durability barriers.
    this.db.exec("BEGIN IMMEDIATE");
  }
  key(kind, value) {
    return storageId(
      this.store.key,
      "cache-" + kind,
      this.store.logical(Buffer.from(String(value))),
    );
  }
  encode(kind, key, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    return this.store.key
      ? seal(
          this.store.key,
          this.store.vault,
          "cache-" + kind,
          this.store.logical(Buffer.from(String(key))),
          bytes,
        )
      : bytes;
  }
  decode(kind, key, bytes) {
    if (!bytes) throw new Error("Index record missing");
    const value = this.store.key
      ? unseal(
          this.store.key,
          this.store.vault,
          "cache-" + kind,
          storageId(
            this.store.key,
            "cache-" + kind,
            this.store.logical(Buffer.from(String(key))),
          ),
          Buffer.from(bytes),
        ).bytes
      : bytes;
    return decodeJson(value);
  }
  put(table, key, value) {
    if (!["pages", "objects", "source"].includes(table))
      throw new Error("Index table");
    this.db
      .prepare("INSERT OR REPLACE INTO " + table + " VALUES(?,?)")
      .run(key, this.encode(table, key, value));
    if (table === "objects") this.onObject?.(key, value);
  }
  get(table, key) {
    if (!["pages", "objects", "source"].includes(table))
      throw new Error("Index table");
    const row = this.db
      .prepare(
        "SELECT payload FROM " +
          table +
          " WHERE " +
          (table === "objects" ? "k" : "seq") +
          "=?",
      )
      .get(key);
    return row
      ? this.decode(table, key, row.payload)
      : table === "objects"
        ? (this.lookupObject?.(key) ?? null)
        : null;
  }
  path(relative, kind) {
    const parent = relative.includes("/")
      ? relative.slice(0, relative.lastIndexOf("/"))
      : "";
    if (parent) {
      const found = this.db
        .prepare("SELECT kind FROM paths WHERE k=?")
        .get(this.key("path", parent.toLowerCase()));
      if (found?.kind !== "dir")
        throw new Error("Missing or non-directory parent");
    }
    this.db
      .prepare("INSERT INTO paths VALUES(?,?)")
      .run(this.key("path", relative.toLowerCase()), kind);
  }
  clearSnapshot() {
    this.db.exec("DELETE FROM pages; DELETE FROM paths;");
  }
  close() {
    this.db.close();
    const exact = checked(this.folder);
    if (
      path.dirname(exact) !== this.parent ||
      !path.basename(exact).startsWith("index-")
    )
      throw new Error("Unsafe index cleanup");
    for (const name of fs.readdirSync(exact)) {
      const p = path.join(exact, name);
      if (!fs.lstatSync(p).isFile() || fs.lstatSync(p).isSymbolicLink())
        throw new Error("Unexpected temporary index member");
      fs.unlinkSync(p);
    }
    fs.rmdirSync(exact);
  }
}

export function pageFrom(store, digest) {
  const bytes = store.read("page", digest),
    page = decodeJson(bytes);
  if (
    !page ||
    Object.keys(page).some(
      (k) => !["format", "sequence", "previous", "records"].includes(k),
    ) ||
    page.format !== 4 ||
    !Array.isArray(page.records)
  )
    throw new Error("Invalid page shape");
  store.core(
    "page",
    {
      sequence: page.sequence,
      previous: page.previous,
      count: page.records.length,
    },
    bytes,
  );
  return page;
}
export function indexSnapshot(
  store,
  index,
  snapshot,
  { verifyContents = true, verifyObjects = true } = {},
) {
  if (verifyContents && !verifyObjects)
    throw new Error("Content verification requires object reads");
  index.clearSnapshot();
  const root = store.root(snapshot),
    ledger = randomUUID(),
    fileHash = randomUUID();
  store.core("ledger-new", { session: ledger });
  try {
    let next = root.last_page;
    for (let seq = root.pages - 1; seq >= 0; seq--) {
      store.fail("read-page");
      const page = pageFrom(store, next);
      if (page.sequence !== seq) throw new Error("Page sequence mismatch");
      index.put("pages", seq, { id: next });
      index.db
        .prepare("INSERT OR IGNORE INTO live VALUES(?)")
        .run("page:" + storageId(store.key, "page", next));
      next = page.previous;
    }
    if (next !== "") throw new Error("Manifest chain did not terminate");
    for (let seq = 0; seq < root.pages; seq++) {
      const page = pageFrom(store, index.get("pages", seq).id);
      for (const record of page.records) {
        if (
          !record ||
          Object.keys(record).some(
            (k) =>
              ![
                "kind",
                "path",
                "id",
                "size",
                "pack",
                "offset",
                "mtime_ms",
                "mode",
              ].includes(k),
          ) ||
          typeof record.size !== "string" ||
          !/^(0|[1-9][0-9]{0,12})$/.test(record.size)
        )
          throw new Error("Invalid paged record shape");
        store.core("ledger-record", { session: ledger, record });
        if (record.kind === "file" || record.kind === "dir") {
          if (
            typeof record.mtime_ms !== "string" ||
            !/^(0|[1-9][0-9]{0,14})$/.test(record.mtime_ms) ||
            BigInt(record.mtime_ms) > 253402300799000n ||
            !Number.isInteger(record.mode) ||
            record.mode < 0 ||
            record.mode > 511
          )
            throw new Error("Invalid paged attributes");
          index.path(record.path, record.kind);
          if (record.kind === "file" && verifyContents)
            store.core("hash-new", { session: fileHash });
        } else if (record.kind === "chunk") {
          if (verifyObjects) {
            const bytes = store.chunk(record);
            if (verifyContents)
              store.core("hash-push", { session: fileHash }, bytes);
          }
          index.put("objects", index.key("object", record.id), record);
          index.db
            .prepare("INSERT OR IGNORE INTO live VALUES(?)")
            .run("pack:" + storageId(store.key, "pack", record.pack));
        } else if (record.kind === "end" && verifyContents) {
          if (store.core("hash-finish", { session: fileHash }) !== record.id)
            throw new Error("Paged file checksum mismatch");
        }
      }
    }
    store.core("ledger-finish", {
      session: ledger,
      entries: String(root.entries),
      chunks: String(root.chunks),
      total: root.bytes,
    });
    if (root.fidelity) indexFidelity(store, index, root);
    return root;
  } finally {
    store.core("close", { session: ledger });
    store.core("close", { session: fileHash });
  }
}
