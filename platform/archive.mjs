// Bounded, checksum-pinned transport archive. NOT a replacement live repository
// format: imports are fully audited before publishing a new legacy repository.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { checked, readPrivate, writePrivate } from "./vault.mjs";
import {
  core,
  openHost,
  hash,
  fingerprint,
  validatedInventory,
  options,
} from "./maintenance.mjs";
import { publishDirectory } from "./adapter.mjs";
import { credentials, checkpoint } from "./activity.mjs";
import { repositoryKind } from "./repository-kind.mjs";
import { PagedStore, PagedIndex } from "./paged-store.mjs";
import { physicalMembers } from "./paged-copy.mjs";
import { verifyPaged } from "./paged-operations.mjs";
const maxSegment = 1048576,
  maxPage = 4194304,
  maxRoot = 2097152;
const id = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const member = (s, paged = false) =>
  s === "moonrestore" ||
  s === "encryption.json" ||
  s === "repository-id" ||
  (paged
    ? /^(snapshots|pages|packs)\/[a-f0-9]{64}$/.test(s)
    : /^snapshots\/[a-f0-9]{64}\.json$/.test(s)) ||
  (!paged &&
    /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(s) &&
    s.slice(8, 10) === s.slice(11, 13));

async function archiveSource(repository) {
  if (!repositoryKind(repository).paged)
    return {
      inventory: await validatedInventory(repository),
      h: openHost(repository, {
        environment: {
          ...process.env,
          ...credentials(repository),
          MOONRESTORE_READ_ONLY: "1",
        },
      }),
      paged: false,
    };
  const store = await PagedStore.open(repository, {
    environment: { ...process.env, ...credentials(repository) },
  });
  let index;
  try {
    store.lock();
    index = new PagedIndex(store);
    const snapshots = [];
    for (const id of store.snapshots()) {
      if (snapshots.length >= 1000) throw new Error("Archive snapshot budget");
      snapshots.push(id);
    }
    if (!snapshots.length)
      throw new Error("Archive requires at least one snapshot");
    return {
      paged: true,
      format: store.format,
      snapshots,
      members: () => physicalMembers(store, index, snapshots),
      inventory: { before: fingerprint(repository) },
      h: {
        repo: store.repo,
        key: store.key,
        clean() {
          try {
            index.close();
          } finally {
            store.close();
          }
        },
      },
    };
  } catch (error) {
    try {
      index?.close();
    } finally {
      store.close();
    }
    throw error;
  }
}
function newStage(destination, source) {
  const dest = checked(destination, false),
    parent = checked(path.dirname(dest)),
    canon = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const a = canon(dest),
    b = canon(checked(source));
  if (
    fs.existsSync(dest) ||
    a === b ||
    a.startsWith(b + path.sep) ||
    b.startsWith(a + path.sep)
  )
    throw new Error("New non-overlapping archive/repository required");
  const stage = path.join(parent, ".moonrestore-" + randomUUID() + ".partial");
  fs.mkdirSync(stage, { mode: 0o700 });
  return { dest, stage };
}
function immutable(file, bytes) {
  if (fs.existsSync(file)) {
    if (hash(readPrivate(file, maxSegment + 128)) !== hash(bytes))
      throw new Error("Archive segment collision");
    return;
  }
  writePrivate(file, bytes);
}
export async function exportArchive(
  repository,
  destination,
  { compress = true } = {},
) {
  if (typeof compress !== "boolean")
    throw new Error("Invalid compression option");
  const prepared = await archiveSource(repository),
    { inventory, h } = prepared;
  let target;
  try {
    target = newStage(destination, repository);
  } catch (error) {
    h.clean();
    throw error;
  }
  const { dest, stage } = target;
  try {
    fs.mkdirSync(path.join(stage, "segments"));
    fs.mkdirSync(path.join(stage, "pages"));
    let page = [],
      pages = [],
      members = 0,
      rawBytes = 0,
      storedBytes = 0;
    const seen = new Set();
    const flush = () => {
      if (!page.length) return;
      const bytes = Buffer.from(JSON.stringify(page));
      if (bytes.length > maxPage || pages.length >= 2000)
        throw new Error("Archive page budget");
      const digest = hash(bytes);
      writePrivate(path.join(stage, "pages", digest), bytes);
      pages.push({ id: digest, bytes: bytes.length, count: page.length });
      page = [];
    };
    const add = (relative) => {
      if (seen.has(relative)) return;
      if (!member(relative, prepared.paged) || ++members > 100000)
        throw new Error("Archive member budget");
      seen.add(relative);
      checkpoint("archive_export", { members });
      const file = checked(path.join(h.repo, ...relative.split("/"))),
        s = fs.lstatSync(file);
      if (!s.isFile() || s.nlink !== 1 || s.size > 33554496)
        throw new Error("Invalid archive input");
      const fd = fs.openSync(file, "r"),
        parts = [];
      let offset = 0;
      try {
        do {
          const bytes = Buffer.alloc(Math.min(maxSegment, s.size - offset)),
            n = bytes.length
              ? fs.readSync(fd, bytes, 0, bytes.length, offset)
              : 0;
          if (n !== bytes.length) throw new Error("Archive input truncated");
          const packed = compress ? deflateRawSync(bytes) : bytes,
            use = packed.length + 64 < bytes.length,
            data = use ? packed : bytes,
            digest = hash(data);
          immutable(path.join(stage, "segments", digest), data);
          parts.push({
            id: digest,
            codec: use ? "deflate" : "raw",
            bytes: n,
            stored: data.length,
            plain: hash(bytes),
          });
          rawBytes += n;
          storedBytes += data.length;
          offset += n;
        } while (offset < s.size);
      } finally {
        fs.closeSync(fd);
      }
      page.push({ path: relative, bytes: s.size, parts });
      if (page.length >= 64) flush();
    };
    add("moonrestore");
    if (h.key) add("encryption.json");
    if (fs.existsSync(path.join(h.repo, "repository-id"))) add("repository-id");
    if (prepared.paged) {
      for (const relative of prepared.members()) add(relative);
    } else
      for (const snapshot of inventory.snapshots) {
        for (const e of snapshot.model.entries)
          for (const c of e.chunks)
            add(
              path
                .relative(h.repo, h.storagePath("object", c.id))
                .split(path.sep)
                .join("/"),
            );
        add(
          path
            .relative(h.repo, h.storagePath("manifest", snapshot.id))
            .split(path.sep)
            .join("/"),
        );
      }
    flush();
    if (fingerprint(repository) !== inventory.before)
      throw new Error("Repository changed during archive export");
    const root = Buffer.from(
      JSON.stringify({
        format: prepared.paged ? 2 : 1,
        kind: "moonrestore_segmented_transport",
        ...(prepared.paged
          ? { repositoryFormat: prepared.format, snapshots: prepared.snapshots }
          : {}),
        encrypted: !!h.key,
        pages,
        members,
        rawBytes,
        storedBytes,
      }),
    );
    if (root.length > maxRoot) throw new Error("Archive root budget");
    writePrivate(path.join(stage, "archive.json"), root);
    publishDirectory(stage, dest);
    return {
      ok: true,
      kind: "archive_export",
      checksum: hash(root),
      pages: pages.length,
      members,
      raw_bytes: rawBytes,
      stored_bytes: storedBytes,
      live_repository_format_changed: false,
      requires_external_checksum: true,
      repository_format: prepared.format ?? repositoryKind(repository).format,
    };
  } finally {
    h.clean();
  } // Failed owned staging is retained, never auto-published.
}
export function* archiveMembers(archive, checksum) {
  archive = checked(archive);
  if (!id(checksum)) throw new Error("External archive checksum required");
  const raw = readPrivate(path.join(archive, "archive.json"), maxRoot);
  if (hash(raw) !== checksum) throw new Error("Archive root checksum mismatch");
  const root = JSON.parse(raw);
  if (
    ![1, 2].includes(root.format) ||
    root.kind !== "moonrestore_segmented_transport" ||
    typeof root.encrypted !== "boolean" ||
    !Array.isArray(root.pages) ||
    root.pages.length > 2000 ||
    !Number.isInteger(root.members) ||
    root.members < 1 ||
    root.members > 100000
  )
    throw new Error("Archive root schema");
  if (
    root.format === 2 &&
    (![4, 5].includes(root.repositoryFormat) ||
      !Array.isArray(root.snapshots) ||
      !root.snapshots.length ||
      root.snapshots.length > 1000 ||
      root.snapshots.some((v) => !id(v)) ||
      new Set(root.snapshots).size !== root.snapshots.length)
  )
    throw new Error("Paged archive root schema");
  let count = 0,
    total = 0;
  const seen = new Set();
  for (const ref of root.pages) {
    if (
      !id(ref.id) ||
      !Number.isInteger(ref.bytes) ||
      ref.bytes < 2 ||
      ref.bytes > maxPage ||
      !Number.isInteger(ref.count) ||
      ref.count < 1 ||
      ref.count > 64
    )
      throw new Error("Archive page reference");
    const bytes = readPrivate(path.join(archive, "pages", ref.id), maxPage);
    if (bytes.length !== ref.bytes || hash(bytes) !== ref.id)
      throw new Error("Archive page checksum mismatch");
    const page = JSON.parse(bytes);
    if (!Array.isArray(page) || page.length !== ref.count)
      throw new Error("Archive page shape");
    for (const entry of page) {
      if (
        !member(entry.path, root.format === 2) ||
        seen.has(entry.path) ||
        ++count > root.members ||
        !Number.isInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > 33554496 ||
        !Array.isArray(entry.parts) ||
        entry.parts.length < 1 ||
        entry.parts.length > 33
      )
        throw new Error("Archive member schema or cross-page duplicate");
      seen.add(entry.path);
      let size = 0;
      for (const part of entry.parts) {
        if (
          !id(part.id) ||
          !id(part.plain) ||
          !["raw", "deflate"].includes(part.codec) ||
          !Number.isInteger(part.bytes) ||
          part.bytes < 0 ||
          part.bytes > maxSegment ||
          !Number.isInteger(part.stored) ||
          part.stored < 0 ||
          part.stored > maxSegment + 128
        )
          throw new Error("Archive segment budget");
        size += part.bytes;
      }
      if (size !== entry.bytes) throw new Error("Archive member size mismatch");
      total += size;
      if (total > 1099511627776) throw new Error("Archive total budget");
      yield entry;
    }
  }
  if (count !== root.members || total !== root.rawBytes)
    throw new Error("Archive member count/byte mismatch");
}
export async function importArchive(archive, checksum, destination) {
  const rootBytes = readPrivate(
    path.join(checked(archive), "archive.json"),
    maxRoot,
  );
  if (!id(checksum) || hash(rootBytes) !== checksum)
    throw new Error("External archive checksum mismatch");
  const descriptor = JSON.parse(rootBytes);
  const { dest, stage } = newStage(destination, archive);
  let count = 0;
  for (const dir of descriptor.format === 2
    ? ["pages", "packs", "snapshots", "tmp", "trash"]
    : ["objects", "snapshots", "tmp"])
    fs.mkdirSync(path.join(stage, dir), { mode: 0o700 });
  for (const entry of archiveMembers(archive, checksum)) {
    checkpoint("archive_import", { members: count });
    const file = path.join(stage, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      for (const part of entry.parts) {
        const packed = readPrivate(
          path.join(checked(archive), "segments", part.id),
          maxSegment + 128,
        );
        if (packed.length !== part.stored || hash(packed) !== part.id)
          throw new Error("Archive segment checksum mismatch");
        const bytes =
          part.codec === "raw"
            ? packed
            : inflateRawSync(packed, { maxOutputLength: maxSegment });
        if (bytes.length !== part.bytes || hash(bytes) !== part.plain)
          throw new Error("Archive expansion integrity mismatch");
        fs.writeFileSync(fd, bytes);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    count++;
  }
  // The destination key applies to the imported repository, not the archive path.
  const imported = repositoryKind(stage);
  if (descriptor.format === 2) {
    if (!imported.paged || imported.format !== descriptor.repositoryFormat)
      throw new Error("Archive repository format mismatch");
    const env = { ...process.env, ...credentials(dest) };
    for (const snapshot of descriptor.snapshots)
      await verifyPaged(stage, snapshot, { environment: env });
    const store = await PagedStore.open(stage, { environment: env });
    try {
      const ids = [...store.snapshots()].sort();
      if (
        JSON.stringify(ids) !== JSON.stringify([...descriptor.snapshots].sort())
      )
        throw new Error("Archive snapshot inventory mismatch");
    } finally {
      store.close();
    }
  } else {
    if (imported.paged)
      throw new Error("Legacy archive cannot smuggle a paged repository");
    await core(["audit", stage, "all"], {
      env: { ...credentials(dest), MOONRESTORE_READ_ONLY: "1" },
    });
  }
  publishDirectory(stage, dest);
  return {
    ok: true,
    kind: "archive_import",
    members: count,
    destination_audited: true,
    source_archive_changed: false,
  };
}
export async function archiveCommand(args) {
  if (!["archive-export", "archive-import"].includes(args[0])) return null;
  const { positionals: p, values: v } = options(
    args.slice(1),
    ["no-compress"],
    ["no-compress"],
  );
  if (args[0] === "archive-export" && p.length === 2)
    return exportArchive(...p, { compress: !v["no-compress"] });
  if (args[0] === "archive-import" && p.length === 3 && !v["no-compress"])
    return importArchive(...p);
  throw new Error(
    "Usage: archive-export REPO NEW_ARCHIVE | archive-import ARCHIVE CHECKSUM NEW_REPO",
  );
}
