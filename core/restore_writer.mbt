///|
/// Deterministic recovery write planning; filesystem ownership, byte comparison,
/// fsync and no-replace publication must additionally be enforced by the host.
pub(all) struct RestoreSpan {
  start : Int64
  length : Int64
} derive(Debug, ToJson, FromJson)

///|
pub extend RestoreSpan with @debug.Debug::{to_repr}

///|
pub extend RestoreSpan with ToJson::{to_json}

///|
pub extend RestoreSpan with @json.FromJson::{from_json}

///|
pub(all) struct RestoreWritePlan {
  verify : Int32
  offset : Int64
  end : Int64
  writes : Array[RestoreSpan]
  checkpoint : Bool
} derive(Debug, ToJson)

///|
pub extend RestoreWritePlan with @debug.Debug::{to_repr}

///|
pub extend RestoreWritePlan with ToJson::{to_json}

///|
pub struct RestoreWriter {
  declared : Int64
  prefix : Int64
  published : Bool
  sparse : Array[RestoreSpan]?
  mut position : Int64
}

///|
/// Prefix may be ahead of the durable checkpoint after a crash. Such bytes are
/// verified, never blindly overwritten or trusted. Sparse extents are bounded,
/// ordered and non-overlapping; a sparse hole does not authorize skipping reads.
pub fn RestoreWriter::new(
  declared : Int64,
  written : Int64,
  checkpointed : Int64,
  completed : Bool,
  published : Bool,
  sparse : Array[RestoreSpan]?,
) -> RestoreWriter raise {
  validate_restore_prefix(written, declared, checkpointed)
  guard (!completed || written == declared) && (!published || completed) else {
    raise Invalid("published/completed restore size inconsistent")
  }
  if sparse is Some(ranges) {
    guard ranges.length() <= 4096 else { raise Invalid("sparse extent budget") }
    let mut end = 0L
    for r in ranges {
      guard r.start >= end &&
        r.length > 0L &&
        r.start <= declared &&
        r.length <= declared - r.start else {
        raise Invalid("invalid sparse extent")
      }
      end = r.start + r.length
    }
  }
  { declared, prefix: written, published, sparse, position: 0L, }
}

///|
/// Plans exactly one authenticated source chunk. Advance is per stream replay,
/// not a durable checkpoint: after IO failure the host discards/reconstructs it.
pub fn RestoreWriter::chunk(
  self : RestoreWriter,
  length : Int32,
) -> RestoreWritePlan raise {
  guard length > 0 &&
    length <= 1048576 &&
    length.to_int64() <= self.declared - self.position else {
    raise Invalid("restore chunk outside file budget")
  }
  let offset = self.position
  let end = offset + length.to_int64()
  let verified = if self.prefix <= offset {
    0L
  } else if self.prefix >= end {
    length.to_int64()
  } else {
    self.prefix - offset
  }
  let start = offset + verified
  let checkpoint = verified < length.to_int64()
  guard !self.published || !checkpoint else {
    raise Invalid("published restore incomplete")
  }
  let writes : Array[RestoreSpan] = []
  if checkpoint {
    match self.sparse {
      None => writes.push({ start, length: end - start, })
      Some(ranges) =>
        for r in ranges {
          let from = if start > r.start { start } else { r.start }
          let limit = r.start + r.length
          let to = if end < limit { end } else { limit }
          if to > from {
            writes.push({ start: from, length: to - from, })
          }
        }
    }
  }
  self.position = end
  { verify: verified.to_int(), offset, end, writes, checkpoint, }
}

///|
pub fn RestoreWriter::finish(self : RestoreWriter) -> Unit raise {
  guard self.position == self.declared else {
    raise Invalid("restore stream truncated")
  }
}

///|
/// A target is only recognized after the durable publishing intent. Its inode
/// binding is separately checked by the host, not inferred from this decision.
pub fn validate_restore_publication(
  phase : String,
  target : Bool,
  stage_tree : Bool,
) -> Unit raise {
  guard phase == "prepared" ||
    phase == "running" ||
    phase == "failed" ||
    phase == "publishing" ||
    phase == "completed" else {
    raise Invalid("unknown restore phase")
  }
  if target {
    guard (phase == "publishing" || phase == "completed") && !stage_tree else {
      raise Invalid("uncertain restore publication")
    }
  } else {
    guard phase != "completed" && stage_tree else {
      raise Invalid("restore tree missing")
    }
  }
}
