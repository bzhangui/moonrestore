///| Deterministic Gear-style CDC. The rolling fingerprint is NOT a security hash.
///| A generated gear table avoids copied upstream code; format 1 fixes this seed.
fn gear(byte : Byte) -> UInt {
  let mut x = byte.to_uint() + 0x9e3779b9U
  x = (x ^ (x >> 16)) * 0x85ebca6bU
  x = (x ^ (x >> 13)) * 0xc2b2ae35U
  x ^ (x >> 16)
}

///|
pub struct Chunker {
  config : ChunkConfig
  buffer : Array[Byte]
  mut rolling : UInt
}

///|
pub fn Chunker::new(config? : ChunkConfig = ChunkConfig::default()) -> Chunker raise BackupError {
  config.validate()
  { config, buffer: [], rolling: 0U }
}

///| State survives arbitrary input-block boundaries. Maximum retained data: max_size.
pub fn Chunker::push(self : Chunker, data : Bytes) -> Array[Bytes] {
  let output = []
  for byte in data {
    self.buffer.push(byte)
    self.rolling = (self.rolling << 1) + gear(byte)
    let n = self.buffer.length()
    if n >= self.config.max_size ||
      (n >= self.config.min_size &&
       (self.rolling & (self.config.average_size - 1).reinterpret_as_uint()) == 0U) {
      output.push(Bytes::from_array(self.buffer))
      self.buffer.clear()
      self.rolling = 0U
    }
  }
  output
}

///|
pub fn Chunker::finish(self : Chunker) -> Bytes? {
  if self.buffer.is_empty() { None } else {
    let tail = Bytes::from_array(self.buffer)
    self.buffer.clear()
    self.rolling = 0U
    Some(tail)
  }
}

///|
pub fn chunk(data : Bytes, config? : ChunkConfig = ChunkConfig::default()) -> Array[Bytes] raise BackupError {
  let chunker = Chunker::new(config~)
  let out = chunker.push(data)
  if chunker.finish() is Some(tail) { out.push(tail) }
  out
}
