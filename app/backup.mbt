///|
struct SourceEntry {
  path : String
  kind : String
  size : Int64
} derive(FromJson)
///|
pub extend SourceEntry with @json.FromJson::{from_json}

///|
pub fn backup(
  source : String, label : String, excludes : Array[String],
  config : @core.ChunkConfig, limits : @core.Limits,
) -> Json raise {
  guard label.length() <= 200 else { raise @core.Invalid("label too long") }
  config.validate()
  let discovered : Array[SourceEntry] = @json.from_json(io("walk", {
    "source": source, "excludes": excludes.to_json(), "limits": limits.to_json(),
  }))
  // Validate the entire path tree before storing any source bytes.
  let placeholder = @core.Snapshot::{format: 1, created: "", label,
    config, entries: discovered.map(fn(e) {
      @core.Entry::{path: e.path, kind: e.kind, size: 0L,
        hash: if e.kind == "file" { @core.digest(b"") } else { "" }, chunks: []}
    }) }
  placeholder.validate(limits~)
  let entries : Array[@core.Entry] = []
  let mut total = 0L
  let mut stored = 0L
  let mut reused = 0L
  let mut chunk_count = 0
  for item in discovered {
    if item.kind == "dir" {
      entries.push({path: item.path, kind: "dir", size: 0L, hash: "", chunks: []})
      continue
    }
    io_unit("open_source", { "path": item.path })
    let chunker = @core.Chunker::new(config~)
    let hash = @core.Hasher::new()
    let parts : Array[@core.ChunkRef] = []
    let mut size = 0L
    while true {
      io_unit("read_source", {"max": 65536})
      let block = returned_bytes()
      if block.is_empty() { break }
      size += block.length().to_int64()
      guard size <= limits.max_file_bytes else { raise @core.Invalid("source file grew beyond limit") }
      hash.update(block)
      for bytes in chunker.push(block) {
        let (part, created) = store_object(bytes)
        parts.push(part)
        chunk_count += 1
        guard chunk_count <= limits.max_chunks else { raise @core.Invalid("chunk count limit exceeded") }
        if created { stored += bytes.length().to_int64() } else { reused += bytes.length().to_int64() }
      }
    }
    if chunker.finish() is Some(bytes) {
      let (part, created) = store_object(bytes)
      parts.push(part)
      chunk_count += 1
      guard chunk_count <= limits.max_chunks else { raise @core.Invalid("chunk count limit exceeded") }
      if created { stored += bytes.length().to_int64() } else { reused += bytes.length().to_int64() }
    }
    io_unit("close_source", Json::null())
    guard size == item.size else { raise @core.Invalid("source size changed") }
    total += size
    guard total <= limits.max_total_bytes else { raise @core.Invalid("total byte limit exceeded") }
    entries.push({path: item.path, kind: "file", size, hash: hash.finish(), chunks: parts})
  }
  io_unit("check_source", Json::null())
  let created : String = @json.from_json(io("clock", Json::null()))
  let snapshot : @core.Snapshot = {format: 1, created, label, config, entries}
  snapshot.validate(limits~)
  let text = snapshot.encode()
  let id = @core.text_digest(text)
  io_unit("commit", {"id": id}, data=@utf8.encode(text))
  {"ok": true, "snapshot": id, "entries": entries.length(),
    "logical_bytes": total.to_json(), "stored_bytes": stored.to_json(),
    "reused_bytes": reused.to_json(), "chunks": chunk_count}
}
