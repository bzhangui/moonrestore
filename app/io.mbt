///|
extern "js" fn invoke(op : String, argument : String, bytes : Bytes) -> String =
  #| (op, args, bytes) => globalThis.__moonrestore_host.execute(op, args, bytes)

///|
extern "js" fn returned_bytes() -> Bytes =
  #| () => globalThis.__moonrestore_host.bytes

///| Convert OS failures into normal MoonBit errors; FFI exceptions never escape.
fn io(op : String, args : Json, data? : Bytes = b"") -> Json raise {
  let reply = @json.parse(invoke(op, args.stringify(), data))
  match reply {
    { "ok": true, "value": value, .. } => value
    { "ok": false, "error": String(message), .. } => raise @core.Invalid(message)
    _ => raise @core.Invalid("invalid platform response")
  }
}

///|
fn io_unit(op : String, args : Json, data? : Bytes = b"") -> Unit raise {
  ignore(io(op, args, data~))
}

///|
fn get_object(part : @core.ChunkRef) -> Bytes raise {
  io_unit("get", { "id": part.id })
  let bytes = returned_bytes()
  @core.verify_chunk(part, bytes)
  bytes
}

///|
fn read_snapshot(id : String) -> @core.Snapshot raise {
  guard @core.valid_id(id) else { raise @core.Invalid("snapshot ID must be 64 lowercase hexadecimal characters") }
  io_unit("manifest", { "id": id })
  let bytes = returned_bytes()
  guard @core.digest(bytes) == id else { raise @core.Invalid("manifest SHA-256 mismatch") }
  @core.decode_snapshot(@utf8.decode(bytes), id)
}

///|
fn store_object(bytes : Bytes) -> (@core.ChunkRef, Bool) raise {
  let part : @core.ChunkRef = { id: @core.digest(bytes), size: bytes.length() }
  let reply = io("put", { "id": part.id }, data=bytes)
  let created = match reply { {"created": True, ..} => true; {"created": False, ..} => false; _ => raise @core.Invalid("invalid store response") }
  if !created { @core.verify_chunk(part, returned_bytes()) }
  (part, created)
}
