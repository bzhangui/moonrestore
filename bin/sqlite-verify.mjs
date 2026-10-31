// Separate, time-bounded read-only process. No extension loading, SQL scripts,
// ATTACH, triggers, or application-provided code is executed by this verifier.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checked } from "../platform/vault.mjs";
import { storageCore } from "../platform/paged-store.mjs";
const file = process.argv[2];
let db;
try {
  const text = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(text) > 65536) throw new Error("Checks budget");
  const checks = JSON.parse(text);
  if (
    !checks ||
    checks.format !== 1 ||
    Object.keys(checks).some(
      (k) => !["format", "tables", "references"].includes(k),
    ) ||
    !Array.isArray(checks.tables) ||
    checks.tables.length > 64
  )
    throw new Error("Invalid recovery checks");
  db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN;");
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
    throw new Error("Restored SQLite integrity failed");
  if (db.prepare("PRAGMA foreign_key_check").get())
    throw new Error("Restored SQLite foreign keys failed");
  const seen = new Set();
  for (const t of checks.tables) {
    if (
      !t ||
      typeof t.name !== "string" ||
      !t.name.length ||
      Buffer.byteLength(t.name) > 256 ||
      /[\x00-\x1f\x7f]/.test(t.name) ||
      seen.has(t.name) ||
      Object.keys(t).some(
        (k) => !["name", "columns", "minimumRows", "maximumRows"].includes(k),
      )
    )
      throw new Error("Invalid table check");
    seen.add(t.name);
    const schema = db
      .prepare(
        "SELECT type FROM sqlite_schema WHERE name=? AND type IN ('table','view')",
      )
      .get(t.name);
    if (schema?.type !== "table")
      throw new Error("Expected a real table, not a view");
    const columns = t.columns ?? [];
    if (
      !Array.isArray(columns) ||
      columns.length > 128 ||
      columns.some(
        (c) => typeof c !== "string" || !c.length || Buffer.byteLength(c) > 256,
      )
    )
      throw new Error("Invalid columns");
    const actual = db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(t.name)
      .map((c) => c.name);
    if (columns.some((c) => !actual.includes(c)))
      throw new Error("Required column missing");
    const min = t.minimumRows ?? 0,
      max = t.maximumRows ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min < 0 ||
      max < min
    )
      throw new Error("Invalid row range");
    const query = db.prepare(
      'SELECT count(*) AS n FROM "' + t.name.replaceAll('"', '""') + '"',
    );
    query.setReadBigInts(true);
    const count = query.get().n;
    if (count < BigInt(min) || count > BigInt(max))
      throw new Error("Restored row count outside expected range");
  }
  const references = checks.references ?? [];
  if (!Array.isArray(references) || references.length > 16)
    throw new Error("Reference contract budget");
  let referenceCount = 0,
    referenceBytes = 0;
  if (references.length) {
    const root = checked(process.argv[3]),
      core = await storageCore(),
      identities = new Map(),
      fingerprint = (s) =>
        ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
          .map((k) => String(s[k]))
          .join(":");
    if (!fs.lstatSync(root).isDirectory())
      throw new Error("Restored reference root required");
    const identifier = (x) => {
      if (
        typeof x !== "string" ||
        !x.length ||
        Buffer.byteLength(x) > 256 ||
        /[\x00-\x1f\x7f]/.test(x)
      )
        throw new Error("Invalid reference identifier");
      return '"' + x.replaceAll('"', '""') + '"';
    };
    for (const ref of references) {
      if (
        !ref ||
        Object.keys(ref).some(
          (k) =>
            ![
              "table",
              "column",
              "sha256Column",
              "maximumRows",
              "allowNull",
            ].includes(k),
        ) ||
        (ref.allowNull !== undefined && typeof ref.allowNull !== "boolean")
      )
        throw new Error("Reference contract fields");
      const table = identifier(ref.table),
        column = identifier(ref.column),
        shaColumn =
          ref.sha256Column === undefined ? null : identifier(ref.sha256Column),
        max = ref.maximumRows ?? 1000;
      if (!Number.isSafeInteger(max) || max < 1 || max > 10000)
        throw new Error("Reference row budget");
      if (
        db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(ref.table)
          ?.type !== "table"
      )
        throw new Error("Real reference table required");
      const columns = db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(ref.table)
        .map((r) => r.name);
      if (
        !columns.includes(ref.column) ||
        (shaColumn && !columns.includes(ref.sha256Column))
      )
        throw new Error("Reference column absent");
      const query = db.prepare(
        "SELECT typeof(" +
          column +
          ") AS kind,length(CAST(" +
          column +
          " AS BLOB)) AS bytes,CASE WHEN typeof(" +
          column +
          ")='text' AND length(CAST(" +
          column +
          " AS BLOB))<=4096 THEN " +
          column +
          " ELSE NULL END AS ref" +
          (shaColumn
            ? ",CASE WHEN typeof(" +
              shaColumn +
              ")='text' AND length(" +
              shaColumn +
              ")=64 THEN " +
              shaColumn +
              " ELSE NULL END AS digest"
            : "") +
          " FROM " +
          table +
          " LIMIT ?",
      );
      let rows = 0;
      for (const row of query.iterate(max + 1)) {
        if (++rows > max || ++referenceCount > 10000)
          throw new Error("Reference enumeration incomplete");
        if (row.kind === "null" && ref.allowNull === true) continue;
        if (row.kind !== "text" || !row.ref || row.bytes > 4096)
          throw new Error("Reference must be a bounded relative path");
        core("path", { session: row.ref });
        const absolute = checked(path.join(root, ...row.ref.split("/")));
        if (!absolute.startsWith(root + path.sep))
          throw new Error("Reference escapes recovered root");
        const before = fs.lstatSync(absolute, { bigint: true });
        const identity = fingerprint(before);
        if (identities.has(absolute) && identities.get(absolute) !== identity)
          throw new Error("Reference changed between rows");
        identities.set(absolute, identity);
        if (
          !before.isFile() ||
          before.size > 67108864n ||
          (referenceBytes += Number(before.size)) > 134217728
        )
          throw new Error("Reference byte budget");
        const fd = fs.openSync(
          absolute,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        try {
          const opened = fs.fstatSync(fd, { bigint: true });
          if (opened.ino !== before.ino || opened.dev !== before.dev)
            throw new Error("Reference identity changed");
          const sha = createHash("sha256"),
            buffer = Buffer.alloc(1048576);
          let offset = 0,
            n;
          while ((n = fs.readSync(fd, buffer, 0, buffer.length, offset))) {
            offset += n;
            if (offset > Number(before.size)) throw new Error("Reference grew");
            sha.update(buffer.subarray(0, n));
          }
          const digest = sha.digest("hex"),
            after = fs.fstatSync(fd, { bigint: true });
          if (
            offset !== Number(before.size) ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs ||
            after.ctimeNs !== before.ctimeNs
          )
            throw new Error("Reference changed during validation");
          if (shaColumn && row.digest !== digest)
            throw new Error("Referenced artifact hash mismatch");
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    for (const [absolute, identity] of identities)
      if (
        fingerprint(fs.lstatSync(checked(absolute), { bigint: true })) !==
        identity
      )
        throw new Error("Reference changed before commit");
  }
  db.exec("ROLLBACK;");
  console.log(
    JSON.stringify({
      ok: true,
      sqlite_integrity_checked: true,
      foreign_keys_checked: true,
      table_checks: checks.tables.length,
      reference_checks: referenceCount,
      referenced_bytes: String(referenceBytes),
      declared_application_contract_verified: references.length > 0,
      application_semantics_verified: false,
    }),
  );
} catch {
  console.error(
    "SQLite recovery verification rejected or incomplete; inspect the restored copy privately.",
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
