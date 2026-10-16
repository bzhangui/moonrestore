///|
/// Shared domain rule for UI previews, CLI restore and independent consumers.
pub fn select_entries(
  snapshot : Snapshot,
  selections : Array[String],
) -> Array[Entry] raise BackupError {
  snapshot.validate(
    limits=if snapshot.format == 3 {
      Limits::large()
    } else {
      Limits::default()
    },
  )
  guard selections.length() <= 128 else {
    raise Invalid("too many restore selections")
  }
  for value in selections {
    validate_path(value)
    guard snapshot.entries.any(fn(e) { e.path == value }) else {
      raise Invalid("restore selection not found")
    }
  }
  let chosen = snapshot.entries.filter(fn(e) {
    selections.is_empty() ||
    selections.any(fn(p) {
      e.path == p ||
      e.path.has_prefix(p + "/") ||
      (e.kind == "dir" && p.has_prefix(e.path + "/"))
    })
  })
  chosen.sort_by(fn(a, b) { path_order(a.path, b.path) })
  chosen
}
