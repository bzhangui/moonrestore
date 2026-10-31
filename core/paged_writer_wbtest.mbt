///|
test "page writer requires acknowledged pages and produces precise root totals" {
  let writer = PagedWriter::new()
  let record : PagedRecord = {
    kind: "dir",
    path: "sample",
    id: "",
    size: 0L,
    pack: "",
    offset: 0,
  }
  for _ in 0..<128 {
    assert_false(writer.needs_page(100))
    writer.record(record, 100)
  }
  assert_true(writer.needs_page(100))
  let refused = try {
    writer.record(record, 100)
    false
  } catch {
    _ => true
  }
  assert_true(refused)
  writer.seal_page("a".repeat(64))
  assert_eq(writer.summary().entries, 128L)
  assert_eq(writer.summary().pages, 1)
  assert_eq(writer.summary().previous, "a".repeat(64))
  assert_eq(writer.summary().records, 0)
  for size in [-1, 0, 245001, 2147483647] {
    assert_true(
      try {
        ignore(writer.needs_page(size))
        false
      } catch {
        _ => true
      },
    )
  }
  assert_true(
    try {
      writer.seal_page("a".repeat(64))
      false
    } catch {
      _ => true
    },
  )
  let file : PagedRecord = {
    kind: "file",
    path: "large",
    id: "",
    size: 68719476736L,
    pack: "",
    offset: 0,
  }
  for _ in 0..<16 {
    writer.record(file, 100)
  }
  assert_eq(writer.summary().total, 1099511627776L)
  assert_true(
    try {
      writer.record(file, 100)
      false
    } catch {
      _ => true
    },
  )
}

///|
test "streamed GC planner bounds audited inventory and cannot complete a prefix" {
  let gc = GCPlanner::new(0, 3, 2)
  assert_true(gc.select(8388704L))
  assert_true(
    try {
      ignore(gc.finish())
      false
    } catch {
      _ => true
    },
  )
  assert_true(gc.select(1L))
  assert_false(gc.select(0L))
  assert_eq(gc.finish().bytes, 8388705L)
  assert_eq(gc.finish().selected, 2)
  assert_true(
    try {
      ignore(gc.select(1L))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(GCPlanner::new(1000001, 0, 1))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(GCPlanner::new(0, 2000001, 1))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(GCPlanner::new(0, 0, 0))
      false
    } catch {
      _ => true
    },
  )
  assert_eq(GCPlanner::new(0, 0, 1000).finish().bytes, 0L)
}

///|
test "deterministic paging and selection differential corpus" {
  let record : PagedRecord = {
    kind: "dir",
    path: "x",
    id: "",
    size: 0L,
    pack: "",
    offset: 0,
  }
  for salt in 0..<12 {
    let writer = PagedWriter::new()
    let mut count = 0
    let mut encoded = 2
    let mut pages = 0
    for i in 0..<1200 {
      let bytes = 20 + (i * 37 + salt * 997) % 5000
      let flush = count == 128 || encoded + bytes > 250000
      assert_eq(writer.needs_page(bytes), flush)
      if flush {
        writer.seal_page("b".repeat(64))
        count = 0
        encoded = 2
        pages += 1
      }
      writer.record(record, bytes)
      encoded += bytes + (if count > 0 { 1 } else { 0 })
      count += 1
      assert_eq(writer.summary().records, count)
      assert_eq(writer.summary().pages, pages)
    }
    for batch in 1..<24 {
      let gc = GCPlanner::new(salt, 80, batch)
      let mut selected = 0L
      for i in 0..<80 {
        let bytes = (i + salt).to_int64()
        assert_eq(gc.select(bytes), i < batch)
        if i < batch {
          selected += bytes
        }
      }
      assert_eq(gc.finish().bytes, selected)
    }
  }
}
