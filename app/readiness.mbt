///|
struct GoalInput {
  age_ms : Int64
  rpo_ms : Int64
  observed_ms : Int64
  rto_ms : Int64
  evidence_current : Bool
  enabled : Bool
  blocked : Bool
  running : Bool
  previous : Int64
  now : Int64
  due : Int64
  grace_ms : Int64
} derive(FromJson)

///|
pub extend GoalInput with @json.FromJson::{from_json}
