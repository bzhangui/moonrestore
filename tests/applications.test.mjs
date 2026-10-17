import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, call } from "./helpers.mjs";
import { sqliteBackup } from "../platform/applications.mjs";
import { withCredentials } from "../platform/activity.mjs";

test("SQLite online export preserves committed WAL data and excludes uncommitted writes", async () => {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const file = path.join(f.source, "quoted ' database.sqlite"),
    db = new DatabaseSync(file);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO records(value) VALUES('committed'); BEGIN; INSERT INTO records(value) VALUES('not_committed');",
    );
    const result = await sqliteBackup(f.repo, file);
    assert.equal(result.ok, true);
    assert.equal(result.post_restore_readback, true);
    const target = path.join(f.base, "restored");
    call(["restore", f.repo, result.snapshot, target]);
    const restored = new DatabaseSync(path.join(target, "database.sqlite"), {
      readOnly: true,
    });
    try {
      assert.deepEqual(
        restored
          .prepare("SELECT value FROM records ORDER BY id")
          .all()
          .map((r) => r.value),
        ["committed"],
      );
    } finally {
      restored.close();
    }
    assert.deepEqual(
      fs.readdirSync(path.join(f.base, "state/application-staging")),
      [],
    );
  } finally {
    db.exec("ROLLBACK");
    db.close();
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
    f.cleanup();
  }
});
test("invalid SQLite input produces no snapshot and leaves no plaintext export", async () => {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    const file = path.join(f.source, "not-a-database");
    fs.writeFileSync(file, "controlled-only-private-data");
    await assert.rejects(() => sqliteBackup(f.repo, file));
    assert.deepEqual(call(["list", f.repo]).snapshots, []);
    assert.deepEqual(
      fs.readdirSync(path.join(f.base, "state/application-staging")),
      [],
    );
  } finally {
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
    f.cleanup();
  }
});
test("SQLite backup accepts session-only encryption credentials without persisting them", async () => {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const repository = path.join(f.base, "encrypted"),
    password = "synthetic-session-sqlite-password",
    file = path.join(f.source, "db.sqlite"),
    db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE evidence(value);INSERT INTO evidence VALUES('session credential export');",
    );
    call(["init-encrypted", repository], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    const result = await withCredentials(
      (repo) => (repo === repository ? { MOONRESTORE_PASSWORD: password } : {}),
      () => sqliteBackup(repository, file),
    );
    assert.equal(result.ok, true);
    assert.equal(result.post_restore_readback, true);
    assert.ok(!JSON.stringify(result).includes(password));
    const names = fs.readdirSync(path.join(f.base, "state/reports"));
    for (const name of names)
      assert.ok(
        !fs
          .readFileSync(path.join(f.base, "state/reports", name), "utf8")
          .includes(password),
      );
  } finally {
    db.close();
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
    f.cleanup();
  }
});
