// Authenticated private hints, never a deletion authority or a substitute for
// reading/verifying a reused chunk. Losing the cache only costs a rebuild.
import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
  seal,
  unseal,
  storageId,
} from "./vault.mjs";
import { indexSnapshot } from "./paged-store.mjs";
import { checkpoint } from "./activity.mjs";
export function pagedBinding(store) {
  const s = fs.statSync(checked(store.repo), { bigint: true });
  return store.logical(
    Buffer.from(
      JSON.stringify({
        root:
          process.platform === "win32" ? store.repo.toLowerCase() : store.repo,
        dev: String(s.dev),
        ino: String(s.ino),
        repository: store.repoId,
        vault: store.vault?.id ?? null,
      }),
    ),
  );
}
export function fileFingerprint(file) {
  const s = fs.lstatSync(checked(file), { bigint: true });
  if (!s.isFile() || s.nlink !== 1n) throw new Error("Unsafe cache source");
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
}
export class PagedCache {
  constructor(store) {
    this.store = store;
    this.binding = pagedBinding(store);
    this.invalid = 0;
    this.disabled = false;
    try {
      this.folder = mkdirPrivate(
        path.join(stateHome(), "paged-caches-v1", this.binding),
      );
      const key = path.join(this.folder, "integrity.key");
      if (!fs.existsSync(key)) writePrivate(key, randomBytes(32));
      this.key = readPrivate(key, 32);
      if (this.key.length !== 32) throw new Error("Cache integrity key");
      const file = checked(path.join(this.folder, "cache.sqlite"), false);
      if (fs.existsSync(file)) {
        const s = fs.lstatSync(file);
        if (!s.isFile() || s.nlink !== 1 || s.size > 1073741824)
          throw new Error("Cache file budget");
      }
      this.db = new DatabaseSync(file);
      if (process.platform !== "win32") fs.chmodSync(file, 0o600);
      this.db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA max_page_count=262144; CREATE TABLE IF NOT EXISTS hints(k TEXT PRIMARY KEY,payload BLOB NOT NULL,mac TEXT NOT NULL); BEGIN IMMEDIATE;",
      );
    } catch {
      this.disabled = true;
      this.invalid++;
      try {
        this.db?.close();
      } catch {}
      this.db = null;
      this.key?.fill(0);
    }
  }
  purpose(k) {
    return this.store.logical(Buffer.from(this.binding + "\n" + k));
  }
  mac(k, payload) {
    return createHmac("sha256", this.key)
      .update(this.binding + "\n" + k + "\n")
      .update(payload)
      .digest();
  }
  get(k) {
    if (this.disabled) return null;
    try {
      const r = this.db
        .prepare("SELECT payload,mac FROM hints WHERE k=?")
        .get(k);
      if (!r) return null;
      const raw = Buffer.from(r.payload),
        expected = this.mac(k, raw),
        given = Buffer.from(r.mac, "hex");
      if (
        raw.length > 262144 ||
        given.length !== 32 ||
        !timingSafeEqual(given, expected)
      )
        throw new Error("Cache authentication");
      const digest = this.purpose(k),
        bytes = this.store.key
          ? unseal(
              this.store.key,
              this.store.vault,
              "persistent-cache",
              storageId(this.store.key, "persistent-cache", digest),
              raw,
            ).bytes
          : raw;
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      this.invalid++;
      this.delete(k);
      return null;
    }
  }
  put(k, value) {
    if (this.disabled) return;
    try {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 262000) throw new Error("Cache row budget");
      const raw = this.store.key
        ? seal(
            this.store.key,
            this.store.vault,
            "persistent-cache",
            this.purpose(k),
            bytes,
          )
        : bytes;
      this.db
        .prepare("INSERT OR REPLACE INTO hints VALUES(?,?,?)")
        .run(k, raw, this.mac(k, raw).toString("hex"));
    } catch {
      this.invalid++;
      this.disabled = true;
    }
  }
  delete(k) {
    if (this.db)
      try {
        this.db.prepare("DELETE FROM hints WHERE k=?").run(k);
      } catch {
        this.disabled = true;
      }
  }
  savepoint() {
    if (!this.disabled) this.db.exec("SAVEPOINT history");
  }
  release(ok) {
    if (!this.disabled) {
      if (!ok) this.db.exec("ROLLBACK TO history");
      this.db.exec("RELEASE history");
    }
  }
  commit() {
    if (this.db && !this.disabled) {
      this.db.exec("COMMIT; BEGIN IMMEDIATE;");
    }
  }
  close() {
    try {
      this.db?.close();
    } finally {
      this.key?.fill(0);
    }
  }
}
export function loadHistory(store, index, { cache, full = false } = {}) {
  const summary = {
    fully_checked: 0,
    cached_roots: 0,
    damaged_roots: 0,
    cache_invalid: 0,
  };
  index.lookupObject = (k) => cache?.get("object:" + k) ?? null;
  index.onObject = (k, v) => cache?.put("object:" + k, v);
  for (const candidate of store.snapshotCandidates()) {
    checkpoint("paged_history_inventory");
    if (candidate.damaged) {
      summary.damaged_roots++;
      continue;
    }
    const snapshot = candidate.id;
    const key = "root:" + snapshot;
    let failed = false;
    try {
      store.root(snapshot);
      const observed = fileFingerprint(store.file("snapshot", snapshot)),
        receipt = cache?.get(key);
      const age = Date.now() - receipt?.audited;
      if (
        !full &&
        receipt?.observed === observed &&
        receipt.snapshot === snapshot &&
        Number.isSafeInteger(age) &&
        age >= 0 &&
        age < 86400000
      ) {
        summary.cached_roots++;
        continue;
      }
      index.db.exec("SAVEPOINT history");
      cache?.savepoint();
      try {
        indexSnapshot(store, index, snapshot);
        cache?.put(key, { snapshot, observed, audited: Date.now() });
        summary.fully_checked++;
      } catch {
        failed = true;
        index.db.exec("ROLLBACK TO history");
        cache?.delete(key);
        summary.damaged_roots++;
      } finally {
        index.db.exec("RELEASE history");
        cache?.release(!failed);
        if (failed) cache?.delete(key);
      }
    } catch {
      cache?.delete(key);
      summary.damaged_roots++;
    }
  }
  index.clearSnapshot();
  summary.cache_invalid = cache?.invalid ?? 0;
  return summary;
}
