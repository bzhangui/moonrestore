// Separate, time-bounded read-only process. No extension loading, SQL scripts,
// ATTACH, triggers, or application-provided code is executed by this verifier.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const file = process.argv[2];
let db;
try {
  const text = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(text) > 65536) throw new Error("Checks budget");
  const checks = JSON.parse(text);
  if (
    !checks ||
    checks.format !== 1 ||
    Object.keys(checks).some((k) => !["format", "tables"].includes(k)) ||
    !Array.isArray(checks.tables) ||
    checks.tables.length > 64
  )
    throw new Error("Invalid recovery checks");
  db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;");
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
  console.log(
    JSON.stringify({
      ok: true,
      sqlite_integrity_checked: true,
      foreign_keys_checked: true,
      table_checks: checks.tables.length,
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
