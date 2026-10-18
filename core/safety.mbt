///|
/// 0 unknown, 1 current, 2 stale, 3 different snapshot, 4 future timestamp.
/// Evidence freshness is not a guarantee that a future restore will succeed.
pub fn evidence_state(
  snapshot : String,
  observed_snapshot : String,
  observed_at : Int64,
  now : Int64,
  max_age : Int64,
) -> Int32 raise {
  guard now >= 0L && max_age > 0L else {
    raise Invalid("invalid evidence clock")
  }
  if snapshot == "" || observed_snapshot == "" || observed_at < 0L {
    return 0
  }
  if snapshot != observed_snapshot {
    return 3
  }
  if now < observed_at {
    return 4
  }
  if now - observed_at > max_age {
    2
  } else {
    1
  }
}

///|
/// Only one overdue execution is owed; a clock jump never creates a backlog.
pub fn schedule_due(
  enabled : Bool,
  running : Bool,
  attempts : Int32,
  limit : Int32,
  previous_clock : Int64,
  now : Int64,
  due : Int64,
  max_forward : Int64,
) -> Bool raise {
  guard attempts >= 0 && limit > 0 && limit <= 10 && due >= 0L else {
    raise Invalid("invalid scheduler bounds")
  }
  enabled &&
  !running &&
  attempts < limit &&
  clock_guard(previous_clock, now, max_forward) &&
  now >= due
}
