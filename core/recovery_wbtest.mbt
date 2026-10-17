///|
test "rescue requires known verified files and preserves directory topology" {
  let s = sample()
  let file = s.entries.filter(fn(e) { e.kind == "file" })[0]
  let entries = rescue_entries(s, [], [file.path])
  assert_true(entries.contains(file))
  assert_true(entries.filter(fn(e) { e.kind == "dir" }).length() > 0)
  expect_error(fn() raise { ignore(rescue_entries(s, [], ["missing"])) })
  expect_error(fn() raise {
    ignore(rescue_entries(s, [], [file.path, file.path]))
  })
  assert_true(rescue_entries(s, [], []).all(fn(e) { e.kind == "dir" }))
}

///|
test "verification batches cover files once and enforce exact budgets" {
  let s = sample()
  let first = verification_batch(s, 0, 1, 1048576L)
  assert_eq(first.paths.length(), 1)
  assert_eq(first.next, 1)
  let tail = verification_batch(s, first.total, 1, 1048576L)
  assert_eq(tail.next, tail.total)
  assert_true(tail.paths.is_empty())
  expect_error(fn() raise { ignore(verification_batch(s, -1, 1, 1L)) })
  expect_error(fn() raise { ignore(verification_batch(s, 0, 0, 1L)) })
  expect_error(fn() raise { ignore(verification_batch(s, 0, 1, 1L)) })
}
