///|
/// Host IO must persist and read back a page before acknowledging its digest.
pub(all) struct PageWriteSummary {
  pages : Int32
  previous : String
  records : Int32
  entries : Int64
  chunks : Int64
  total : Int64
} derive(ToJson)

///|
pub extend PageWriteSummary with ToJson::{to_json}

///|
/// Streaming page boundaries and root totals; no filesystem or snapshot array.
pub struct PagedWriter {
  mut pages : Int32
  mut previous : String
  mut records : Int32
  mut encoded : Int32
  mut entries : Int64
  mut chunks : Int64
  mut total : Int64
}

///|
pub fn PagedWriter::new() -> PagedWriter {
  {
    pages: 0,
    previous: "",
    records: 0,
    encoded: 2,
    entries: 0L,
    chunks: 0L,
    total: 0L,
  }
}

///|
/// Match the bounded JSON array encoding including commas and brackets.
pub fn PagedWriter::needs_page(self : PagedWriter, bytes : Int32) -> Bool raise {
  guard bytes > 0 && bytes <= 245000 else {
    raise Invalid("encoded record budget")
  }
  self.records == 128 || self.encoded + bytes > 250000
}

///|
/// PagedLedger separately checks paths, chunk/file boundaries and locators.
pub fn PagedWriter::record(
  self : PagedWriter,
  record : PagedRecord,
  bytes : Int32,
) -> Unit raise {
  guard !self.needs_page(bytes) else {
    raise Invalid("flush acknowledged page first")
  }
  match record.kind {
    "dir" | "file" => {
      guard self.entries < 1000000L &&
        record.size >= 0L &&
        record.size <= 68719476736L &&
        (record.kind != "dir" || record.size == 0L) else {
        raise Invalid("writer entry budget")
      }
      if record.kind == "file" {
        guard record.size <= 1099511627776L - self.total else {
          raise Invalid("writer byte budget")
        }
        self.total += record.size
      }
      self.entries += 1L
    }
    "chunk" => {
      guard self.chunks < 32000000L &&
        record.size > 0L &&
        record.size <= 1048576L else {
        raise Invalid("writer chunk budget")
      }
      self.chunks += 1L
    }
    "end" => ()
    _ => raise Invalid("writer record kind")
  }
  self.encoded += bytes + (if self.records > 0 { 1 } else { 0 })
  self.records += 1
}

///|
pub fn PagedWriter::seal_page(
  self : PagedWriter,
  digest : String,
) -> Unit raise {
  guard self.records > 0 && self.pages < 1000000 && valid_id(digest) else {
    raise Invalid("writer page acknowledgement")
  }
  self.previous = digest
  self.pages += 1
  self.records = 0
  self.encoded = 2
}

///|
pub fn PagedWriter::summary(self : PagedWriter) -> PageWriteSummary {
  {
    pages: self.pages,
    previous: self.previous,
    records: self.records,
    entries: self.entries,
    chunks: self.chunks,
    total: self.total,
  }
}

///|
pub(all) struct GCPlanSummary {
  candidates : Int32
  selected : Int32
  bytes : Int64
} derive(ToJson)

///|
pub extend GCPlanSummary with ToJson::{to_json}

///|
/// Only sorted, independently audited unreachable members may be offered.
pub struct GCPlanner {
  candidates : Int32
  batch : Int32
  mut seen : Int32
  mut selected : Int32
  mut bytes : Int64
}

///|
/// An audited empty root set is allowed; the host must prove inventory binding.
pub fn GCPlanner::new(
  audited_roots : Int32,
  candidates : Int32,
  batch : Int32,
) -> GCPlanner raise {
  guard audited_roots >= 0 &&
    audited_roots <= 1000000 &&
    candidates >= 0 &&
    candidates <= 2000000 &&
    batch >= 1 &&
    batch <= 1000 else {
    raise Invalid("GC planner budget")
  }
  { candidates, batch, seen: 0, selected: 0, bytes: 0L, }
}

///|
pub fn GCPlanner::select(self : GCPlanner, bytes : Int64) -> Bool raise {
  guard self.seen < self.candidates && bytes >= 0L && bytes <= 8388704L else {
    raise Invalid("GC inventory stream budget")
  }
  self.seen += 1
  if self.selected < self.batch {
    self.selected += 1
    self.bytes += bytes
    true
  } else {
    false
  }
}

///|
pub fn GCPlanner::finish(self : GCPlanner) -> GCPlanSummary raise {
  guard self.seen == self.candidates else {
    raise Invalid("GC inventory incomplete")
  }
  { candidates: self.candidates, selected: self.selected, bytes: self.bytes, }
}
