import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, put, sha, call, tree } from "./helpers.mjs";
import { validateApplication } from "../platform/application-contract.mjs";
import { verifySqliteRecovery } from "../platform/sqlite-recovery.mjs";
import { fileURLToPath } from "node:url";
function sample(f) {
  put(f.source, "assets/文档.txt", "controlled business attachment");
  put(
    f.source,
    "config.json",
    JSON.stringify({ schema: 1, revision: "controlled-v1" }),
  );
  const file = path.join(f.source, "app.sqlite"),
    db = new DatabaseSync(file);
  try {
    db.exec(
      "CREATE TABLE assets(id INTEGER PRIMARY KEY,path TEXT,sha256 TEXT)",
    );
    db.prepare("INSERT INTO assets VALUES(1,?,?)").run(
      "assets/文档.txt",
      sha("controlled business attachment"),
    );
  } finally {
    db.close();
  }
  return {
    format: 1,
    files: [
      {
        path: "assets/文档.txt",
        sha256: sha("controlled business attachment"),
        bytes: String(Buffer.byteLength("controlled business attachment")),
      },
    ],
    json: [
      { path: "config.json", equals: { schema: 1, revision: "controlled-v1" } },
    ],
    sqlite: [
      {
        path: "app.sqlite",
        checks: {
          format: 1,
          tables: [
            {
              name: "assets",
              columns: ["id", "path", "sha256"],
              minimumRows: 1,
              maximumRows: 1,
            },
          ],
          references: [
            {
              table: "assets",
              column: "path",
              sha256Column: "sha256",
              maximumRows: 8,
            },
          ],
        },
      },
    ],
  };
}

test("published application-contract documentation example is executable against synthetic recovered assets", async () => {
  const text = fs.readFileSync(
      fileURLToPath(new URL("../docs/RELIABILITY_0_12.md", import.meta.url)),
      "utf8",
    ),
    block = text.match(/```json\s+([\s\S]+?)```/);
  assert.ok(block);
  const contract = JSON.parse(block[1]),
    f = fixture();
  try {
    put(f.source, "config.json", '{"schemaVersion":1}');
    put(f.source, "asset", "controlled");
    const db = new DatabaseSync(path.join(f.source, "app.sqlite"));
    try {
      db.exec("CREATE TABLE documents(asset TEXT,digest TEXT)");
      db.prepare("INSERT INTO documents VALUES(?,?)").run(
        "asset",
        sha("controlled"),
      );
    } finally {
      db.close();
    }
    assert.equal(
      (await validateApplication(f.source, contract)).reference_checks,
      1,
    );
  } finally {
    f.cleanup();
  }
});
test("restored application contract verifies file bytes JSON schema and database attachment references without application code", async () => {
  const f = fixture();
  try {
    const contract = sample(f),
      b = call(["backup", f.repo, f.source]),
      out = path.join(f.base, "restored");
    call(["restore", f.repo, b.snapshot, out]);
    const before = tree(f.repo);
    const result = await validateApplication(out, contract);
    assert.equal(result.declared_contract_verified, true);
    assert.equal(result.reference_checks, 1);
    assert.equal(result.arbitrary_code_executed, false);
    assert.equal(result.capture_consistency_proven, false);
    assert.deepEqual(tree(f.repo), before);
    const file = path.join(f.base, "private-contract.json");
    fs.writeFileSync(file, JSON.stringify(contract));
    const cli = call(["application-validate", out, file]);
    assert.equal(cli.json_checks, 1);
    assert.equal(JSON.stringify(cli).includes("文档"), false);
    put(out, "assets/文档.txt", "damaged");
    await assert.rejects(validateApplication(out, contract), /size|integrity/);
  } finally {
    f.cleanup();
  }
});
test("database structural success does not hide missing changed or escaped attachments", async () => {
  const f = fixture();
  try {
    const contract = sample(f);
    await verifySqliteRecovery(path.join(f.source, "app.sqlite"));
    fs.unlinkSync(path.join(f.source, "assets/文档.txt"));
    await assert.rejects(
      validateApplication(f.source, { format: 1, sqlite: contract.sqlite }),
      /checks failed/,
    );
    put(f.source, "assets/文档.txt", "different bytes");
    await assert.rejects(
      validateApplication(f.source, { format: 1, sqlite: contract.sqlite }),
      /checks failed/,
    );
    const db = new DatabaseSync(path.join(f.source, "app.sqlite"));
    try {
      db.exec("UPDATE assets SET path='../outside'");
    } finally {
      db.close();
    }
    await assert.rejects(
      validateApplication(f.source, { format: 1, sqlite: contract.sqlite }),
      /checks failed/,
    );
  } finally {
    f.cleanup();
  }
});
test("application contracts reject scripts empty assertions excessive budgets and nonfinite expectations", async () => {
  const f = fixture();
  try {
    sample(f);
    for (const contract of [
      { format: 1 },
      { format: 1, script: "arbitrary" },
      { format: 1, json: [{ path: "config.json", equals: {} }] },
      { format: 1, json: [{ path: "config.json", equals: { schema: NaN } }] },
      { format: 1, files: [{ path: "../secret", sha256: "a".repeat(64) }] },
    ])
      await assert.rejects(validateApplication(f.source, contract));
    await assert.rejects(
      validateApplication(
        f.source,
        { format: 1, json: [{ path: "config.json", equals: { schema: 1 } }] },
        { timeoutMs: 1 },
      ),
      /budget/,
    );
  } finally {
    f.cleanup();
  }
});

test("an already checked artifact changed during a later JSON assertion cannot produce final contract success", async () => {
  const f = fixture(),
    read = fs.readFileSync;
  put(f.source, "asset", "controlled");
  put(f.source, "config.json", '{"schema":1}');
  let changed = false;
  fs.readFileSync = function (file, ...args) {
    if (file === path.join(f.source, "config.json") && !changed) {
      changed = true;
      fs.writeFileSync(path.join(f.source, "asset"), "changed");
    }
    return read.call(fs, file, ...args);
  };
  try {
    await assert.rejects(
      validateApplication(f.source, {
        format: 1,
        files: [{ path: "asset", sha256: sha("controlled") }],
        json: [{ path: "config.json", equals: { schema: 1 } }],
      }),
      /changed/,
    );
    assert.equal(changed, true);
  } finally {
    fs.readFileSync = read;
    f.cleanup();
  }
});
