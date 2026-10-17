///|
/// Keep only independently verified files and the original directories.
/// Omitted files and whole-repository health are never declared verified.
pub fn rescue_entries(
  snapshot : Snapshot,
  selections : Array[String],
  verified_files : Array[String],
) -> Array[Entry] raise BackupError {
  let chosen = select_entries(snapshot, selections)
  let files : Map[String, Bool] = Map([])
  for entry in chosen {
    if entry.kind == "file" {
      files[entry.path] = true
    }
  }
  let healthy : Map[String, Bool] = Map([])
  for path in verified_files {
    guard files.contains(path) && !healthy.contains(path) else {
      raise Invalid("unknown or duplicate verified rescue file")
    }
    healthy[path] = true
  }
  chosen.filter(fn(entry) {
    entry.kind == "dir" || healthy.contains(entry.path)
  })
}

///|
pub(all) struct VerificationBatch {
  paths : Array[String]
  next : Int32
  total : Int32
  bytes : Int64
} derive(ToJson)

///|
pub extend VerificationBatch with ToJson::{to_json}

///|
/// One bounded range for an immutable snapshot ID. Persist ID and cursor together.
pub fn verification_batch(
  snapshot : Snapshot,
  cursor : Int32,
  max_files : Int32,
  max_bytes : Int64,
) -> VerificationBatch raise BackupError {
  let selected = select_entries(snapshot, []).filter(fn(e) { e.kind == "file" })
  guard cursor >= 0 &&
    cursor <= selected.length() &&
    max_files >= 1 &&
    max_files <= 1000 &&
    max_bytes >= 1L &&
    max_bytes <= 1099511627776L else {
    raise Invalid("invalid verification batch budget/cursor")
  }
  let paths : Array[String] = []
  let mut bytes = 0L
  let mut next = cursor
  while next < selected.length() && paths.length() < max_files {
    let entry = selected[next]
    if bytes + entry.size > max_bytes {
      guard !paths.is_empty() else {
        raise Invalid("next file exceeds verification byte budget")
      }
      break
    }
    paths.push(entry.path)
    bytes += entry.size
    next += 1
  }
  { paths, next, total: selected.length(), bytes, }
}
