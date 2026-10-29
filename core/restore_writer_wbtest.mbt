///|
test "restore writer verifies crash-ahead prefix before appending" {
  let w = RestoreWriter::new(12L, 7L, 4L, false, false, None)
  let a = w.chunk(4)
  assert_eq(a.verify, 4)
  assert_false(a.checkpoint)
  let b = w.chunk(4)
  assert_eq(b.verify, 3)
  assert_true(b.checkpoint)
  assert_eq(b.writes[0].start, 7L)
  assert_eq(b.writes[0].length, 1L)
  let c = w.chunk(4)
  assert_eq(c.verify, 0)
  assert_eq(c.end, 12L)
  w.finish()
  expect_error(fn() raise { ignore(w.chunk(1)) })
}

///|
test "restore writer sparse holes keep logical readback and progress" {
  let w = RestoreWriter::new(
    12L,
    2L,
    0L,
    false,
    false,
    Some([{ start: 1L, length: 3L, }, { start: 7L, length: 2L, }]),
  )
  let a = w.chunk(6)
  assert_eq(a.verify, 2)
  assert_eq(a.writes[0].start, 2L)
  assert_eq(a.writes[0].length, 2L)
  let b = w.chunk(6)
  assert_eq(b.writes[0].start, 7L)
  assert_eq(b.end, 12L)
  w.finish()
  let holes = RestoreWriter::new(4L, 0L, 0L, false, false, Some([]))
  let h = holes.chunk(4)
  assert_true(h.checkpoint)
  assert_eq(h.writes.length(), 0)
  holes.finish()
}

///|
test "restore writer rejects truncation overflow rewinds and malformed extents" {
  let w = RestoreWriter::new(4L, 0L, 0L, false, false, None)
  expect_error(fn() raise { w.finish() })
  for n in [-1, 0, 5, 1048577] {
    expect_error(fn() raise { ignore(w.chunk(n)) })
  }
  for
    span in [
      { start: -1L, length: 1L, },
      { start: 0L, length: 0L, },
      { start: 3L, length: 2L, },
      { start: 9223372036854775807L, length: 1L, },
    ] {
    expect_error(fn() raise {
      ignore(RestoreWriter::new(4L, 0L, 0L, false, false, Some([span])))
    })
  }
  expect_error(fn() raise {
    ignore(
      RestoreWriter::new(
        4L,
        0L,
        0L,
        false,
        false,
        Some([{ start: 1L, length: 2L, }, { start: 2L, length: 1L, }]),
      ),
    )
  })
  expect_error(fn() raise {
    ignore(RestoreWriter::new(4L, 2L, 3L, false, false, None))
  })
  expect_error(fn() raise {
    ignore(RestoreWriter::new(4L, 2L, 0L, true, true, None))
  })
  expect_error(fn() raise {
    ignore(RestoreWriter::new(4L, 4L, 0L, false, true, None))
  })
  RestoreWriter::new(0L, 0L, 0L, true, true, None).finish()
}

///|
test "restore writer publication never infers completion from an existing target" {
  validate_restore_publication("running", false, true)
  validate_restore_publication("failed", false, true)
  validate_restore_publication("publishing", true, false)
  validate_restore_publication("completed", true, false)
  for phase in ["prepared", "running", "failed", "unknown"] {
    expect_error(fn() raise { validate_restore_publication(phase, true, false) })
  }
  expect_error(fn() raise {
    validate_restore_publication("publishing", true, true)
  })
  expect_error(fn() raise {
    validate_restore_publication("completed", false, true)
  })
}
