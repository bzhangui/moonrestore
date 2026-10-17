import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, call } from "./helpers.mjs";
import { postgresBackup } from "../platform/postgresql.mjs";
test("PostgreSQL controlled client export, archive expansion, backup and isolated disk drill", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "private");
  try {
    const calls = [],
      config = {
        database: "synthetic",
        user: "tester",
        dumpExecutable: "controlled-dump",
        restoreExecutable: "controlled-restore",
      };
    const client = async (exe, args) => {
      calls.push(args);
      const out = args.find((a) => a.startsWith("--file="));
      if (out)
        fs.writeFileSync(
          out.slice(7),
          exe === "controlled-dump"
            ? "PGDMPsynthetic archive"
            : "-- synthetic expansion",
        );
    };
    await assert.rejects(
      () => postgresBackup(f.repo, config, { client }),
      /simulation/,
    );
    const result = await postgresBackup(f.repo, config, {
      client,
      controlledSimulation: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.native_client_executed, false);
    assert.equal(result.database_restore_executed, false);
    assert.equal(calls.length, 3);
    assert.equal(
      fs.readdirSync(
        path.join(process.env.MOONRESTORE_HOME, "application-staging"),
      ).length,
      0,
    );
    for (const mode of ["badmagic", "failed", "budget"]) {
      const broken = async (exe, args) => {
        if (mode === "failed") throw new Error("client stopped");
        const out = args.find((a) => a.startsWith("--file="));
        if (out)
          fs.writeFileSync(
            out.slice(7),
            mode === "budget" ? Buffer.alloc(2049) : "BAD!!",
          );
      };
      await assert.rejects(() =>
        postgresBackup(
          f.repo,
          { ...config, maxBytes: 1024 },
          { client: broken, controlledSimulation: true },
        ),
      );
    }
    assert.equal(call(["list", f.repo]).snapshots.length, 1);
    await assert.rejects(
      () =>
        postgresBackup(
          f.repo,
          { ...config, host: "remote.invalid" },
          { client, controlledSimulation: true },
        ),
      /permission/,
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
