import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, tree } from "./helpers.mjs";
import { sqliteBackup } from "../platform/applications.mjs";
import {
  recoverSqlite,
  verifySqliteRecovery,
} from "../platform/sqlite-recovery.mjs";
test("SQLite isolated recovery opens recovered database and checks tables/rows without SQL scripts or production writes", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    const file = path.join(f.source, "data.sqlite"),
      db = new DatabaseSync(file);
    try {
      db.exec(
        'PRAGMA journal_mode=WAL; CREATE TABLE "应用数据"(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO "应用数据" VALUES(1,\'合成资料\');',
      );
    } finally {
      db.close();
    }
    const initial = tree(f.source)["data.sqlite"],
      b = await sqliteBackup(f.repo, file);
    assert.equal(b.restored_database_opened, true);
    const before = tree(f.source);
    assert.equal(before["data.sqlite"], initial); // SQLite may maintain WAL/SHM sidecars on read-only open.
    const repo = tree(f.repo),
      target = path.join(f.base, "recovery"),
      checks = {
        format: 1,
        tables: [
          {
            name: "应用数据",
            columns: ["id", "value"],
            minimumRows: 1,
            maximumRows: 1,
          },
        ],
      };
    await assert.rejects(
      recoverSqlite(f.repo, b.snapshot, target, {
        checks,
        confirmation: "wrong",
      }),
      /Confirm/,
    );
    assert.equal(fs.existsSync(target), false);
    const r = await recoverSqlite(f.repo, b.snapshot, target, {
      checks,
      confirmation: target,
    });
    assert.equal(r.ok, true);
    assert.equal(r.application_semantics_verified, false);
    assert.equal(r.table_checks, 1);
    assert.deepEqual(tree(f.source), before);
    assert.deepEqual(tree(f.repo), repo);
    await assert.rejects(
      recoverSqlite(f.repo, b.snapshot, target, { confirmation: target }),
    );
    const failed = path.join(f.base, "failed-checks");
    await assert.rejects(
      recoverSqlite(f.repo, b.snapshot, failed, {
        checks: { format: 1, tables: [{ name: "missing" }] },
        confirmation: failed,
      }),
      /checks failed/,
    );
    assert.equal(fs.existsSync(path.join(failed, "database.sqlite")), true);
    await assert.rejects(
      verifySqliteRecovery(path.join(target, "database.sqlite"), {
        format: 1,
        sql: "DROP TABLE x",
        tables: [],
      }),
      /checks failed/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("SQLite recovery rejects broken foreign keys, invalid ranges, views and corrupt files", async () => {
  const f = fixture();
  try {
    const file = path.join(f.source, "db.sqlite"),
      db = new DatabaseSync(file, { enableForeignKeyConstraints: false });
    try {
      db.exec(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(7); CREATE VIEW v AS SELECT * FROM parent;",
      );
    } finally {
      db.close();
    }
    await assert.rejects(verifySqliteRecovery(file));
    const healthy = path.join(f.source, "healthy.sqlite"),
      h = new DatabaseSync(healthy);
    try {
      h.exec("CREATE TABLE t(id); CREATE VIEW v AS SELECT * FROM t;");
    } finally {
      h.close();
    }
    for (const tables of [
      [{ name: "v" }],
      [{ name: "t", minimumRows: 2, maximumRows: 1 }],
      [{ name: "t", columns: ["missing"] }],
    ])
      await assert.rejects(
        verifySqliteRecovery(healthy, { format: 1, tables }),
      );
    fs.writeFileSync(path.join(f.source, "corrupt.sqlite"), "not a database");
    await assert.rejects(
      verifySqliteRecovery(path.join(f.source, "corrupt.sqlite")),
    );
  } finally {
    f.cleanup();
  }
});
