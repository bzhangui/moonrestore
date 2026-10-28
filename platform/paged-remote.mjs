// Ciphertext-only paged receipts. The caller pins the final receipt digest and
// each child page/member is pinned to its own checksum plus reported version.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  PagedStore,
  PagedIndex,
  bounded,
  newFile,
  syncDirectory,
} from "./paged-store.mjs";
import { physicalMembers, layoutFolders } from "./paged-copy.mjs";
import { verifyPaged } from "./paged-operations.mjs";
import { checked } from "./vault.mjs";
import { publishDirectory } from "./adapter.mjs";
import { credentials, checkpoint } from "./activity.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex"),
  id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const safe = (p) =>
  ["moonrestore", "repository-id", "encryption.json"].includes(p) ||
  /^(pages|packs|snapshots)\/[a-f0-9]{64}$/.test(p);
export async function pushPaged(
  repository,
  snapshot,
  backend,
  { prefix = "moonrestore" } = {},
) {
  if (!id(snapshot) || !/^[A-Za-z0-9_-]{1,64}$/.test(prefix))
    throw new Error("Invalid paged remote scope");
  const store = await PagedStore.open(repository, {
      environment: { ...process.env, ...credentials(repository) },
    }),
    index = new PagedIndex(store);
  try {
    if (!store.key) throw new Error("Plaintext remote upload refused");
    store.lock();
    const namespace = prefix + "/" + store.vault.id,
      pages = [];
    let page = [],
      members = 0,
      bytes = 0,
      retention = true;
    const flush = async () => {
      if (!page.length) return;
      const raw = Buffer.from(JSON.stringify(page));
      if (raw.length > 262144 || pages.length >= 4096)
        throw new Error("Remote page budget");
      const checksum = sha(raw),
        key = namespace + "/receipt-pages/" + checksum,
        stored = await backend.putImmutable(key, raw);
      pages.push({ key, ...stored });
      page = [];
    };
    for (const relative of physicalMembers(store, index, [snapshot])) {
      checkpoint("paged_remote_copy", { members });
      const raw = bounded(path.join(store.repo, relative), 8388704);
      bytes += raw.length;
      if (bytes > 2199023255552 || ++members > 524288)
        throw new Error("Remote member/byte budget");
      const key = namespace + "/content/" + sha(raw),
        stored = await backend.putImmutable(key, raw);
      retention &&= stored.server_retention_reported === true;
      page.push({ path: relative, key, ...stored });
      if (page.length === 128) await flush();
    }
    await flush();
    const raw = Buffer.from(
      JSON.stringify({
        format: 2,
        kind: "moonrestore_paged_encrypted_snapshot",
        snapshot,
        encrypted: true,
        pages,
        members,
        bytes: String(bytes),
        physical_independence_verified: false,
      }),
    );
    if (raw.length > 2097152) throw new Error("Remote root budget");
    const checksum = sha(raw),
      key = namespace + "/receipts/" + checksum + ".json",
      commit = await backend.putImmutable(key, raw);
    return {
      ok: true,
      kind: "s3_snapshot_copy",
      snapshot,
      receipt_key: key,
      receipt_checksum: checksum,
      receipt_version: commit.version,
      members,
      server_retention_reported: retention && commit.server_retention_reported,
      real_cloud_provider_verified: false,
      deletions_propagated: false,
    };
  } finally {
    index.close();
    store.close();
  }
}
export async function restorePagedRemote(backend, record, destination) {
  if (
    record.format !== 2 ||
    record.kind !== "moonrestore_paged_encrypted_snapshot" ||
    record.encrypted !== true ||
    !id(record.snapshot) ||
    !Array.isArray(record.pages) ||
    !record.pages.length ||
    record.pages.length > 4096 ||
    !Number.isSafeInteger(record.members) ||
    record.members < 4 ||
    record.members > 524288
  )
    throw new Error("Invalid paged remote root");
  const dest = checked(destination, false),
    parent = checked(path.dirname(dest));
  if (fs.existsSync(dest)) throw new Error("NEW remote repository required");
  const stage = fs.mkdtempSync(path.join(parent, ".moonrestore-paged-remote-"));
  layoutFolders(stage);
  let members = 0,
    total = 0,
    roots = 0;
  // SQLite on disk bounds the receipt deduplication set and guards conflicting paths.
  const { DatabaseSync } = await import("node:sqlite"),
    db = new DatabaseSync(path.join(stage, "receipt.sqlite"));
  db.exec(
    "PRAGMA cache_size=-2048; PRAGMA max_page_count=262144; CREATE TABLE names(p TEXT PRIMARY KEY); BEGIN;",
  );
  try {
    for (const ref of record.pages) {
      if (
        !id(ref.checksum) ||
        !Number.isSafeInteger(Number(ref.size)) ||
        Number(ref.size) > 262144
      )
        throw new Error("Invalid remote receipt page");
      const fetched = await backend.get(ref.key, {
        version: ref.version,
        checksum: ref.checksum,
      });
      if (fetched.bytes.length !== Number(ref.size))
        throw new Error("Remote page size mismatch");
      const page = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes),
      );
      if (!Array.isArray(page) || !page.length || page.length > 128)
        throw new Error("Remote receipt page shape");
      for (const m of page) {
        checkpoint("paged_remote_restore", { members });
        if (
          !safe(m.path) ||
          !id(m.checksum) ||
          !/^[1-9][0-9]{0,7}$/.test(m.size) ||
          Number(m.size) > 8388704 ||
          ++members > record.members ||
          (total += Number(m.size)) > 2199023255552
        )
          throw new Error("Invalid remote member");
        db.prepare("INSERT INTO names VALUES(?)").run(m.path);
        const raw = (
          await backend.get(m.key, { version: m.version, checksum: m.checksum })
        ).bytes;
        if (raw.length !== Number(m.size))
          throw new Error("Remote member size mismatch");
        newFile(path.join(stage, m.path), raw);
        if (m.path.startsWith("snapshots/")) roots++;
      }
    }
    if (
      members !== record.members ||
      String(total) !== record.bytes ||
      roots !== 1 ||
      !["moonrestore", "encryption.json", "repository-id"].every((p) =>
        db.prepare("SELECT 1 FROM names WHERE p=?").get(p),
      )
    )
      throw new Error("Remote receipt incomplete");
  } finally {
    db.close();
    fs.unlinkSync(path.join(stage, "receipt.sqlite"));
  }
  const env = { ...process.env, ...credentials(destination) };
  await verifyPaged(stage, record.snapshot, { environment: env });
  syncDirectory(stage);
  publishDirectory(stage, dest);
  syncDirectory(parent);
  return {
    ok: true,
    kind: "s3_snapshot_restore",
    snapshot: record.snapshot,
    members,
    full_snapshot_audit: true,
    source_receipt_pinned: true,
    destination: dest,
    real_cloud_provider_verified: false,
    physical_host_independence_verified: false,
  };
}
