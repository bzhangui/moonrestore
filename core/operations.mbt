///|
/// Durable task transitions; completion is not inferred from an interrupted run.
pub fn operation_transition(before : String, after : String) -> Bool {
  match (before, after) {
    ("prepared", "running") | ("paused", "running") | ("failed", "running") =>
      true
    ("running", "paused") | ("running", "failed") | ("running", "completed") =>
      true
    _ => false
  }
}

///|
pub fn validate_checkpoint_entry(
  entry : Entry,
  config : ChunkConfig,
  limits : Limits,
) -> Unit raise {
  validate_path(entry.path)
  guard entry.kind == "file" else { raise Invalid("checkpoint is not a file") }
  let model : Snapshot = {
    format: if limits.max_file_bytes > 2147483648L {
      3
    } else {
      1
    },
    created: "",
    label: "",
    config,
    entries: [{ ..entry, path: "checkpoint", }],
  }
  model.validate(limits~)
}

///|
/// Conservative cleanup gate; wall-clock jumps are never proof of elapsed grace.
pub fn clock_guard(
  previous : Int64,
  current : Int64,
  max_forward : Int64,
) -> Bool raise {
  guard previous >= 0L && current >= 0L && max_forward > 0L else {
    raise Invalid("invalid clock guard")
  }
  current >= previous && current - previous <= max_forward
}
