///|
/// Explicit degraded rescue, separate from unchanged strict restore.
pub fn rescue(
  id : String,
  selections : Array[String],
  target : String,
  apply~ : Bool = false,
) -> Json raise {
  let snapshot = read_snapshot(id)
  let chosen = @core.select_entries(snapshot, selections)
  let healthy : Array[String] = []
  let failures : Array[Json] = []
  let mut failed = 0
  let mut bytes = 0L
  let mut readback = false
  let cache : Map[String, Bytes] = Map([])
  for entry in chosen {
    if entry.kind == "file" {
      try {
        verify_entry(entry, false, cache~)
        healthy.push(entry.path)
        bytes += entry.size
      } catch {
        _ => {
          failed += 1
          if failures.length() < 1000 {
            failures.push({
              "path": entry.path,
              "code": "content_unreadable_or_mismatch",
            })
          }
        }
      }
    }
  }
  if apply {
    guard failed == 0 || !healthy.is_empty() else {
      raise @core.Invalid("no verified files available for rescue")
    }
    ignore(io("begin_restore", { "target": target }))
    for entry in @core.rescue_entries(snapshot, selections, healthy) {
      verify_entry(entry, true)
    }
    readback = io("finish_restore", Json::null())
      is { "post_restore_readback": True, .. }
  }
  {
    "ok": failed == 0,
    "kind": "verified_rescue",
    "snapshot": id,
    "manifest_valid": true,
    "preview": !apply,
    "restored": apply,
    "post_restore_readback": readback,
    "complete": failed == 0,
    "scope": if selections.is_empty() {
      "full_snapshot"
    } else {
      "selected_entries"
    },
    "verified_files": healthy.length(),
    "verified_bytes": Json(bytes),
    "failed_files": failed,
    "issues": Json(failures),
    "issues_truncated": failed > 1000,
    "whole_repository_verified": false,
  }
}

///|
pub fn scrub_snapshot(
  id : String,
  cursor : Int32,
  max_files : Int32,
  max_bytes : Int64,
) -> Json raise {
  let snapshot = read_snapshot(id)
  let batch = @core.verification_batch(snapshot, cursor, max_files, max_bytes)
  let included : Map[String, Bool] = Map([])
  for name in batch.paths {
    included[name] = true
  }
  let results : Array[Json] = []
  let mut failed = 0
  let cache : Map[String, Bytes] = Map([])
  for entry in snapshot.entries {
    if included.contains(entry.path) {
      let good = try {
        verify_entry(entry, false, cache~)
        true
      } catch {
        _ => false
      }
      if !good {
        failed += 1
      }
      results.push({ "path": entry.path, "ok": good })
    }
  }
  {
    "ok": failed == 0,
    "kind": "verification_batch",
    "snapshot": id,
    "cursor": cursor,
    "next": batch.next,
    "total": batch.total,
    "checked_files": batch.paths.length(),
    "planned_bytes": Json(batch.bytes),
    "failed_files": failed,
    "results": Json(results),
    "snapshot_range_complete": cursor == 0 && batch.next == batch.total,
    "whole_repository_verified": false,
  }
}
