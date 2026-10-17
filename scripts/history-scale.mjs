// Reproducible bounded history sample, not a production performance claim.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { core, removeOwned, saveReport } from "../platform/maintenance.mjs";
import { buildSearchIndex, searchIndex } from "../platform/search-index.mjs";
import { searchHistory } from "../platform/explorer.mjs";
import { scrub } from "../platform/recovery.mjs";
const parent = fs.realpathSync(os.tmpdir()),
  owned = fs.mkdtempSync(path.join(parent, "moonrestore-history-"));
const previous = process.env.MOONRESTORE_HOME;
process.env.MOONRESTORE_HOME = path.join(owned, "state");
const source = path.join(owned, "source"),
  repository = path.join(owned, "vault");
const records = [];
async function measure(operation, fn) {
  const start = performance.now();
  const result = await fn();
  records.push({
    operation,
    elapsed_ms: Math.round(performance.now() - start),
  });
  return result;
}
try {
  fs.mkdirSync(source);
  for (let i = 0; i < 500; i++)
    fs.writeFileSync(
      path.join(source, "file-" + String(i).padStart(4, "0") + ".txt"),
      "Synthetic history data " + i,
    );
  await core(["init", repository]);
  let snapshot;
  await measure("12 snapshots of 500 files", async () => {
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(source, "file-0000.txt"), "Revision " + i);
      snapshot = (
        await core(["backup", repository, source, "--label", "synthetic-" + i])
      ).snapshot;
    }
  });
  const built = await measure("build disposable index", () =>
    buildSearchIndex(repository),
  );
  assert.equal(built.entries, 6000);
  const indexed = await measure("indexed exact-name search", () =>
    searchIndex(repository, "file-0000.txt"),
  );
  assert.equal(indexed.total, 12);
  const direct = await measure("direct complete history search", async () => {
    const results = [];
    let offset = 0,
      entryOffset = 0,
      state;
    do {
      const batch = await searchHistory(repository, {
        query: "file-0000.txt",
        offset,
        entryOffset,
        state,
      });
      results.push(...batch.results);
      state = batch.state;
      offset = batch.next;
      entryOffset = batch.nextEntry;
    } while (offset !== null);
    return { results };
  });
  assert.equal(direct.results.length, indexed.total);
  let batches = 0,
    done;
  await measure("persistent 500-file verification cycle", async () => {
    do {
      const result = await scrub(repository, {
        maxFiles: 100,
        maxBytes: "1048576",
        snapshot,
      });
      batches++;
      done = result.completed_cycle;
      assert.equal(result.ok, true);
    } while (!done && batches < 10);
  });
  assert.equal(done.checked, 500);
  assert.equal(batches, 5);
  const report = {
    ok: true,
    version: "0.5.0",
    kind: "history_scale",
    controlled_sample: true,
    production_benchmark: false,
    files_per_snapshot: 500,
    snapshots: 12,
    index_rows: built.entries,
    indexed_results: indexed.total,
    direct_results: direct.results.length,
    verification_batches: batches,
    records,
    peak_process_rss_bytes: process.resourceUsage().maxRSS * 1024,
  };
  if (previous === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = previous;
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  if (previous === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = previous;
  removeOwned(owned, parent, "moonrestore-history-");
}
