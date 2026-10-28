///|
/// Format 4 records are streamed, never a whole-snapshot entry array.
pub(all) struct PagedRecord {
  kind : String
  path : String
  id : String
  size : Int64
  pack : String
  offset : Int32
} derive(ToJson, FromJson, Debug)

///|
pub struct PagedLedger {
  mut entries : Int64
  mut chunks : Int64
  mut total : Int64
  mut active : Bool
  mut expected : Int64
  mut seen : Int64
}

///|
pub fn PagedLedger::new() -> PagedLedger {
  { entries: 0L, chunks: 0L, total: 0L, active: false, expected: 0L, seen: 0L, }
}

///|
pub fn PagedLedger::accept(
  self : PagedLedger,
  record : PagedRecord,
) -> Unit raise {
  match record.kind {
    "dir" | "file" => {
      guard !self.active &&
        record.id == "" &&
        record.pack == "" &&
        record.offset == 0 else {
        raise Invalid("paged entry boundary")
      }
      validate_path(record.path)
      guard record.size >= 0L &&
        record.size <= 68719476736L &&
        self.entries < 1000000L else {
        raise Invalid("paged entry budget")
      }
      if record.kind == "dir" {
        guard record.size == 0L else { raise Invalid("directory bytes") }
      } else {
        guard self.total + record.size <= 1099511627776L else {
          raise Invalid("paged total budget")
        }
        self.active = true
        self.expected = record.size
        self.seen = 0L
        self.total += record.size
      }
      self.entries += 1L
    }
    "chunk" => {
      guard self.active &&
        record.path == "" &&
        valid_id(record.id) &&
        valid_id(record.pack) &&
        record.size > 0L &&
        record.size <= 1048576L &&
        record.offset >= 6 &&
        record.offset.to_int64() + 36L + record.size <= 8388608L &&
        self.chunks < 32000000L &&
        self.seen + record.size <= self.expected else {
        raise Invalid("paged chunk bounds")
      }
      self.seen += record.size
      self.chunks += 1L
    }
    "end" => {
      guard self.active &&
        record.path == "" &&
        valid_id(record.id) &&
        record.pack == "" &&
        record.offset == 0 &&
        record.size == self.expected &&
        self.seen == self.expected else {
        raise Invalid("paged file incomplete")
      }
      self.active = false
    }
    _ => raise Invalid("unknown paged record")
  }
}

///|
pub fn PagedLedger::finish(
  self : PagedLedger,
  entries : Int64,
  chunks : Int64,
  total : Int64,
) -> Unit raise {
  guard !self.active &&
    self.entries == entries &&
    self.chunks == chunks &&
    self.total == total else {
    raise Invalid("paged root totals or unfinished file")
  }
}

///|
pub fn validate_page_link(
  sequence : Int32,
  previous : String,
  records : Int32,
  encoded_bytes : Int32,
) -> Unit raise {
  guard sequence >= 0 &&
    sequence < 1000000 &&
    records > 0 &&
    records <= 128 &&
    encoded_bytes > 0 &&
    encoded_bytes <= 262144 &&
    (if sequence == 0 { previous == "" } else { valid_id(previous) }) else {
    raise Invalid("paged manifest link or budget")
  }
}

///|
test "paged ledger rejects invalid directory, nested entries and unknown records" {
  let directory : PagedRecord = {
    kind: "dir",
    path: "folder",
    id: "",
    size: 0L,
    pack: "",
    offset: 0,
  }
  let ledger = PagedLedger::new()
  ledger.accept(directory)
  ledger.finish(1L, 0L, 0L)
  for
    record in [
      { ..directory, size: 1L, },
      { ..directory, id: digest(b"bad"), },
      { ..directory, kind: "unknown", },
      { ..directory, kind: "file", size: 68719476737L, },
      { ..directory, kind: "chunk", size: 1L, },
      { ..directory, kind: "end", },
    ] {
    assert_true(
      try {
        PagedLedger::new().accept(record)
        false
      } catch {
        _ => true
      },
    )
  }
  let active = PagedLedger::new()
  active.accept({ ..directory, kind: "file", path: "file", size: 1L, })
  assert_true(
    try {
      active.accept(directory)
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      active.finish(1L, 0L, 1L)
      false
    } catch {
      _ => true
    },
  )
  for count in [0, 129] {
    assert_true(
      try {
        validate_page_link(0, "", count, 1)
        false
      } catch {
        _ => true
      },
    )
  }
  assert_true(
    try {
      validate_page_link(1000000, digest(b"page"), 1, 1)
      false
    } catch {
      _ => true
    },
  )
}

///|
test "paged ledger validates cross-page file boundaries and exact totals" {
  let ledger = PagedLedger::new()
  ledger.accept({
    kind: "file",
    path: "a.txt",
    id: "",
    size: 3L,
    pack: "",
    offset: 0,
  })
  ledger.accept({
    kind: "chunk",
    path: "",
    id: digest(b"abc"),
    size: 3L,
    pack: digest(b"pack"),
    offset: 6,
  })
  ledger.accept({
    kind: "end",
    path: "",
    id: digest(b"abc"),
    size: 3L,
    pack: "",
    offset: 0,
  })
  ledger.finish(1L, 1L, 3L)
  assert_true(
    try {
      ledger.finish(2L, 1L, 3L)
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ledger.accept({
        kind: "chunk",
        path: "",
        id: digest(b"abc"),
        size: 3L,
        pack: digest(b"pack"),
        offset: 6,
      })
      false
    } catch {
      _ => true
    },
  )
}

///|
test "paged format refuses traversal, overflow, incomplete file and broken page links" {
  let ledger = PagedLedger::new()
  assert_true(
    try {
      ledger.accept({
        kind: "file",
        path: "../escape",
        id: "",
        size: 0L,
        pack: "",
        offset: 0,
      })
      false
    } catch {
      _ => true
    },
  )
  ledger.accept({
    kind: "file",
    path: "empty",
    id: "",
    size: 0L,
    pack: "",
    offset: 0,
  })
  assert_true(
    try {
      ledger.finish(1L, 0L, 0L)
      false
    } catch {
      _ => true
    },
  )
  ledger.accept({
    kind: "end",
    path: "",
    id: digest(b""),
    size: 0L,
    pack: "",
    offset: 0,
  })
  ledger.finish(1L, 0L, 0L)
  validate_page_link(0, "", 128, 262144)
  validate_page_link(1, digest(b"page"), 1, 1)
  assert_true(
    try {
      validate_page_link(0, digest(b"bad"), 1, 1)
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      validate_page_link(1, "", 1, 1)
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      validate_page_link(0, "", 129, 1)
      false
    } catch {
      _ => true
    },
  )
}
