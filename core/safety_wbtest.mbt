///|
test "evidence must refer to the same snapshot within its own fresh window" {
  assert_eq(evidence_state("a", "a", 100L, 110L, 20L), 1)
  assert_eq(evidence_state("a", "", -1L, 110L, 20L), 0)
  assert_eq(evidence_state("a", "a", 100L, 121L, 20L), 2)
  assert_eq(evidence_state("a", "b", 100L, 110L, 20L), 3)
  assert_eq(evidence_state("a", "a", 120L, 110L, 20L), 4)
  expect_error(fn() raise { ignore(evidence_state("a", "a", 0L, -1L, 20L)) })
}

///|
test "scheduler refuses disabled, active, exhausted and discontinuous clocks" {
  assert_true(schedule_due(true, false, 0, 3, 100L, 110L, 105L, 20L))
  assert_false(schedule_due(false, false, 0, 3, 100L, 110L, 105L, 20L))
  assert_false(schedule_due(true, true, 0, 3, 100L, 110L, 105L, 20L))
  assert_false(schedule_due(true, false, 3, 3, 100L, 110L, 105L, 20L))
  assert_false(schedule_due(true, false, 0, 3, 100L, 99L, 105L, 20L))
  assert_false(schedule_due(true, false, 0, 3, 100L, 121L, 105L, 20L))
  assert_false(schedule_due(true, false, 0, 3, 100L, 110L, 111L, 20L))
  expect_error(fn() raise {
    ignore(schedule_due(true, false, -1, 3, 100L, 110L, 105L, 20L))
  })
}

///|
test "scheduler bounded cross-product agrees with an independent decision model" {
  for enabled in [false, true] {
    for running in [false, true] {
      for attempts = 0; attempts <= 4; attempts = attempts + 1 {
        for now in [99L, 100L, 110L, 120L, 121L] {
          for due in [0L, 110L, 130L] {
            let expected = enabled &&
              !running &&
              attempts < 3 &&
              now >= 100L &&
              now <= 120L &&
              now >= due
            assert_eq(
              schedule_due(enabled, running, attempts, 3, 100L, now, due, 20L),
              expected,
            )
          }
        }
      }
    }
  }
}
