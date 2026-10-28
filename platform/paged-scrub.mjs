import { randomUUID } from "node:crypto";
import { PagedStore, PagedIndex, indexSnapshot } from "./paged-store.mjs";
import { PagedCache, fileFingerprint } from "./paged-cache.mjs";
import { pagedRecords } from "./paged-selection.mjs";
import { checkpoint } from "./activity.mjs";
// Bounded whole-file batches. Root/page structure is authenticated each tick;
// a payload cycle records its OLDEST check, never pretends all bytes were just read.
export async function scrubPaged(
  repository,
  {
    snapshot,
    maxFiles = 100,
    maxBytes = "268435456",
    maxAgeHours = 24,
    statusOnly = false,
  } = {},
) {
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 1000 ||
    !/^[1-9][0-9]{0,12}$/.test(maxBytes) ||
    BigInt(maxBytes) > 1099511627776n ||
    !Number.isSafeInteger(maxAgeHours) ||
    maxAgeHours < 1 ||
    maxAgeHours > 8760
  )
    throw new Error("Invalid paged scrub budget");
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store),
    cache = new PagedCache(store),
    session = randomUUID();
  const now = Date.now(),
    rows = [];
  let files = 0,
    used = 0n,
    overBudget = false;
  try {
    for (const id of snapshot ? [snapshot] : store.snapshots()) {
      if (rows.length >= 5000) throw new Error("Paged scrub root budget");
      const observed = fileFingerprint(store.file("snapshot", id)),
        key = "scrub:" + id,
        prior = cache.get(key);
      let state = prior?.observed === observed ? prior : null;
      if (
        !state ||
        state.started > now ||
        (state.completed && now - state.started > maxAgeHours * 3600000)
      )
        state = {
          observed,
          cursor: 0,
          started: now,
          completed: null,
          errors: 0,
          checked_bytes: "0",
        };
      if (
        !statusOnly &&
        !state.completed &&
        files < maxFiles &&
        used < BigInt(maxBytes)
      ) {
        const root = indexSnapshot(store, index, id, {
          verifyContents: false,
          verifyObjects: false,
        });
        let position = 0,
          active = false,
          bad = false,
          current;
        for (const r of pagedRecords(store, index, root)) {
          checkpoint("paged_scrub", { checked_files: files });
          if (r.kind === "file") {
            current = r;
            active = position >= state.cursor;
            if (
              active &&
              (files >= maxFiles || used + BigInt(r.size) > BigInt(maxBytes))
            ) {
              overBudget = files === 0 && BigInt(r.size) > BigInt(maxBytes);
              break;
            }
            bad = false;
            if (active) store.core("hash-new", { session });
          } else if (r.kind === "chunk" && active && !bad) {
            try {
              store.core("hash-push", { session }, store.chunk(r));
            } catch {
              checkpoint("paged_scrub_failure");
              bad = true;
            }
          } else if (r.kind === "end") {
            if (active) {
              if (!bad) bad = store.core("hash-finish", { session }) !== r.id;
              store.core("close", { session });
              state.errors += bad ? 1 : 0;
              state.cursor = position + 1;
              files++;
              used += BigInt(current.size);
              state.checked_bytes = String(
                BigInt(state.checked_bytes) + BigInt(current.size),
              );
            }
            position++;
          }
        }
        // Count all file starts from the authenticated ledger, not the loop cursor
        // which may have stopped before reaching the remaining records.
        const total = index.db
          .prepare("SELECT count(*) AS n FROM paths WHERE kind='file'")
          .get().n;
        if (state.cursor === total) state.completed = now;
        cache.put(key, state);
        cache.commit();
      }
      const age = now - state.started,
        complete =
          state.completed !== null && age >= 0 && age <= maxAgeHours * 3600000;
      rows.push({
        snapshot: id,
        complete,
        oldest_check_at: new Date(state.started).toISOString(),
        completed_at: state.completed
          ? new Date(state.completed).toISOString()
          : null,
        checked_files: state.cursor,
        errors: state.errors,
        payload_cycle_current: complete && state.errors === 0,
      });
    }
    return {
      ok:
        rows.length > 0 &&
        rows.every((r) => r.payload_cycle_current) &&
        !cache.disabled,
      kind: statusOnly ? "recovery_health" : "integrity_scrub",
      format: 4,
      snapshots: rows,
      checked_files: files,
      checked_bytes: String(used),
      file_exceeds_budget: overBudget,
      cursor_persisted: !cache.disabled,
      all_bytes_just_read: false,
      real_user_pilot: false,
    };
  } finally {
    store.core("close", { session });
    cache.close();
    index.close();
    store.close();
  }
}
