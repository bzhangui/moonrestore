// Only the dedicated disposable CI database is accepted. Never use personal DBs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fixture, call } from "./helpers.mjs";
import { postgresBackup } from "../platform/postgresql.mjs";
test(
  "native PostgreSQL logical backup restores rows into an isolated disposable database",
  { skip: process.env.MOONRESTORE_PG_NATIVE !== "1" },
  async () => {
    assert.equal(process.env.PGHOST, "127.0.0.1");
    assert.equal(process.env.PGDATABASE, "moonrestore_ci");
    assert.equal(process.env.PGUSER, "moonrestore_ci");
    const dir = process.env.MOONRESTORE_PG_BIN;
    assert.ok(path.isAbsolute(dir));
    const exe = (n) => path.join(dir, n),
      env = { ...process.env };
    const run = (name, args) => {
      const r = spawnSync(exe(name), args, {
        env,
        shell: false,
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(r.error, undefined);
      assert.equal(r.status, 0, "Native PostgreSQL client failed");
      return r.stdout.trim();
    };
    const f = fixture(),
      old = process.env.MOONRESTORE_HOME,
      db = "moonrestore_restore_" + process.pid;
    process.env.MOONRESTORE_HOME = path.join(f.base, "state");
    let created = false;
    try {
      run("psql", [
        "--no-password",
        "--set=ON_ERROR_STOP=1",
        "--command",
        "CREATE TABLE synthetic_rows(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO synthetic_rows VALUES(1,'中文资料'),(2,repeat('test',250000));",
      ]);
      const result = await postgresBackup(f.repo, {
        database: "moonrestore_ci",
        user: "moonrestore_ci",
        dumpExecutable: exe("pg_dump"),
        restoreExecutable: exe("pg_restore"),
      });
      assert.equal(result.native_client_executed, true);
      assert.equal(result.ok, true);
      const target = path.join(f.base, "restore");
      call(["restore", f.repo, result.snapshot, target]);
      run("createdb", ["--no-password", db]);
      created = true;
      run("pg_restore", [
        "--no-password",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--dbname=" + db,
        path.join(target, "database.dump"),
      ]);
      assert.equal(
        run("psql", [
          "--no-password",
          "--dbname=" + db,
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT count(*) FROM synthetic_rows;",
        ]),
        "2",
      );
      assert.equal(
        run("psql", [
          "--no-password",
          "--dbname=" + db,
          "--tuples-only",
          "--no-align",
          "--command",
          "SELECT length(value) FROM synthetic_rows WHERE id=2;",
        ]),
        "1000000",
      );
    } finally {
      if (created) run("dropdb", ["--no-password", db]);
      if (old === undefined) delete process.env.MOONRESTORE_HOME;
      else process.env.MOONRESTORE_HOME = old;
      f.cleanup();
    }
  },
);
