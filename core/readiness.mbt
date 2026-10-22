///|
pub(all) struct RecoveryGoal {
  evidence_current : Bool
  rpo_state : String
  rto_state : String
  ready : Bool
} derive(ToJson)

///|
pub extend RecoveryGoal with ToJson::{to_json}

///|
/// -1 means no observation. RTO is a measured drill, never a production promise.
pub fn recovery_goal(
  age_ms : Int64,
  rpo_ms : Int64,
  observed_restore_ms : Int64,
  rto_ms : Int64,
  evidence_current : Bool,
) -> RecoveryGoal raise {
  guard age_ms >= -1L &&
    rpo_ms > 0L &&
    rpo_ms <= 31536000000L &&
    observed_restore_ms >= -1L &&
    rto_ms >= 0L &&
    rto_ms <= 86400000L else {
    raise Invalid("invalid recovery goal bounds")
  }
  let rpo_state = if age_ms == -1L {
    "unknown"
  } else if age_ms > rpo_ms {
    "exceeded"
  } else {
    "within"
  }
  let rto_state = if rto_ms == 0L {
    "not_configured"
  } else if observed_restore_ms == -1L {
    "unknown"
  } else if observed_restore_ms > rto_ms {
    "exceeded"
  } else {
    "within"
  }
  {
    evidence_current,
    rpo_state,
    rto_state,
    ready: evidence_current &&
    rpo_state == "within" &&
    (rto_state == "within" || rto_state == "not_configured"),
  }
}

///|
/// A local observation can detect absence only while the observer is running.
pub fn schedule_health(
  enabled : Bool,
  blocked : Bool,
  running : Bool,
  previous : Int64,
  now : Int64,
  due : Int64,
  grace_ms : Int64,
) -> String raise {
  guard previous >= 0L &&
    now >= 0L &&
    due >= 0L &&
    grace_ms > 0L &&
    grace_ms <= 86400000L else {
    raise Invalid("invalid schedule health bounds")
  }
  if !enabled {
    return "disabled"
  }
  if !clock_guard(previous, now, 2678400000L) {
    return "clock_discontinuity"
  }
  if blocked {
    return "blocked"
  }
  if now > due && now - due > grace_ms {
    return if running { "running_overdue" } else { "missing" }
  }
  if running {
    "running"
  } else if now >= due {
    "due"
  } else {
    "scheduled"
  }
}

///|
test "recovery goals never infer readiness from dates alone" {
  assert_true(recovery_goal(100L, 100L, 50L, 50L, true).ready)
  assert_true(!recovery_goal(100L, 100L, 50L, 50L, false).ready)
  assert_true(recovery_goal(101L, 100L, 0L, 0L, true).rpo_state == "exceeded")
  assert_true(recovery_goal(-1L, 100L, -1L, 50L, false).rto_state == "unknown")
  assert_true(recovery_goal(-1L, 100L, -1L, 0L, false).rpo_state == "unknown")
  assert_true(recovery_goal(0L, 100L, 51L, 50L, true).rto_state == "exceeded")
  assert_true(recovery_goal(0L, 100L, -1L, 0L, true).ready)
  assert_true(
    try {
      ignore(recovery_goal(-2L, 100L, 0L, 0L, true))
      false
    } catch {
      _ => true
    },
  )
  assert_true(
    try {
      ignore(recovery_goal(0L, 0L, 0L, 0L, true))
      false
    } catch {
      _ => true
    },
  )
}

///|
test "absence monitoring distinguishes disabled, blocked, running and clock failures" {
  assert_true(
    schedule_health(false, false, false, 100L, 90L, 100L, 10L) == "disabled",
  )
  assert_true(
    schedule_health(true, false, false, 100L, 90L, 100L, 10L) ==
    "clock_discontinuity",
  )
  assert_true(
    schedule_health(true, true, false, 100L, 100L, 100L, 10L) == "blocked",
  )
  assert_true(
    schedule_health(true, false, false, 100L, 111L, 100L, 10L) == "missing",
  )
  assert_true(
    schedule_health(true, false, true, 100L, 111L, 100L, 10L) ==
    "running_overdue",
  )
  assert_true(
    schedule_health(true, false, true, 100L, 105L, 100L, 10L) == "running",
  )
  assert_true(
    schedule_health(true, false, false, 100L, 105L, 100L, 10L) == "due",
  )
  assert_true(
    schedule_health(true, false, false, 100L, 100L, 110L, 10L) == "scheduled",
  )
}
