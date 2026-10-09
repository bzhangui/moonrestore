///| Portable, case-insensitive path policy. Never resolve a manifest path before this.
pub fn validate_path(path : String) -> Unit raise BackupError {
  guard path.length() > 0 && path.length() <= 1024 else {
    raise Invalid("path length out of bounds")
  }
  for c in path {
    if c.to_int() < 32 || c.to_int() == 127 || c == '\\' ||
      c == ':' || c == '*' || c == '?' || c == '"' ||
      c == '<' || c == '>' || c == '|' {
      raise Invalid("unsafe path: \{path}")
    }
  }
  for part in path.split("/") {
    let s = part.to_owned()
    guard s != "" && s != "." && s != ".." && s.length() <= 255 &&
      !s.has_suffix(" ") && !s.has_suffix(".") else {
      raise Invalid("unsafe path component: \{path}")
    }
    let stem = s.split(".").to_array()[0].to_owned().to_upper()
    if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
      stem == "CONIN$" || stem == "CONOUT$" ||
      (stem.length() == 4 && (stem.has_prefix("COM") || stem.has_prefix("LPT")) &&
       stem[3] >= '1' && stem[3] <= '9') {
      raise Invalid("reserved Windows name: \{path}")
    }
  }
}

///|
pub fn Snapshot::validate(self : Snapshot, limits? : Limits = Limits::default()) -> Unit raise BackupError {
  guard self.format == 1 else { raise Invalid("unsupported snapshot format") }
  self.config.validate()
  guard self.label.length() <= 200 && self.created.length() <= 80 &&
    self.entries.length() <= limits.max_files else {
    raise Invalid("snapshot metadata budget exceeded")
  }
  let paths : Map[String, String] = Map([])
  let mut total = 0L
  let mut chunks = 0
  for entry in self.entries {
    validate_path(entry.path)
    let key = entry.path.to_lower()
    guard !paths.contains(key) else { raise Invalid("duplicate/case-colliding path") }
    paths[key] = entry.kind
    guard entry.size >= 0L && entry.size <= limits.max_file_bytes else {
      raise Invalid("file size limit exceeded")
    }
    if entry.kind == "dir" {
      guard entry.size == 0L && entry.hash == "" && entry.chunks.is_empty() else {
        raise Invalid("invalid directory metadata")
      }
    } else {
      guard entry.kind == "file" && valid_id(entry.hash) else {
        raise Invalid("invalid entry kind or file hash")
      }
      let mut sum = 0L
      for part in entry.chunks {
        guard valid_id(part.id) && part.size > 0 && part.size <= self.config.max_size else {
          raise Invalid("invalid chunk reference")
        }
        sum += part.size.to_int64()
        guard sum <= limits.max_file_bytes else { raise Invalid("chunk size budget exceeded") }
        chunks += 1
        guard chunks <= limits.max_chunks else { raise Invalid("chunk count budget exceeded") }
      }
      guard sum == entry.size else { raise Invalid("file/chunk size mismatch") }
      guard entry.size != 0L || entry.hash == digest(b"") else {
        raise Invalid("invalid empty-file hash")
      }
      total += entry.size
      guard total <= limits.max_total_bytes else { raise Invalid("snapshot byte limit exceeded") }
    }
  }
  for entry in self.entries {
    let parts = entry.path.split("/").to_array()
    let mut parent = ""
    for i = 0; i < parts.length() - 1; i = i + 1 {
      parent = if i == 0 { parts[i].to_owned() } else { parent + "/" + parts[i].to_owned() }
      guard paths.get(parent.to_lower()) == Some("dir") else {
        raise Invalid("missing parent directory or file/directory conflict")
      }
    }
  }
}

///|
pub fn Snapshot::encode(self : Snapshot) -> String raise BackupError {
  self.validate()
  let text = self.to_json().stringify()
  guard @utf8.encode(text).length() <= Limits::default().max_manifest_bytes else {
    raise Invalid("manifest byte limit exceeded")
  }
  text
}

///| Verify raw manifest bytes before parsing and limit JSON nesting explicitly.
pub fn decode_snapshot(text : String, expected_id : String) -> Snapshot raise {
  guard valid_id(expected_id) && text_digest(text) == expected_id else {
    raise Invalid("manifest SHA-256 mismatch")
  }
  guard @utf8.encode(text).length() <= Limits::default().max_manifest_bytes else {
    raise Invalid("manifest byte limit exceeded")
  }
  check_json_depth(text)
  let snapshot : Snapshot = @json.from_json(@json.parse(text))
  snapshot.validate()
  snapshot
}

///| Depth preflight before allocating JSON containers; braces in strings are ignored.
pub fn check_json_depth(text : String) -> Unit raise BackupError {
  let mut depth = 0
  let mut quoted = false
  let mut escaped = false
  for c in text {
    if quoted {
      if escaped { escaped = false } else if c == '\\' { escaped = true } else if c == '"' { quoted = false }
    } else if c == '"' { quoted = true } else if c == '{' || c == '[' {
      depth += 1
      guard depth <= 16 else { raise Invalid("JSON nesting limit exceeded") }
    } else if c == '}' || c == ']' { depth -= 1 }
  }
}

///|
pub fn verify_chunk(part : ChunkRef, data : Bytes) -> Unit raise BackupError {
  guard part.size == data.length() && part.id == digest(data) else {
    raise Invalid("missing/corrupt object: \{part.id}")
  }
}

///|
pub(all) struct Change {
  path : String
  change : String
} derive(Eq, Debug, ToJson)

///|
pub fn diff(before : Snapshot, after : Snapshot) -> Array[Change] raise BackupError {
  before.validate()
  after.validate()
  let old : Map[String, Entry] = Map([])
  let current : Map[String, Entry] = Map([])
  for entry in before.entries { old[entry.path] = entry }
  for entry in after.entries { current[entry.path] = entry }
  let out : Array[Change] = []
  for entry in after.entries {
    match old.get(entry.path) {
      None => out.push({ path: entry.path, change: "added" })
      Some(prev) => if prev.hash != entry.hash || prev.kind != entry.kind {
        out.push({ path: entry.path, change: "modified" })
      }
    }
  }
  for entry in before.entries {
    if !current.contains(entry.path) { out.push({ path: entry.path, change: "removed" }) }
  }
  out.sort_by(fn(a,b) { a.path.compare(b.path) })
  out
}
