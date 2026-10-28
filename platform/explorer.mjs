// Bounded, authenticated exploration. Search never creates a persistent filename index.
import fs from "node:fs";
import path from "node:path";
import { core, fingerprint, hash, openHost } from "./maintenance.mjs";
import { checked } from "./vault.mjs";
import { checkpoint } from "./activity.mjs";
import { repositoryKind } from "./repository-kind.mjs";
import { runEngine } from "./engine-client.mjs";
const integer = (n, max) => {
  if (!Number.isInteger(n) || n < 0 || n > max)
    throw new Error("Invalid pagination");
  return n;
};
const queryText = (q) => {
  if (typeof q !== "string" || q.length > 200)
    throw new Error("Invalid search");
  return q.toLowerCase();
};
export async function history(
  repository,
  { query = "", from = "", to = "", offset = 0 } = {},
) {
  if (repositoryKind(repository).paged)
    return runEngine(
      "history",
      { repository, query, from, to, offset },
      { allowFailure: true },
    );
  integer(offset, 100000);
  const q = queryText(query),
    data = await core(["list", repository]);
  const date = (value) => {
    if (!value) return null;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + "T00:00:00Z"))
    )
      throw new Error("Invalid date");
    if (
      new Date(Date.parse(value + "T00:00:00Z")).toISOString().slice(0, 10) !==
      value
    )
      throw new Error("Invalid calendar date");
    return Date.parse(value + "T00:00:00Z");
  };
  const start = date(from),
    end = date(to);
  if (start !== null && end !== null && start > end)
    throw new Error("Reversed date range");
  const list = data.snapshots
    .filter(
      (s) =>
        (!q || s.label.toLowerCase().includes(q) || s.id.includes(q)) &&
        (start === null || Date.parse(s.created) >= start) &&
        (end === null || Date.parse(s.created) < end + 86400000),
    )
    .sort(
      (a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id),
    );
  return {
    ok: true,
    total: list.length,
    offset,
    snapshots: list.slice(offset, offset + 100),
    more: offset + 100 < list.length,
  };
}
export async function searchHistory(
  repository,
  { query, offset = 0, entryOffset = 0, state } = {},
) {
  const q = queryText(query);
  if (!q) throw new Error("A file name is required");
  integer(offset, 100000);
  integer(entryOffset, 100000);
  const before = fingerprint(repository);
  if (state && state !== before)
    throw new Error("Repository changed; restart search");
  if (repositoryKind(repository).paged) {
    const page = await runEngine(
      "history",
      { repository, offset },
      { allowFailure: true },
    );
    if (!page.snapshots.length)
      return {
        ok: page.ok,
        results: [],
        state: before,
        next: null,
        nextEntry: 0,
        total_snapshots: page.total,
      };
    const snapshot = page.snapshots[0],
      catalog = await runEngine("catalog", {
        repository,
        snapshot: snapshot.id,
        query: q,
        offset: entryOffset,
      });
    if (fingerprint(repository) !== before)
      throw new Error("Repository changed during search");
    return {
      ok: page.ok,
      results: catalog.entries.map((e) => ({
        ...e,
        snapshot: snapshot.id,
        created: snapshot.created,
        label: snapshot.label,
      })),
      scope: "snapshot_batch",
      state: before,
      next: catalog.more ? offset : offset + 1 < page.total ? offset + 1 : null,
      nextEntry: catalog.more ? entryOffset + catalog.entries.length : 0,
      total_snapshots: page.total,
    };
  }
  const list = (await core(["list", repository])).snapshots.sort(
      (a, b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id),
    ),
    results = [];
  // One bounded snapshot batch, with an entry cursor; never silently drop matches.
  const end = Math.min(offset + 1, list.length);
  let next = end < list.length ? end : null,
    nextEntry = 0;
  for (let n = offset; n < end; n++) {
    checkpoint("search", {
      snapshots_scanned: n - offset,
      total_snapshots: list.length,
    });
    const model = await core(["catalog", repository, list[n].id]);
    for (let index = entryOffset; index < model.entries.length; index++) {
      const entry = model.entries[index];
      if (entry.path.toLowerCase().includes(q)) {
        results.push({
          snapshot: list[n].id,
          created: list[n].created,
          label: list[n].label,
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          hash: entry.hash,
        });
        if (results.length === 200 && index + 1 < model.entries.length) {
          next = n;
          nextEntry = index + 1;
          break;
        }
      }
    }
  }
  if (fingerprint(repository) !== before)
    throw new Error("Repository changed during search");
  return {
    ok: true,
    results,
    scope: "snapshot_batch",
    state: before,
    next,
    nextEntry,
    total_snapshots: list.length,
  };
}
export function selections(p) {
  if (
    (p.prefix !== undefined && typeof p.prefix !== "string") ||
    (p.restoreModes !== undefined && typeof p.restoreModes !== "boolean") ||
    (p.selections !== undefined && p.prefix)
  )
    throw new Error("Invalid or conflicting restore selection fields");
  const values = p.selections ?? (p.prefix ? [p.prefix] : []);
  if (
    !Array.isArray(values) ||
    values.length > 128 ||
    values.some((v) => typeof v !== "string" || !v || v.length > 1024)
  )
    throw new Error("Invalid restore selections");
  return [...new Set(values)].sort();
}
export async function restorePlan(p) {
  if (repositoryKind(p.repository).paged) {
    selections(p);
    return runEngine("restore-preview", p);
  }
  if (p.metadataMode !== undefined && p.metadataMode !== "basic")
    throw new Error(
      "Native/portable metadata profiles require format4/format5; legacy restore only supports basic metadata",
    );
  const selected = selections(p),
    repository = checked(p.repository),
    target = checked(p.target, false),
    parent = checked(path.dirname(target));
  if (
    typeof p.snapshot !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.snapshot) ||
    fs.existsSync(target)
  )
    throw new Error("Invalid snapshot or target already exists");
  const lower = (v) => (process.platform === "win32" ? v.toLowerCase() : v),
    a = lower(repository),
    b = lower(target);
  if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep))
    throw new Error("Restore/repository overlap");
  const state = fingerprint(repository),
    selection = await core([
      "selection-plan",
      repository,
      p.snapshot,
      ...selected.flatMap((value) => ["--prefix", value]),
    ]);
  const bytes = BigInt(selection.bytes),
    space = fs.statfsSync(parent, { bigint: true });
  if (
    space.bsize * space.bavail <
    bytes + BigInt(selection.entries) * space.bsize + 16777216n
  )
    throw new Error("Insufficient restore space");
  const plan = {
    repository,
    target,
    snapshot: p.snapshot,
    selections: selected,
    state,
    restoreModes: p.restoreModes === true,
  };
  if (fingerprint(repository) !== state)
    throw new Error("Restore state changed");
  return {
    ok: true,
    preview: true,
    files: selection.files,
    bytes: String(bytes),
    confirmation: hash(JSON.stringify(plan)),
    overwrites_existing_data: false,
    plan,
  };
}
export async function restoreSelected(p) {
  if (repositoryKind(p.repository).paged) {
    selections(p);
    return runEngine("restore", p, { allowFailure: p.partial === true });
  }
  const preview = await restorePlan(p);
  if (preview.confirmation !== p.confirmation)
    throw new Error("Restore plan changed");
  const r = preview.plan;
  return core(
    [
      "restore",
      r.repository,
      r.snapshot,
      r.target,
      ...r.selections.flatMap((v) => ["--prefix", v]),
    ],
    { env: { MOONRESTORE_RESTORE_MODES: r.restoreModes ? "1" : "0" } },
  );
}
export async function previewText(repository, snapshot, relative) {
  if (repositoryKind(repository).paged)
    return runEngine("text-preview", { repository, snapshot, path: relative });
  const model = await core(["catalog", repository, snapshot]),
    entry = model.entries.find((e) => e.path === relative);
  if (
    !entry ||
    entry.kind !== "file" ||
    BigInt(entry.size) > 131072n ||
    !/\.(txt|md|csv|json|ya?ml|toml|log|mbt|js|ts|py|c|h|html|css|svg)$/i.test(
      relative,
    )
  )
    throw new Error("Only small text files can be previewed");
  const host = openHost(repository);
  try {
    host.lock();
    const chunks = [];
    for (const part of entry.chunks) {
      checkpoint("preview");
      const bytes = host.readStored("object", part.id);
      if (bytes.length !== part.size || hash(bytes) !== part.id)
        throw new Error("Preview integrity failure");
      chunks.push(bytes);
    }
    const data = Buffer.concat(chunks);
    if (
      data.length !== Number(entry.size) ||
      hash(data) !== entry.hash ||
      data.includes(0)
    )
      throw new Error("Preview integrity or text encoding failure");
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(data),
      scope: "selected_file_only",
      executable: false,
    };
  } finally {
    host.clean();
  }
}
