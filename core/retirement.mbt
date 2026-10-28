///|
/// An elapsed grace interval is necessary but not sufficient for deletion.
/// The OS adapter must additionally bind inventory, policy and replacement proof.
pub fn retirement_ready(
  requested : Int64,
  current : Int64,
  grace_days : Int32,
) -> Bool raise {
  guard requested >= 0L && current >= 0L && grace_days >= 7 && grace_days <= 365 else {
    raise Invalid("invalid retirement grace")
  }
  clock_guard(requested, current, 366L * 86400000L) &&
  current - requested >= grace_days.to_int64() * 86400000L
}

///|
/// Same-boot monotonic observation corroborates wall-clock grace. Reboot,
/// rollback or >60s divergence requires a new observation/request, not a guess.
pub fn retirement_clock_ready(
  requested : Int64,
  current : Int64,
  old_uptime : Int64,
  uptime : Int64,
  grace_days : Int32,
) -> Bool raise {
  guard old_uptime >= 0L && uptime >= 0L else {
    raise Invalid("invalid retirement monotonic clock")
  }
  if !retirement_ready(requested, current, grace_days) || uptime < old_uptime {
    return false
  }
  let wall = current - requested
  let elapsed = uptime - old_uptime
  elapsed >= grace_days.to_int64() * 86400000L &&
  wall - elapsed <= 60000L &&
  elapsed - wall <= 60000L
}
