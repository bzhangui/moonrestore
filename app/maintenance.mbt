///|
/// Reports catalog/storage utilization. Does not pretend to perform deep integrity checks.
pub fn status() -> Json raise {
  let ids : Array[String] = @json.from_json(io("list", Json::null()))
  let reachable : Map[String, Int32] = Map([])
  let mut logical = 0L
  for id in ids {
    let snapshot = read_snapshot(id)
    for entry in snapshot.entries {
      logical += entry.size
      for part in entry.chunks {
        if reachable.get(part.id) is Some(size) {
          guard size == part.size else {
            raise @core.Invalid("conflicting chunk sizes across snapshots")
          }
        }
        reachable[part.id] = part.size
      }
    }
  }
  let inventory : Array[@core.ChunkRef] = @json.from_json(
    io("inventory", Json::null()),
  )
  let present : Map[String, Int32] = Map([])
  let orphaned : Array[String] = []
  let mut stored = 0L
  let mut orphan_bytes = 0L
  for part in inventory {
    present[part.id] = part.size
    stored += part.size.to_int64()
    if !reachable.contains(part.id) {
      orphaned.push(part.id)
      orphan_bytes += part.size.to_int64()
    }
  }
  let missing : Array[String] = []
  for id, size in reachable {
    if present.get(id) != Some(size) {
      missing.push(id)
    }
  }
  missing.sort_by(fn(a, b) { @core.path_order(a, b) })
  orphaned.sort_by(fn(a, b) { @core.path_order(a, b) })
  {
    "ok": missing.is_empty(),
    "snapshots": ids.length(),
    "logical_bytes_all_snapshots": Json(logical),
    "stored_object_bytes": Json(stored),
    "unique_referenced_objects": reachable.length(),
    "unreferenced_objects": Json(orphaned),
    "unreferenced_bytes": Json(orphan_bytes),
    "missing_or_wrong_size_objects": Json(missing),
    "integrity_verified": false,
    "note": "Run verify all for complete SHA-256/file verification. Nothing is deleted.",
  }
}

///|
/// A no-payload-write preflight; useful for exclusions, unsafe paths and size budgets.
pub fn plan_backup(source : String, excludes : Array[String]) -> Json raise {
  let format : Int32 = @json.from_json(io("profile", Json::null()))
  let limits = if format == 3 {
    @core.Limits::large()
  } else {
    @core.Limits::default()
  }
  let entries : Array[SourceEntry] = @json.from_json(
    io("walk", {
      "source": source,
      "excludes": Json(excludes),
      "limits": limits.to_json(),
    }),
  )
  let model : @core.Snapshot = {
    format,
    label: "",
    created: "",
    config: @core.ChunkConfig::default(),
    entries: entries.map(fn(e) {
      @core.Entry::{
        path: e.path,
        kind: e.kind,
        size: 0L,
        hash: if e.kind == "file" {
          @core.digest(b"")
        } else {
          ""
        },
        chunks: [],
      }
    }),
  }
  model.validate(limits~)
  let bytes = entries.fold(init=0L, fn(total, e) { total + e.size })
  {
    "ok": true,
    "entries": entries.length(),
    "logical_bytes": Json(bytes),
    "payload_written": false,
    "exclusions": Json(excludes),
    "limits": limits.to_json(),
  }
}
