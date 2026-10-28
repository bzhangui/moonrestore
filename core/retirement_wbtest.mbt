///|
test "retirement grace fails closed on rollback and unreviewed clock jumps" {
  assert_false(retirement_ready(1000L, 999L, 7))
  assert_false(retirement_ready(1000L, 604800999L, 7))
  assert_true(retirement_ready(1000L, 604801000L, 7))
  assert_false(retirement_ready(0L, 367L * 86400000L, 7))
  expect_error(fn() raise { ignore(retirement_ready(0L, 0L, 6)) })
  assert_false(retirement_clock_ready(0L, 8L * 86400000L, 0L, 1000L, 7))
  assert_false(retirement_clock_ready(0L, 8L * 86400000L, 1000L, 999L, 7))
  assert_true(
    retirement_clock_ready(0L, 8L * 86400000L, 1000L, 1000L + 8L * 86400000L, 7),
  )
}
