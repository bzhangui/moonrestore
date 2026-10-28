import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { checked } from "./vault.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  pageFrom,
  syncDirectory,
} from "./paged-store.mjs";
import { pagedBinding } from "./paged-cache.mjs";
import { publishDirectory } from "./adapter.mjs";
import { checkpoint } from "./activity.mjs";
const normalize = (p) =>
  process.platform === "win32"
    ? path.resolve(p).toLowerCase()
    : path.resolve(p);
export function selectionPrefixes(store, values = []) {
  if (
    !Array.isArray(values) ||
    values.length > 128 ||
    values.some((v) => typeof v !== "string" || !v || v.length > 1024)
  )
    throw new Error("Selection must be up to 128 relative paths");
  for (const v of values) store.core("path", { session: v });
  return [...new Set(values)].sort();
}
export function* pagedRecords(store, index, root) {
  for (let n = 0; n < root.pages; n++)
    for (const r of pageFrom(store, index.get("pages", n).id).records) {
      checkpoint("paged_records");
      yield r;
    }
}
function assess(store, index, snapshot, prefixes) {
  const root = indexSnapshot(store, index, snapshot, {
      verifyContents: false,
      verifyObjects: false,
    }),
    hash = randomUUID(),
    health = randomUUID();
  index.db.exec(
    "CREATE TABLE selected(k TEXT PRIMARY KEY,payload BLOB NOT NULL);",
  );
  const chosen = (r) =>
    !prefixes.length || prefixes.some((p) => r === p || r.startsWith(p + "/"));
  const dirChosen = (r) =>
    chosen(r) || prefixes.some((p) => p.startsWith(r + "/"));
  let current,
    selected = false,
    error = false,
    files = 0,
    bad = 0,
    dirs = 0,
    bytes = 0,
    matched = false;
  store.core("hash-new", { session: health });
  const save = (r, v) => {
    const key = index.key("selection", r.path);
    index.db
      .prepare("INSERT INTO selected VALUES(?,?)")
      .run(key, index.encode("selection", key, v));
  };
  try {
    for (const r of pagedRecords(store, index, root)) {
      if (r.kind === "dir") {
        if (dirChosen(r.path)) {
          save(r, { ...r, healthy: true });
          dirs++;
          matched = true;
        }
      } else if (r.kind === "file") {
        current = r;
        selected = chosen(r.path);
        error = false;
        if (selected) {
          matched = true;
          store.core("hash-new", { session: hash });
        }
      } else if (r.kind === "chunk" && selected && !error) {
        try {
          store.core("hash-push", { session: hash }, store.chunk(r));
        } catch {
          error = true;
        }
      } else if (r.kind === "end" && selected) {
        if (!error)
          error = store.core("hash-finish", { session: hash }) !== r.id;
        store.core("close", { session: hash });
        const item = { ...current, hash: r.id, healthy: !error };
        save(current, item);
        store.core(
          "hash-push",
          { session: health },
          Buffer.from(
            JSON.stringify({
              path: current.path,
              hash: r.id,
              healthy: !error,
            }) + "\n",
          ),
        );
        if (error) bad++;
        else {
          files++;
          bytes += Number(current.size);
        }
        selected = false;
      }
    }
    if (prefixes.length && !matched)
      throw new Error("Selection matched no paths");
    return {
      root,
      files,
      bad,
      dirs,
      bytes,
      health: store.core("hash-finish", { session: health }),
    };
  } finally {
    store.core("close", { session: hash });
    store.core("close", { session: health });
  }
}
function selected(index, p) {
  const key = index.key("selection", p),
    r = index.db.prepare("SELECT payload FROM selected WHERE k=?").get(key);
  return r ? index.decode("selection", key, r.payload) : null;
}
function targetIdentity(store, target) {
  const full = checked(target, false),
    parent = checked(path.dirname(full)),
    a = normalize(store.repo),
    b = normalize(full);
  if (
    fs.existsSync(full) ||
    a === b ||
    a.startsWith(b + path.sep) ||
    b.startsWith(a + path.sep)
  )
    throw new Error("New non-overlapping restore target required");
  const s = fs.lstatSync(parent, { bigint: true });
  if (!s.isDirectory()) throw new Error("Restore parent directory required");
  return { full, parent, identity: [s.dev, s.ino].map(String).join(":") };
}
function token(
  store,
  snapshot,
  destination,
  prefixes,
  partial,
  permissions,
  result,
) {
  return store.logical(
    Buffer.from(
      JSON.stringify({
        binding: pagedBinding(store),
        snapshot,
        target: normalize(destination.full),
        parent: destination.identity,
        prefixes,
        partial,
        permissions,
        health: result.health,
        files: result.files,
        bad: result.bad,
        dirs: result.dirs,
        bytes: String(result.bytes),
      }),
    ),
  );
}
export async function previewPagedRestore(
  repository,
  snapshot,
  target,
  {
    prefixes = [],
    partial = false,
    permissions = false,
    environment = process.env,
  } = {},
) {
  if (typeof partial !== "boolean" || typeof permissions !== "boolean")
    throw new Error("Strict restore flags required");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store);
  try {
    const list = selectionPrefixes(store, prefixes),
      destination = targetIdentity(store, target),
      r = assess(store, index, snapshot, list);
    if (r.bad && !partial)
      throw new Error(
        "Selected files damaged; explicit partial rescue required",
      );
    return {
      ok: true,
      preview: true,
      format: 4,
      snapshot,
      files: r.files,
      damaged_files: r.bad,
      bytes: String(r.bytes),
      complete: r.bad === 0,
      confirmation: token(
        store,
        snapshot,
        destination,
        list,
        partial,
        permissions,
        r,
      ),
      overwrites_existing_data: false,
      partial_rescue: partial,
    };
  } finally {
    index.close();
    store.close();
  }
}
export async function restorePagedSelection(
  repository,
  snapshot,
  target,
  {
    prefixes = [],
    partial = false,
    permissions = false,
    confirmation,
    environment = process.env,
  } = {},
) {
  if (typeof partial !== "boolean" || typeof permissions !== "boolean")
    throw new Error("Strict restore flags required");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store),
    session = randomUUID();
  let stage,
    fd = null;
  try {
    const list = selectionPrefixes(store, prefixes),
      destination = targetIdentity(store, target),
      r = assess(store, index, snapshot, list);
    if (r.bad && !partial)
      throw new Error("Damaged files require an explicit partial rescue");
    if (r.bad && !r.files && !r.dirs)
      throw new Error("No healthy selected content; target not created");
    if (
      token(store, snapshot, destination, list, partial, permissions, r) !==
      confirmation
    )
      throw new Error(
        "Restore preview changed; re-preview exact selection and target",
      );
    const disk = fs.statfsSync(destination.parent, { bigint: true });
    if (
      disk.bavail * disk.bsize <
      BigInt(r.bytes) + BigInt(r.files + r.dirs + 1) * disk.bsize + 16777216n
    )
      throw new Error("Restore capacity insufficient");
    stage = fs.mkdtempSync(
      path.join(destination.parent, ".moonrestore-paged-selected-"),
    );
    let active,
      copy = false,
      used = 0;
    const attributes = (file, meta) => {
      fs.utimesSync(
        file,
        Number(meta.mtime_ms) / 1000,
        Number(meta.mtime_ms) / 1000,
      );
      if (permissions && process.platform !== "win32")
        fs.chmodSync(file, meta.mode);
    };
    for (const row of pagedRecords(store, index, r.root)) {
      store.fail("selected-restore");
      if (row.kind === "dir") {
        if (selected(index, row.path))
          fs.mkdirSync(checked(path.join(stage, row.path), false), {
            recursive: true,
            mode: 0o700,
          });
      } else if (row.kind === "file") {
        active = selected(index, row.path);
        copy = active?.healthy === true;
        used = 0;
        if (copy) {
          const file = checked(path.join(stage, row.path), false);
          fs.mkdirSync(checked(path.dirname(file), false), {
            recursive: true,
            mode: 0o700,
          });
          checked(path.dirname(file));
          fd = fs.openSync(file, "wx", 0o600);
          store.core("hash-new", { session });
        }
      } else if (row.kind === "chunk" && copy) {
        const bytes = store.chunk(row);
        let at = 0;
        while (at < bytes.length) {
          const n = fs.writeSync(fd, bytes, at, bytes.length - at);
          if (!n) throw new Error("Selected restore write made no progress");
          at += n;
        }
        used += bytes.length;
        store.core("hash-push", { session }, bytes);
      } else if (row.kind === "end" && copy) {
        if (
          used !== Number(active.size) ||
          store.core("hash-finish", { session }) !== active.hash
        )
          throw new Error("Selected restore stream changed");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        const file = checked(path.join(stage, active.path)),
          input = fs.openSync(file, "r"),
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
        if (store.core("hash-finish", { session }) !== active.hash)
          throw new Error("Selected restore disk readback mismatch");
        attributes(file, active);
        copy = false;
      }
    }
    for (let seq = r.root.pages - 1; seq >= 0; seq--)
      for (const row of [
        ...pageFrom(store, index.get("pages", seq).id).records,
      ].reverse())
        if (row.kind === "dir" && selected(index, row.path))
          attributes(checked(path.join(stage, row.path)), row);
    syncDirectory(stage);
    store.fail("selected-before-publish");
    targetIdentity(store, target);
    publishDirectory(stage, destination.full);
    stage = null;
    syncDirectory(destination.parent);
    return {
      ok: r.bad === 0,
      format: 4,
      snapshot,
      target: destination.full,
      complete: r.bad === 0,
      partial_rescue: partial,
      recovered_files: r.files,
      damaged_files: r.bad,
      restored_files: r.files,
      rechecked_bytes: String(r.bytes),
      post_restore_readback: true,
      overwritten: false,
    };
  } catch (error) {
    if (stage) error.staging_retained = true;
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    store.core("close", { session });
    index.close();
    store.close();
  }
}
export async function catalogPaged(
  repository,
  snapshot,
  { offset = 0, query = "", environment = process.env } = {},
) {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    typeof query !== "string" ||
    query.length > 200
  )
    throw new Error("Invalid paged catalog query");
  const store = await PagedStore.open(repository, { environment }),
    index = new PagedIndex(store);
  try {
    const root = indexSnapshot(store, index, snapshot, {
        verifyContents: false,
        verifyObjects: false,
      }),
      items = [];
    let total = 0,
      current;
    const emit = (item) => {
      if (query && !item.path.toLowerCase().includes(query.toLowerCase()))
        return;
      if (total >= offset && items.length < 100) items.push(item);
      total++;
    };
    for (const r of pagedRecords(store, index, root))
      if (r.kind === "dir")
        emit({ path: r.path, kind: "dir", size: "0", hash: "" });
      else if (r.kind === "file") current = r;
      else if (r.kind === "end")
        emit({
          path: current.path,
          kind: "file",
          size: current.size,
          hash: r.id,
        });
    return {
      ok: true,
      format: 4,
      snapshot,
      entries: items,
      total,
      offset,
      more: offset + items.length < total,
      metadata_verified: true,
      content_verified: false,
    };
  } finally {
    index.close();
    store.close();
  }
}
