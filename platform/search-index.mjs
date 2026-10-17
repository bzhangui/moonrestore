// Disposable search acceleration, never an authority for restore or deletion.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { core, fingerprint, hash, openHost, options } from "./maintenance.mjs";
import {
  stateHome,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  seal,
  unseal,
  storageId,
} from "./vault.mjs";
import { checkpoint, credentials } from "./activity.mjs";
const kind = "search-index-v1";
const readonly = {
  MOONRESTORE_READ_ONLY: "1",
  MOONRESTORE_RECOVERY_TARGET: "",
};
const location = (repo) =>
  path.join(
    mkdirPrivate(path.join(stateHome(), "search-index")),
    hash(path.resolve(repo)) + ".json",
  );
export async function buildSearchIndex(repository) {
  const before = fingerprint(repository),
    file = location(repository),
    lock = file + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  let host;
  try {
    const listed = await core(["list", repository], { env: readonly });
    if (listed.snapshots.length > 5000)
      throw new Error("Search index snapshot budget");
    const entries = [];
    let metadata = 0;
    for (const snap of listed.snapshots) {
      checkpoint("index_build", {
        snapshots: listed.snapshots.length,
        indexed_entries: entries.length,
      });
      const model = await core(["catalog", repository, snap.id], {
        env: readonly,
      });
      metadata += Buffer.byteLength(JSON.stringify(model));
      if (metadata > 67108864)
        throw new Error("Search catalog budget (64 MiB); split dataset");
      for (const entry of model.entries) {
        if (entries.length >= 200000) throw new Error("Search row budget");
        entries.push({
          snapshot: snap.id,
          created: snap.created,
          label: snap.label,
          path: entry.path,
          kind: entry.kind,
          size: entry.size,
          hash: entry.hash,
        });
      }
    }
    if (fingerprint(repository) !== before)
      throw new Error("Repository changed; index was not published");
    const data = Buffer.from(JSON.stringify({ format: 1, entries }));
    if (data.length > 16777216) throw new Error("Search index budget (16 MiB)");
    const content = hash(data);
    host = openHost(repository, {
      environment: { ...process.env, ...credentials(repository), ...readonly },
    });
    const encrypted = !!host.key;
    const record = {
      format: 1,
      source_state: before,
      content,
      encrypted,
      physical: storageId(host.key, kind, content),
      payload: (encrypted
        ? seal(host.key, host.vault, kind, content, data)
        : data
      ).toString("base64"),
    };
    const temp = file + "." + randomUUID() + ".tmp";
    writePrivate(temp, JSON.stringify(record));
    fs.renameSync(temp, file);
    return {
      ok: true,
      kind: "search_index",
      entries: entries.length,
      snapshots: listed.snapshots.length,
      encrypted,
      disposable: true,
      integrity_verified: false,
      source_state: before,
    };
  } finally {
    host?.clean();
    fs.rmdirSync(lock);
  }
}
export async function searchIndex(repository, query, { offset = 0 } = {}) {
  if (
    typeof query !== "string" ||
    !query ||
    query.length > 200 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 200000
  )
    throw new Error("Invalid indexed query");
  const record = JSON.parse(readPrivate(location(repository), 25165824)),
    before = fingerprint(repository);
  if (
    record.format !== 1 ||
    record.source_state !== before ||
    typeof record.encrypted !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(record.content) ||
    !/^[a-f0-9]{64}$/.test(record.physical) ||
    typeof record.payload !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      record.payload,
    )
  )
    throw new Error("Search index is invalid or stale; rebuild it");
  const host = openHost(repository, {
    environment: { ...process.env, ...credentials(repository), ...readonly },
  });
  try {
    if (!!host.key !== record.encrypted)
      throw new Error("Search index encryption mismatch");
    let data = Buffer.from(record.payload, "base64");
    if (record.encrypted)
      data = unseal(host.key, host.vault, kind, record.physical, data).bytes;
    if (
      data.length > 16777216 ||
      hash(data) !== record.content ||
      storageId(host.key, kind, record.content) !== record.physical
    )
      throw new Error("Search index integrity mismatch");
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    );
    if (
      parsed.format !== 1 ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > 200000
    )
      throw new Error("Invalid search rows");
    const matching = parsed.entries.filter((e) => {
      if (
        !e ||
        typeof e.path !== "string" ||
        typeof e.snapshot !== "string" ||
        !/^[a-f0-9]{64}$/.test(e.snapshot)
      )
        throw new Error("Invalid search row");
      return e.path.toLowerCase().includes(query.toLowerCase());
    });
    if (fingerprint(repository) !== before)
      throw new Error("Repository changed during indexed search");
    return {
      ok: true,
      kind: "indexed_history_search",
      results: matching.slice(offset, offset + 200),
      total: matching.length,
      next: offset + 200 < matching.length ? offset + 200 : null,
      integrity_verified: false,
      source_state: before,
    };
  } finally {
    host.clean();
  }
}
export async function indexCommand(args) {
  if (!["index-build", "index-search"].includes(args[0])) return null;
  const { values, positionals } = options(args.slice(1), ["offset"]);
  if (args[0] === "index-build") {
    if (positionals.length !== 1 || Object.keys(values).length)
      throw new Error("Usage: index-build REPOSITORY");
    return buildSearchIndex(positionals[0]);
  }
  if (positionals.length !== 2)
    throw new Error("Usage: index-search REPOSITORY QUERY [--offset N]");
  return searchIndex(...positionals, {
    offset: values.offset === undefined ? 0 : Number(values.offset),
  });
}
