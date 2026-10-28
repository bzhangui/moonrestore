#!/usr/bin/env node
// Used only by PostgreSQL in an explicitly prepared isolated recovery directory.
import { fetchWal } from "../platform/postgres-physical.mjs";
try {
  if (process.argv.length !== 5) throw new Error("WAL arguments");
  fetchWal(...process.argv.slice(2));
} catch {
  process.exitCode = 1;
}
