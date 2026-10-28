// Owned, synthetic PostgreSQL 16+ cluster only. No external database is changed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { fixture, project } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  physicalClient,
  physicalBackup,
  initWalArchive,
  archiveWal,
  pitrDrill,
} from "../platform/postgres-physical.mjs";
import { postgresEnvironment } from "../platform/postgresql.mjs";
async function port() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}
test(
  "native physical base plus WAL reaches an isolated PITR target and stops only its owned server",
  { skip: process.env.MOONRESTORE_PG_PITR_NATIVE !== "1", timeout: 360000 },
  async () => {
    assert.notEqual(process.platform, "win32");
    const f = fixture(),
      old = process.env.MOONRESTORE_HOME;
    process.env.MOONRESTORE_HOME = path.join(f.base, "state");
    const bin = process.env.MOONRESTORE_PG_BIN,
      source = path.join(f.base, "pg-source"),
      repo = path.join(f.base, "paged"),
      wal = path.join(f.base, "wal"),
      p = await port(),
      restoredPort = await port();
    let started = false,
      phase = "initialize";
    const environment = postgresEnvironment({
        host: "127.0.0.1",
        port: p,
        user: "moonrestore_pitr",
        database: "postgres",
        allowRemote: false,
      }),
      run = (name, args) =>
        physicalClient(path.join(bin, name), args, {
          environment,
          timeoutMs: 180000,
        });
    try {
      await run("initdb", [
        "-D",
        source,
        "--username=moonrestore_pitr",
        "--auth=trust",
        "--no-locale",
      ]);
      // Exactly this new cluster is configured. No production archive command is applied.
      fs.appendFileSync(
        path.join(source, "postgresql.conf"),
        "\nlisten_addresses='127.0.0.1'\nport=" +
          p +
          "\nunix_socket_directories=''\nwal_level=replica\nmax_wal_senders=5\narchive_mode=off\n",
      );
      await run("pg_ctl", [
        "-D",
        source,
        "-l",
        path.join(f.base, "source.log"),
        "-w",
        "start",
      ]);
      started = true;
      phase = "source-ready";
      await run("psql", [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "CREATE TABLE synthetic_values(id integer primary key, value text); INSERT INTO synthetic_values VALUES(1,'before-base');",
      ]);
      await PagedStore.create(repo);
      initWalArchive(wal);
      const base = await physicalBackup(repo, {
        bin,
        user: "moonrestore_pitr",
        host: "127.0.0.1",
        port: p,
        maxBytes: 1073741824,
      });
      phase = "base-verified";
      assert.equal(base.native_client_executed, true);
      await run("psql", [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "INSERT INTO synthetic_values VALUES(2,'before-target');",
      ]);
      const time = await run("psql", [
        "-X",
        "-A",
        "-t",
        "-c",
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await run("psql", [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "INSERT INTO synthetic_values VALUES(3,'after-target');",
      ]);
      await run("psql", [
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SELECT pg_switch_wal(); CHECKPOINT;",
      ]);
      // Archive every completed segment, not the active/incomplete segment.
      const active = await run("psql", [
        "-X",
        "-A",
        "-t",
        "-c",
        "SELECT pg_walfile_name(pg_current_wal_lsn())",
      ]);
      for (const name of fs.readdirSync(path.join(source, "pg_wal")))
        if (/^[A-F0-9]{24}$/.test(name) && name !== active)
          archiveWal(wal, name, path.join(source, "pg_wal", name));
      const target = path.join(f.base, "isolated");
      phase = "isolated-recovery";
      const result = await pitrDrill(repo, base.snapshot, target, {
        bin,
        walArchive: wal,
        recoveryTime: time,
        port: restoredPort,
        trustSource: true,
        allowIsolatedServer: true,
        user: "moonrestore_pitr",
        checks: [{ table: "synthetic_values", rows: 2 }],
      });
      assert.equal(result.target_reached, true);
      assert.equal(result.isolated_server_stopped, true);
      assert.equal(
        fs.existsSync(path.join(target, "base", "postmaster.pid")),
        false,
      );
      assert.equal(result.table_row_checks_passed, 1);
      // Source cluster was not modified by the recovery workflow.
      assert.equal(
        await run("psql", [
          "-X",
          "-A",
          "-t",
          "-c",
          "SELECT count(*) FROM synthetic_values",
        ]),
        "3",
      );
    } catch (error) {
      console.error("Synthetic PITR failure phase: " + phase);
      const log = path.join(f.base, "isolated", "isolated-server.log");
      if (fs.existsSync(log)) {
        const text = fs.readFileSync(log, "utf8").slice(-65536);
        for (const match of text.matchAll(
          /invalid value for parameter "([a-z_]+)"/g,
        ))
          console.error("Synthetic invalid configuration key: " + match[1]);
        for (const reason of [
          "invalid permissions",
          "recovery ended before configured recovery target was reached",
          "could not open file",
          "could not restore file",
          "unrecognized configuration parameter",
          "invalid value for parameter",
          "Permission denied",
          "has been changed on the primary server",
        ])
          if (text.includes(reason))
            console.error("Synthetic server failure class: " + reason);
      }
      throw error;
    } finally {
      if (started || fs.existsSync(path.join(source, "postmaster.pid")))
        await run("pg_ctl", ["-D", source, "-w", "-m", "fast", "stop"]);
      if (old === undefined) delete process.env.MOONRESTORE_HOME;
      else process.env.MOONRESTORE_HOME = old;
      f.cleanup();
    }
  },
);
