///|
/// Audit each validated file independently. Invalid manifests are not traversed.
pub fn audit_snapshots(selection : String) -> Json raise {
  let ids : Array[String] = if selection == "all" {
    @json.from_json(io("list", Json::null()))
  } else {
    [selection]
  }
  let snapshots : Array[Json] = []
  let mut good = true
  let cache : Map[String, Bytes] = Map([])
  for id in ids {
    let result : Json = try {
      let snapshot = read_snapshot(id)
      let issues : Array[Json] = []
      let mut files = 0
      let mut bytes = 0L
      let mut failed = 0
      for entry in snapshot.entries {
        if entry.kind == "file" {
          files += 1
          try {
            verify_entry(entry, false, cache~)
            bytes += entry.size
          } catch {
            _ => {
              failed += 1
              if issues.length() < 100 {
                issues.push({
                  "path": entry.path,
                  "code": "content_unreadable_or_mismatch",
                })
              }
            }
          }
        }
      }
      {
        "snapshot": id,
        "ok": failed == 0,
        "manifest_valid": true,
        "checked_files": files,
        "verified_bytes": Json(bytes),
        "failed_files": failed,
        "issues": Json(issues),
        "issues_truncated": failed > 100,
      }
    } catch {
      _ =>
        {
          "snapshot": id,
          "ok": false,
          "manifest_valid": false,
          "issues": [{ "code": "invalid_or_unreadable_manifest" }],
          "checked_files": 0,
        }
    }
    if result is { "ok": false, .. } {
      good = false
    }
    snapshots.push(result)
  }
  {
    "ok": good && !ids.is_empty(),
    "scope": "full_selected_snapshots",
    "snapshots": Json(snapshots),
    "empty_repository": ids.is_empty(),
  }
}

///|
pub fn retention_plan(
  keep : Int32,
  daily : Int32,
  weekly : Int32,
  monthly : Int32,
  protected_ids : Array[String],
) -> Json raise {
  let ids : Array[String] = @json.from_json(io("list", Json::null()))
  let records : Array[@core.RetentionRecord] = []
  for id in ids {
    let snapshot = read_snapshot(id)
    records.push({ id, created: snapshot.created, })
  }
  let kept = @core.retention_keep(
    records, keep, daily, weekly, monthly, protected_ids,
  )
  {
    "ok": true,
    "keep": Json(kept),
    "remove": Json(ids.filter(fn(id) { !kept.contains(id) })),
    "preview": true,
  }
}
