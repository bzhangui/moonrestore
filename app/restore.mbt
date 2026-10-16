///|
fn verify_entry(
  entry : @core.Entry,
  restore : Bool,
  cache~ : Map[String, Bytes] = Map([]),
) -> Unit raise {
  if entry.kind == "dir" {
    if restore {
      io_unit("restore_dir", { "path": entry.path })
    }
    return
  }
  if restore {
    io_unit("restore_open", { "path": entry.path })
  }
  let hash = @core.Hasher::new()
  let mut size = 0L
  for part in entry.chunks {
    let bytes = try {
      if cache.get(part.id) is Some(value) {
        @core.verify_chunk(part, value)
        value
      } else {
        let value = get_object(part)
        // Fixed 16-object budget (at most 16 MiB). Never trust mtime or persist
        // verification decisions between commands. File hashes are still checked.
        if cache.length() < 16 {
          cache[part.id] = value
        }
        value
      }
    } catch {
      e => raise @core.Invalid("\{entry.path}: \{e}")
    }
    hash.update(bytes)
    size += bytes.length().to_int64()
    if restore {
      io_unit("restore_write", Json::null(), data=bytes)
    }
  }
  guard size == entry.size && hash.finish() == entry.hash else {
    raise @core.Invalid("file integrity mismatch: \{entry.path}")
  }
  if restore {
    io_unit("restore_close", Json::null())
  }
}

///|
/// Validate every file hash, not only object hashes. Detects reordered chunks.
pub fn verify(id : String) -> Json raise {
  let snapshot = read_snapshot(id)
  let mut bytes = 0L
  let mut files = 0
  let cache : Map[String, Bytes] = Map([])
  for entry in snapshot.entries {
    verify_entry(entry, false, cache~)
    if entry.kind == "file" {
      files += 1
      bytes += entry.size
    }
  }
  { "ok": true, "snapshot": id, "files": files, "verified_bytes": Json(bytes) }
}

///| Full verification happens before any target staging. Selected restores still

///|
/// verify the full snapshot so a green result never hides an unrelated corruption.
pub fn restore(id : String, target : String, prefix : String) -> Json raise {
  let snapshot = read_snapshot(id)
  if prefix != "" {
    @core.validate_path(prefix)
    guard snapshot.entries.any(fn(e) { e.path == prefix }) else {
      raise @core.Invalid("restore selection not found")
    }
  }
  ignore(verify(id))
  let chosen = snapshot.entries.filter(fn(e) {
    prefix == "" ||
    e.path == prefix ||
    e.path.has_prefix(prefix + "/") ||
    (e.kind == "dir" && prefix.has_prefix(e.path + "/"))
  })
  // Parent-first independent of the untrusted manifest entry order.
  chosen.sort_by(fn(a, b) { @core.path_order(a.path, b.path) })
  let staging = io("begin_restore", { "target": target })
  for entry in chosen {
    verify_entry(entry, true)
  }
  let result = io("finish_restore", Json::null())
  {
    "ok": true,
    "snapshot": id,
    "entries": chosen.length(),
    "destination": result,
    "transaction": staging,
  }
}

///|
pub fn list_snapshots() -> Json raise {
  let ids : Array[String] = @json.from_json(io("list", Json::null()))
  let out : Array[Json] = []
  for id in ids {
    let s = read_snapshot(id)
    let bytes = s.entries.fold(init=0L, fn(total, e) { total + e.size })
    out.push({
      "id": id,
      "created": s.created,
      "label": s.label,
      "entries": s.entries.length(),
      "logical_bytes": Json(bytes),
    })
  }
  { "ok": true, "snapshots": Json(out) }
}

///|
pub fn compare_snapshots(before : String, after : String) -> Json raise {
  let changes = @core.diff(read_snapshot(before), read_snapshot(after))
  { "ok": true, "changes": Json(changes) }
}
