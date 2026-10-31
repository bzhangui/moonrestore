import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checked } from "./vault.mjs";
import { checkpoint } from "./activity.mjs";
const helper = fileURLToPath(
  new URL(
    "../_build/host/" +
      (process.platform === "win32" ? "fidelity.exe" : "fidelity"),
    import.meta.url,
  ),
);
function native(action, file, metadata) {
  checkpoint("native_metadata");
  if (!fs.existsSync(helper)) throw new Error("Build fidelity helper first");
  file = checked(file);
  const r = spawnSync(
    helper,
    process.platform === "win32"
      ? []
      : [
          action,
          file,
          ...(["xattr", "acl"].includes(action)
            ? action === "xattr"
              ? [metadata[0]]
              : []
            : (metadata ?? [])),
        ],
    {
      input:
        process.platform === "win32"
          ? JSON.stringify({ action, path: file, metadata })
          : ["xattr", "acl"].includes(action)
            ? metadata[metadata.length - 1] + "\n"
            : undefined,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1048576,
    },
  );
  if (r.error || r.status !== 0) {
    let code = "";
    if (process.platform !== "win32") {
      const found = r.stderr?.match(/^FIDELITY_([a-z_]+)_(\d+)\s*$/);
      if (found) code = " (" + found[1] + ":errno" + found[2] + ")";
    }
    if (process.platform === "win32")
      try {
        const v = JSON.parse(r.stdout);
        if (/^[a-z]+:[A-Za-z]+Exception$/.test(v.code))
          code = " (" + v.code + ")";
      } catch {}
    throw new Error(
      "Native metadata capability/permission/budget refused" + code,
    );
  }
  if (process.platform === "win32") {
    const v = JSON.parse(r.stdout);
    if (v.ok !== true) throw new Error("Native metadata rejected");
    return v.result;
  }
  return r.stdout;
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])]),
    );
  return v;
}
export const metadataEqual = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function captureNative(file) {
  if (process.platform === "win32") return native("capture", file);
  const xattrs = [],
    ranges = [];
  let acl = null;
  const text = native("capture", file);
  if (!text.endsWith("OK\n"))
    throw new Error("Incomplete native metadata response");
  for (const line of text.trimEnd().split("\n")) {
    const parts = line.split(" ");
    if (parts[0] === "X") {
      const name = Buffer.from(parts[1], "hex"),
        data = Buffer.from(parts[2] ?? "", "hex");
      xattrs.push({
        name: name.toString("base64"),
        data: data.toString("base64"),
      });
    } else if (parts[0] === "A")
      acl = Buffer.from(parts[1] ?? "", "hex").toString("utf8");
    else if (parts[0] === "R") ranges.push([parts[1], parts[2]]);
    else if (line !== "OK")
      throw new Error("Native metadata protocol mismatch");
  }
  xattrs.sort((a, b) => a.name.localeCompare(b.name));
  const stat = fs.lstatSync(file, { bigint: true });
  return {
    platform: process.platform,
    xattrs,
    acl,
    ranges: stat.isFile() ? ranges : null,
    sparse:
      stat.isFile() &&
      ranges.reduce((n, r) => n + BigInt(r[1]), 0n) < stat.size,
  };
}
export function validateFidelity(store, r) {
  if (
    !r ||
    Object.keys(r).some(
      (k) =>
        ![
          "path",
          "kind",
          "atime_ns",
          "mtime_ns",
          "birthtime_ns",
          "mode",
          "uid",
          "gid",
          "group",
          "native",
        ].includes(k),
    ) ||
    !["dir", "file"].includes(r.kind) ||
    !["atime_ns", "mtime_ns", "birthtime_ns"].every(
      (k) => typeof r[k] === "string" && /^(0|-?[1-9][0-9]{0,23})$/.test(r[k]),
    ) ||
    !Number.isInteger(r.mode) ||
    r.mode < 0 ||
    r.mode > 511 ||
    !["uid", "gid"].every((k) => Number.isSafeInteger(r[k]) && r[k] >= 0) ||
    (r.group !== null &&
      (typeof r.group !== "string" || !/^[a-f0-9]{64}$/.test(r.group)))
  )
    throw new Error("Invalid fidelity record");
  if (r.path !== "") store.core("path", { session: r.path });
  const n = r.native;
  if (
    !n ||
    Object.keys(n).some(
      (k) =>
        ![
          "platform",
          "attributes",
          "acl",
          "streams",
          "xattrs",
          "ranges",
          "sparse",
        ].includes(k),
    ) ||
    !["win32", "linux", "darwin"].includes(n.platform) ||
    Buffer.byteLength(JSON.stringify(r)) > 245000 ||
    (r.path === "" && r.kind !== "dir") ||
    (r.group !== null && r.kind !== "file")
  )
    throw new Error("Native metadata entry budget");
  const pairs = n.platform === "win32" ? n.streams : n.xattrs;
  if (
    n.platform !== "win32" &&
    ["atime_ns", "mtime_ns"].some(
      (k) =>
        BigInt(r[k]) < -9223372036854775808n ||
        BigInt(r[k]) > 9223372036854775807n,
    )
  )
    throw new Error("POSIX timestamp helper range exceeded");
  if (
    !Array.isArray(pairs) ||
    pairs.length > (n.platform === "win32" ? 16 : 128) ||
    (n.platform === "win32" && Object.hasOwn(n, "xattrs")) ||
    (n.platform !== "win32" &&
      (Object.hasOwn(n, "attributes") || Object.hasOwn(n, "streams")))
  )
    throw new Error("Invalid attribute inventory");
  let size = 0;
  const names = new Set();
  for (const p of pairs) {
    if (
      !p ||
      typeof p.name !== "string" ||
      typeof p.data !== "string" ||
      names.has(n.platform === "win32" ? p.name.toLowerCase() : p.name) ||
      Object.keys(p).some((k) => !["name", "data"].includes(k))
    )
      throw new Error("Duplicate/invalid metadata value");
    names.add(n.platform === "win32" ? p.name.toLowerCase() : p.name);
    const value = Buffer.from(p.data, "base64");
    size += value.length;
    if (
      value.toString("base64") !== p.data ||
      value.length > 65536 ||
      size > (n.platform === "win32" ? 65536 : 131072)
    )
      throw new Error("Metadata byte budget");
    if (n.platform === "win32") {
      if (!p.name || p.name.length > 255 || /[:/\\\x00-\x1f]/.test(p.name))
        throw new Error("Unsafe ADS name");
    } else {
      const key = Buffer.from(p.name, "base64");
      if (
        !key.length ||
        key.length > 1024 ||
        key.includes(0) ||
        key.toString("base64") !== p.name
      )
        throw new Error("Invalid xattr key");
    }
  }
  if (
    n.platform === "win32" &&
    (!Number.isInteger(n.attributes) ||
      (n.attributes & ~8487) !== 0 ||
      typeof n.acl !== "string" ||
      Buffer.byteLength(n.acl) > 65536)
  )
    throw new Error("Invalid Windows attributes/ACL");
  if (
    n.platform !== "win32" &&
    n.acl !== null &&
    (typeof n.acl !== "string" || Buffer.byteLength(n.acl) > 65536)
  )
    throw new Error("Invalid POSIX ACL");
  if (n.ranges !== null) {
    if (!Array.isArray(n.ranges) || n.ranges.length > 4096)
      throw new Error("Sparse range budget");
    let end = 0n;
    for (const range of n.ranges) {
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        range.some(
          (v) => typeof v !== "string" || !/^(0|[1-9][0-9]{0,11})$/.test(v),
        )
      )
        throw new Error("Invalid sparse range");
      const start = BigInt(range[0]),
        length = BigInt(range[1]);
      if (start < end || length < 1n || start + length > 68719476736n)
        throw new Error("Sparse range outside file budget");
      end = start + length;
    }
  }
  if (
    typeof n.sparse !== "boolean" ||
    (r.kind === "dir" && (n.ranges !== null || n.sparse)) ||
    (n.sparse && n.ranges === null)
  )
    throw new Error("Invalid metadata kind");
  return r;
}
export class FidelityWriter {
  constructor(store, index) {
    this.store = store;
    this.index = index;
    this.records = [];
    this.sequence = 0;
    this.previous = "";
    this.entries = 0;
    this.bytes = 0;
    index.db.exec(
      "CREATE TABLE fidelity_groups(k TEXT PRIMARY KEY,payload BLOB NOT NULL);",
    );
  }
  add(relative, file, s) {
    const key = this.index.key(
        "fidelity-group",
        String(s.dev) + ":" + String(s.ino),
      ),
      row =
        s.isFile() && s.nlink > 1n
          ? this.index.db
              .prepare("SELECT payload FROM fidelity_groups WHERE k=?")
              .get(key)
          : null;
    let r;
    if (row) {
      r = {
        ...this.index.decode("fidelity-group", key, row.payload),
        path: relative,
      };
    } else {
      r = {
        path: relative,
        kind: s.isDirectory() ? "dir" : "file",
        atime_ns: String(s.atimeNs),
        mtime_ns: String(s.mtimeNs),
        birthtime_ns: String(s.birthtimeNs),
        mode: Number(s.mode & 511n),
        uid: Number(s.uid),
        gid: Number(s.gid),
        group: s.isFile() && s.nlink > 1n ? key : null,
        native: captureNative(file),
      };
      if (r.group)
        this.index.db
          .prepare("INSERT INTO fidelity_groups VALUES(?,?)")
          .run(key, this.index.encode("fidelity-group", key, r));
    }
    validateFidelity(this.store, r);
    const bytes = Buffer.byteLength(JSON.stringify(r));
    if (
      this.records.length &&
      Buffer.byteLength(JSON.stringify(this.records)) + bytes > 250000
    )
      this.flush();
    this.records.push(r);
    this.entries++;
    this.bytes += bytes;
    if (this.entries > 1000001 || this.bytes > 1073741824)
      throw new Error("Fidelity inventory budget");
    if (this.records.length === 128) this.flush();
    return r;
  }
  flush() {
    if (!this.records.length) return;
    const raw = Buffer.from(
        JSON.stringify({
          fidelity: 1,
          sequence: this.sequence,
          previous: this.previous,
          records: this.records,
        }),
      ),
      id = this.store.logical(raw);
    this.store.write("page", id, raw);
    this.store.read("page", id);
    this.previous = id;
    this.sequence++;
    this.records = [];
  }
  finish() {
    this.flush();
    return {
      version: 1,
      platform: process.platform,
      pages: this.sequence,
      last_page: this.previous,
      entries: this.entries,
      bytes: String(this.bytes),
    };
  }
}
export function validateFidelityRoot(root) {
  if (!root.fidelity) return;
  const f = root.fidelity;
  if (
    Object.keys(f).some(
      (k) =>
        ![
          "version",
          "platform",
          "pages",
          "last_page",
          "entries",
          "bytes",
        ].includes(k),
    ) ||
    f.version !== 1 ||
    !["win32", "linux", "darwin"].includes(f.platform) ||
    !Number.isSafeInteger(f.pages) ||
    f.pages < 1 ||
    f.pages > 1000000 ||
    !Number.isSafeInteger(f.entries) ||
    f.entries !== root.entries + 1 ||
    !/^[a-f0-9]{64}$/.test(f.last_page) ||
    !/^\d{1,10}$/.test(f.bytes) ||
    Number(f.bytes) > 1073741824
  )
    throw new Error("Invalid fidelity root");
  return f;
}
export function indexFidelity(store, index, root) {
  const f = validateFidelityRoot(root);
  if (!f) return;
  index.db.exec(
    "CREATE TABLE IF NOT EXISTS fidelity(k TEXT PRIMARY KEY,payload BLOB NOT NULL); DELETE FROM fidelity;",
  );
  index.db.exec(
    "CREATE TABLE IF NOT EXISTS fidelity_pages(seq INTEGER PRIMARY KEY,id TEXT); DELETE FROM fidelity_pages;",
  );
  let next = f.last_page,
    entries = 0,
    bytes = 0;
  for (let seq = f.pages - 1; seq >= 0; seq--) {
    checkpoint("fidelity_manifest");
    const raw = store.read("page", next),
      page = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (
      Object.keys(page).some(
        (k) => !["fidelity", "sequence", "previous", "records"].includes(k),
      ) ||
      page.fidelity !== 1 ||
      page.sequence !== seq ||
      !Array.isArray(page.records) ||
      !page.records.length ||
      page.records.length > 128 ||
      raw.length > 262144 ||
      (seq === 0 ? page.previous !== "" : !/^[a-f0-9]{64}$/.test(page.previous))
    )
      throw new Error("Invalid fidelity page chain");
    index.db.prepare("INSERT INTO fidelity_pages VALUES(?,?)").run(seq, next);
    const physical = path.basename(store.file("page", next));
    index.db
      .prepare("INSERT OR IGNORE INTO live VALUES(?)")
      .run("page:" + physical);
    next = page.previous;
  }
  if (next !== "") throw new Error("Fidelity chain incomplete");
  index.db.exec(
    "CREATE TABLE IF NOT EXISTS fidelity_data(k TEXT PRIMARY KEY,size TEXT,hash TEXT); DELETE FROM fidelity_data; CREATE TABLE IF NOT EXISTS fidelity_group_values(k TEXT PRIMARY KEY,payload BLOB); DELETE FROM fidelity_group_values;",
  );
  let current;
  for (let seq = 0; seq < root.pages; seq++) {
    const page = JSON.parse(store.read("page", index.get("pages", seq).id));
    for (const r of page.records) {
      if (r.kind === "file") current = r;
      else if (r.kind === "end")
        index.db
          .prepare("INSERT INTO fidelity_data VALUES(?,?,?)")
          .run(index.key("fidelity", current.path), current.size, r.id);
    }
  }
  for (const row of index.db
    .prepare("SELECT id FROM fidelity_pages ORDER BY seq")
    .iterate()) {
    const page = JSON.parse(store.read("page", row.id));
    for (const r of page.records) {
      validateFidelity(store, r);
      const member =
        r.path === ""
          ? { kind: "dir" }
          : index.db
              .prepare("SELECT kind FROM paths WHERE k=?")
              .get(index.key("path", r.path.toLowerCase()));
      if (r.native.platform !== f.platform || member?.kind !== r.kind)
        throw new Error("Fidelity path not in data manifest");
      const key = index.key("fidelity", r.path),
        data =
          r.kind === "file"
            ? index.db.prepare("SELECT * FROM fidelity_data WHERE k=?").get(key)
            : null;
      if (
        data &&
        r.native.ranges?.some(
          (v) => BigInt(v[0]) + BigInt(v[1]) > BigInt(data.size),
        )
      )
        throw new Error("Sparse range exceeds declared file");
      if (r.group) {
        const prior = index.db
            .prepare("SELECT payload FROM fidelity_group_values WHERE k=?")
            .get(r.group),
          value = {
            metadata: { ...r, path: "" },
            hash: data.hash,
            size: data.size,
          };
        if (
          prior &&
          !metadataEqual(
            index.decode("fidelity-group-value", r.group, prior.payload),
            value,
          )
        )
          throw new Error("Hardlink group conflicts with content or metadata");
        if (!prior)
          index.db
            .prepare("INSERT INTO fidelity_group_values VALUES(?,?)")
            .run(r.group, index.encode("fidelity-group-value", r.group, value));
      }
      index.db
        .prepare("INSERT INTO fidelity VALUES(?,?)")
        .run(key, index.encode("fidelity", key, r));
      entries++;
      bytes += Buffer.byteLength(JSON.stringify(r));
    }
  }
  if (entries !== f.entries || String(bytes) !== f.bytes)
    throw new Error("Fidelity totals mismatch");
}
export function fidelityRecord(index, relative) {
  const k = index.key("fidelity", relative),
    r = index.db.prepare("SELECT payload FROM fidelity WHERE k=?").get(k);
  if (!r) throw new Error("Missing fidelity record");
  return index.decode("fidelity", k, r.payload);
}
export function prepareSparse(file, metadata) {
  if (metadata.native.sparse && process.platform === "win32")
    native("sparse", file);
}
export function applyFidelity(file, m, { permissions = false } = {}) {
  if (m.native.platform !== process.platform || !permissions)
    throw new Error(
      "Native fidelity requires same platform and explicit permissions",
    );
  if (process.platform === "win32") {
    native("apply", file, { ...m, permissions });
    return;
  }
  const stat = fs.lstatSync(checked(file));
  if (stat.uid !== m.uid || stat.gid !== m.gid)
    fs.chownSync(file, m.uid, m.gid);
  fs.chmodSync(file, m.mode);
  for (const pair of m.native.xattrs)
    native("xattr", file, [
      Buffer.from(pair.name, "base64").toString("hex"),
      Buffer.from(pair.data, "base64").toString("hex"),
    ]);
  if (process.platform === "darwin" && m.native.acl !== null)
    native("acl", file, [Buffer.from(m.native.acl).toString("hex")]);
  native("times", file, [m.atime_ns, m.mtime_ns]);
}
export function verifyFidelity(file, m) {
  const before = fs.lstatSync(checked(file), { bigint: true }),
    actual = captureNative(file);
  const expected = { ...m.native };
  if (process.platform === "win32") {
    actual.acl = native("acl-normalize", file, { acl: actual.acl });
    expected.acl = native("acl-normalize", file, { acl: m.native.acl });
  }
  if (
    !metadataEqual(
      { ...actual, ranges: null },
      { ...expected, ranges: null },
    ) ||
    (m.native.sparse && !metadataEqual(actual.ranges, m.native.ranges)) ||
    String(before.mtimeNs) !== m.mtime_ns ||
    (process.platform === "win32" &&
      String(before.birthtimeNs) !== m.birthtime_ns) ||
    (process.platform !== "win32" &&
      (Number(before.mode & 511n) !== m.mode ||
        Number(before.uid) !== m.uid ||
        Number(before.gid) !== m.gid))
  )
    throw new Error(
      "Native metadata readback mismatch: " +
        [
          ...Object.keys(m.native).filter(
            (k) => k !== "ranges" && !metadataEqual(actual[k], expected[k]),
          ),
          ...[
            "mtime",
            ...(process.platform === "win32" ? ["birthtime"] : []),
          ].filter((k) => String(before[k + "Ns"]) !== m[k + "_ns"]),
        ].join(","),
    );
  // Reading ADS/xattrs/extents can itself advance access time. Reapply only
  // timestamps after this probe, then independently stat the owned destination.
  if (process.platform === "win32") native("times", file, m);
  else native("times", file, [m.atime_ns, m.mtime_ns]);
  const final = fs.lstatSync(checked(file), { bigint: true });
  if (
    String(final.atimeNs) !== m.atime_ns ||
    String(final.mtimeNs) !== m.mtime_ns ||
    (process.platform === "win32" &&
      String(final.birthtimeNs) !== m.birthtime_ns)
  )
    throw new Error("Final metadata timestamp readback mismatch");
  return true;
}
