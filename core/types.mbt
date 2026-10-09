///|
/// Errors never imply that a partial snapshot has been committed.
pub(all) suberror BackupError {
  Invalid(String)
} derive(Debug, Eq)

///|
/// All limits are enforced before allocation or publication where possible.
pub(all) struct Limits {
  max_files : Int
  max_file_bytes : Int64
  max_total_bytes : Int64
  max_chunks : Int
  max_manifest_bytes : Int
} derive(Eq, Debug, ToJson, FromJson)

///|
pub fn Limits::default() -> Limits {
  {
    max_files: 100000,
    max_file_bytes: 2147483648L,
    max_total_bytes: 68719476736L,
    max_chunks: 1000000,
    max_manifest_bytes: 33554432,
  }
}

///|
/// A caller can lower budgets, not bypass the format's hard resource ceiling.
pub fn Limits::validate(self : Limits) -> Unit raise BackupError {
  let hard = Limits::default()
  guard self.max_files >= 0 &&
    self.max_files <= hard.max_files &&
    self.max_file_bytes >= 0L &&
    self.max_file_bytes <= hard.max_file_bytes &&
    self.max_total_bytes >= 0L &&
    self.max_total_bytes <= hard.max_total_bytes &&
    self.max_chunks >= 0 &&
    self.max_chunks <= hard.max_chunks &&
    self.max_manifest_bytes > 0 &&
    self.max_manifest_bytes <= hard.max_manifest_bytes else {
    raise Invalid("invalid resource limits")
  }
}

///|
pub(all) struct ChunkConfig {
  min_size : Int
  average_size : Int
  max_size : Int
} derive(Eq, Debug, ToJson, FromJson)

///|
pub fn ChunkConfig::default() -> ChunkConfig {
  { min_size: 8192, average_size: 32768, max_size: 131072, }
}

///|
pub fn ChunkConfig::validate(self : ChunkConfig) -> Unit raise BackupError {
  guard self.min_size >= 64 &&
    self.min_size <= self.average_size &&
    self.average_size <= self.max_size &&
    self.max_size <= 1048576 &&
    (self.average_size & (self.average_size - 1)) == 0 else {
    raise Invalid("invalid chunk configuration")
  }
}

///|
pub(all) struct ChunkRef {
  id : String
  size : Int
} derive(Eq, Debug, ToJson, FromJson)

///|
/// Empty directories are explicit entries; file metadata is deliberately minimal.
pub(all) struct Entry {
  path : String
  kind : String
  size : Int64
  hash : String
  chunks : Array[ChunkRef]
} derive(Eq, Debug, ToJson, FromJson)

///|
pub(all) struct Snapshot {
  format : Int
  created : String
  label : String
  config : ChunkConfig
  entries : Array[Entry]
} derive(Eq, Debug, ToJson, FromJson)

///|
pub fn digest(data : Bytes) -> String {
  @crypto.bytes_to_hex_string(@crypto.sha256(data))
}

///|
pub fn text_digest(text : String) -> String {
  digest(@utf8.encode(text))
}

///|
pub struct Hasher {
  context : @crypto.SHA256
}

///|
pub fn Hasher::new() -> Hasher {
  { context: @crypto.SHA256::new(), }
}

///|
pub fn Hasher::update(self : Hasher, data : Bytes) -> Unit {
  self.context.update(data)
}

///|
pub fn Hasher::finish(self : Hasher) -> String {
  let out = FixedArray::make(32, b'\x00')
  @crypto.CryptoHasher::finalize_into(self.context, out, offset=0)
  @crypto.bytes_to_hex_string(out)
}

///|
pub fn valid_id(id : String) -> Bool {
  id.length() == 64 &&
  id.iter().all(fn(c) { (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') })
}
