///|
test "selection includes ancestors exactly once and refuses unknown paths" {
  let s = sample()
  assert_eq(select_entries(s, []), s.entries)
  assert_eq(
    select_entries(s, [s.entries[1].path, s.entries[1].path]).length(),
    2,
  )
  expect_error(fn() raise { ignore(select_entries(s, ["../escape"])) })
  expect_error(fn() raise { ignore(select_entries(s, ["unknown"])) })
  expect_error(fn() raise {
    ignore(select_entries(s, Array::make(129, s.entries[0].path)))
  })
}

///|
test "optional metadata preserves public snapshot model and old manifests" {
  let s = sample()
  let old = s.encode()
  assert_eq(decode_metadata(old, text_digest(old)), [])
  let metadata = [
    { path: s.entries[0].path, mtime_ms: 1700000000000L, mode: 416, },
  ]
  let text = encode_with_metadata(s, metadata)
  assert_eq(decode_snapshot(text, text_digest(text)), s)
  assert_eq(decode_metadata(text, text_digest(text)), metadata)
}

///|
test "metadata must name existing entries and use safe exact fields" {
  let s = sample()
  for
    data in [
      [{ path: "../escape", mtime_ms: 0L, mode: 384, }],
      [{ path: s.entries[0].path, mtime_ms: -1L, mode: 384, }],
      [{ path: s.entries[0].path, mtime_ms: 0L, mode: 512, }],
      [
        { path: s.entries[0].path, mtime_ms: 0L, mode: 384, },
        { path: s.entries[0].path, mtime_ms: 0L, mode: 384, },
      ],
    ] {
    expect_error(fn() raise { ignore(encode_with_metadata(s, data)) })
  }
  let json = s.to_json()
  guard json is Object(fields) else { abort("expected object") }
  fields["metadata"] = [
    { "path": s.entries[0].path, "mtime_ms": "0", "mode": 0.5 },
  ]
  let text = json.stringify()
  expect_error(fn() raise { ignore(decode_snapshot(text, text_digest(text))) })
}

///|
test "precomputed gear lookup preserves the published formula" {
  for i = 0; i < 256; i = i + 1 {
    assert_eq(gear_table[i], gear(i.to_byte()))
  }
}
