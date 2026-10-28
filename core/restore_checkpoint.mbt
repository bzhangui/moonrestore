///|
/// The OS layer must additionally prove ownership/inode and compare actual bytes.
pub fn validate_restore_prefix(
  written : Int64,
  declared : Int64,
  checkpointed : Int64,
) -> Unit raise {
  guard declared >= 0L &&
    declared <= 68719476736L &&
    checkpointed >= 0L &&
    written >= checkpointed &&
    written <= declared else {
    raise Invalid("restore prefix outside checkpoint/file budget")
  }
}

///|
/// Native profile is explicit and non-portable. A lossy profile is never inferred.
pub fn validate_fidelity_policy(
  source : String,
  target : String,
  profile : String,
  permissions : Bool,
) -> Unit raise {
  guard profile == "basic" || profile == "portable" || profile == "native" else {
    raise Invalid("unknown fidelity profile")
  }
  if profile == "native" {
    guard source == target &&
      permissions &&
      (source == "win32" || source == "linux" || source == "darwin") else {
      raise Invalid(
        "native fidelity requires matching platform and permission consent",
      )
    }
  }
}
