///|
test "durable transitions never turn a crash marker into completion" {
  assert_true(operation_transition("prepared", "running"))
  assert_true(operation_transition("running", "paused"))
  assert_true(operation_transition("failed", "running"))
  assert_false(operation_transition("prepared", "completed"))
  assert_false(operation_transition("completed", "running"))
  assert_false(operation_transition("unknown", "completed"))
}

///|
test "cleanup clock refuses rollback and excessive forward jump" {
  assert_true(clock_guard(100L, 110L, 20L))
  assert_false(clock_guard(100L, 99L, 20L))
  assert_false(clock_guard(100L, 121L, 20L))
  expect_error(fn() raise { ignore(clock_guard(-1L, 10L, 20L)) })
  expect_error(fn() raise { ignore(clock_guard(1L, 10L, 0L)) })
}

///|
test "file checkpoints enforce path, type and original profile budgets" {
  let s = sample()
  let file = s.entries.filter(fn(e) { e.kind == "file" })[0]
  validate_checkpoint_entry(file, s.config, Limits::default())
  validate_checkpoint_entry(file, s.config, Limits::large())
  expect_error(fn() raise {
    validate_checkpoint_entry(
      { ..file, path: "../escape", },
      s.config,
      Limits::default(),
    )
  })
  expect_error(fn() raise {
    validate_checkpoint_entry(
      { ..file, kind: "dir", },
      s.config,
      Limits::default(),
    )
  })
  expect_error(fn() raise {
    validate_checkpoint_entry(
      { ..file, size: file.size + 1L, },
      s.config,
      Limits::default(),
    )
  })
}
