///|
/// Optional, hash-bound metadata extension. Snapshot constructors stay compatible.
pub(all) struct FileMetadata {
  path : String
  mtime_ms : Int64
  mode : Int32
} derive(Eq, Debug, ToJson, FromJson)

///|
pub extend FileMetadata with ToJson::{to_json}

///|
pub extend FileMetadata with Eq::{equal, not_equal}

///|
pub extend FileMetadata with @debug.Debug::{to_repr}

///|
pub extend FileMetadata with @json.FromJson::{from_json}

///|
fn metadata_json(json : Json, snapshot : Snapshot) -> Array[FileMetadata] raise {
  guard json is Object(fields) else { raise Invalid("invalid metadata object") }
  let raw = match fields.get("metadata") {
    None => return []
    Some(Array(values)) => values
    _ => raise Invalid("invalid metadata array")
  }
  guard raw.length() <= snapshot.entries.length() else {
    raise Invalid("metadata budget exceeded")
  }
  let paths : Map[String, Bool] = Map([])
  let members : Map[String, Bool] = Map([])
  for entry in snapshot.entries {
    members[entry.path] = true
  }
  let result : Array[FileMetadata] = []
  for item in raw {
    guard item is Object(properties) && properties.length() == 3 else {
      raise Invalid("invalid metadata fields")
    }
    guard item is { "path": String(p), "mode": mode, "mtime_ms": String(_), .. } else {
      raise Invalid("invalid metadata types")
    }
    exact_int(mode, 511)
    let value : FileMetadata = @json.from_json(item)
    guard members.contains(p) &&
      !paths.contains(p) &&
      value.mtime_ms >= 0L &&
      value.mtime_ms <= 253402300799000L else {
      raise Invalid("invalid metadata path/time")
    }
    paths[p] = true
    result.push(value)
  }
  result
}

///|
pub fn encode_with_metadata(
  snapshot : Snapshot,
  metadata : Array[FileMetadata],
  limits~ : Limits = Limits::default(),
) -> String raise {
  let json = @json.parse(snapshot.encode(limits~))
  guard json is Object(fields) else { raise Invalid("invalid snapshot object") }
  fields["metadata"] = Json(metadata)
  ignore(metadata_json(json, snapshot))
  let text = json.stringify()
  guard @utf8.encode(text).length() <= limits.max_manifest_bytes else {
    raise Invalid("manifest metadata byte budget exceeded")
  }
  text
}

///|
pub fn decode_metadata(
  text : String,
  expected_id : String,
  limits~ : Limits = Limits::default(),
) -> Array[FileMetadata] raise {
  let snapshot = decode_snapshot(text, expected_id, limits~)
  metadata_json(@json.parse(text), snapshot)
}
