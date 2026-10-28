///|
test "restore prefix never permits rewind, overflow or unowned append assumptions" {
  validate_restore_prefix(0L, 0L, 0L)
  validate_restore_prefix(4097L, 8000L, 4096L)
  expect_error(fn() raise { validate_restore_prefix(4095L, 8000L, 4096L) })
  expect_error(fn() raise { validate_restore_prefix(8001L, 8000L, 0L) })
  expect_error(fn() raise { validate_restore_prefix(0L, 68719476737L, 0L) })
  expect_error(fn() raise { validate_restore_prefix(-1L, 1L, 0L) })
}

///|
test "native fidelity cannot silently cross platforms or apply permissions" {
  validate_fidelity_policy("win32", "linux", "portable", false)
  validate_fidelity_policy("win32", "win32", "native", true)
  expect_error(fn() raise {
    validate_fidelity_policy("win32", "linux", "native", true)
  })
  expect_error(fn() raise {
    validate_fidelity_policy("linux", "linux", "native", false)
  })
  expect_error(fn() raise {
    validate_fidelity_policy("linux", "linux", "auto", true)
  })
}
