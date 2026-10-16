///|
test "retention is deterministic and never drops protected snapshots" {
  let records = [
    RetentionRecord::{ id: digest(b"a"), created: "2026-10-01T10:00:00.000Z", },
    RetentionRecord::{ id: digest(b"b"), created: "2026-10-02T10:00:00.000Z", },
    RetentionRecord::{ id: digest(b"c"), created: "2026-10-02T11:00:00.000Z", },
  ]
  assert_eq(retention_keep(records, 1, 0, 0, 0, []), [digest(b"c")])
  assert_eq(retention_keep(records, 1, 2, 0, 0, []).length(), 2)
  assert_eq(retention_keep(records, 1, 0, 0, 0, [digest(b"a")]).length(), 2)
  expect_error(fn() raise { ignore(retention_keep(records, 0, 0, 0, 0, [])) })
}

///|
test "retention refuses malformed times and unknown protection" {
  for date in ["bad", "2026-02-29T00:00:00.000Z", "2026-13-01T00:00:00.000Z"] {
    expect_error(fn() raise {
      ignore(
        retention_keep([{ id: digest(b"a"), created: date, }], 1, 0, 0, 0, []),
      )
    })
  }
  assert_true(calendar_day("2024-02-29T00:00:00.000Z") > 0)
  expect_error(fn() raise {
    ignore(retention_keep([], 1, 0, 0, 0, [digest(b"missing")]))
  })
}

///|
test "capacity preserves exact int64 and free reserve" {
  assert_eq(capacity_state(68719476736L, 68719476735L, 0L), 1)
  assert_eq(capacity_state(100L, 120L, 30L), 2)
  assert_eq(capacity_state(100L, 120L, 20L), 0)
  expect_error(fn() raise { ignore(capacity_state(-1L, 1L, 0L)) })
}

///|
test "large data profile requires explicit limits and preserves format 1 ceilings" {
  let chunks : Array[ChunkRef] = Array::make(2048, {
    id: digest(b"chunk"),
    size: 1048576,
  })
  chunks.push({ id: digest(b"last"), size: 1, })
  let snapshot : Snapshot = {
    format: 3,
    created: "2026-10-16T00:00:00.000Z",
    label: "large profile",
    config: { min_size: 1048576, average_size: 1048576, max_size: 1048576, },
    entries: [
      {
        path: "large.bin",
        kind: "file",
        size: 2147483649L,
        hash: digest(b"file"),
        chunks,
      },
    ],
  }
  snapshot.validate(limits=Limits::large())
  let text = snapshot.encode(limits=Limits::large())
  assert_eq(
    decode_snapshot(text, text_digest(text), limits=Limits::large()).entries[0].size,
    2147483649L,
  )
  expect_error(fn() raise { snapshot.validate() })
  expect_error(fn() raise {
    Snapshot::{ ..snapshot, format: 1, }.validate(limits=Limits::large())
  })
  expect_error(fn() raise { Limits::large().validate() })
}

///|
test "source anomaly rules use exact percentages and strict budgets" {
  assert_eq(source_change_state(0, 0, false, 30), 1)
  assert_eq(source_change_state(0, 0, true, 30), 0)
  assert_eq(source_change_state(70, 100, false, 30), 0)
  assert_eq(source_change_state(69, 100, false, 30), 2)
  expect_error(fn() raise { ignore(source_change_state(1, -1, false, 30)) })
}
