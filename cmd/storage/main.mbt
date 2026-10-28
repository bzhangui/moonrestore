///|
extern "js" fn expose(command : (String, Bytes) -> String) -> Unit =
  #| command => { globalThis.__moonrestore_storage = {command}; }

///|
let ledgers : Map[String, @backup.PagedLedger] = Map([])

///|
let chunks : Map[String, @backup.Chunker] = Map([])

///|
let hashes : Map[String, @backup.Hasher] = Map([])

///|
struct Request {
  action : String
  session : String
  record : @backup.PagedRecord?
  sequence : Int32
  previous : String
  count : Int32
  entries : Int64
  chunks : Int64
  total : Int64
} derive(FromJson)

///|
struct RetentionRequest {
  records : Array[@backup.RetentionRecord]
  keep_last : Int32
  protected_ids : Array[String]
} derive(FromJson)

///|
struct RetirementClock {
  requested : Int64
  current : Int64
  old_uptime : Int64
  uptime : Int64
  grace_days : Int32
} derive(FromJson)

///|
fn command(text : String, bytes : Bytes) -> String {
  try {
    guard text.length() <= 262144 && bytes.length() <= 8388608 else {
      raise @backup.Invalid("storage bridge budget")
    }
    let r : Request = @json.from_json(@json.parse(text))
    let value : Json = match r.action {
      "digest" => Json(@backup.digest(bytes))
      "path" => {
        @backup.validate_path(r.session)
        Json::null()
      }
      "transition" => Json(@backup.operation_transition(r.session, r.previous))
      "restore-prefix" => {
        @backup.validate_restore_prefix(r.entries, r.total, r.chunks)
        Json::null()
      }
      "fidelity-policy" => {
        @backup.validate_fidelity_policy(
          r.session,
          r.previous,
          @utf8.decode(bytes),
          r.count == 1,
        )
        Json::null()
      }
      "retirement-ready" =>
        Json(@backup.retirement_ready(r.entries, r.total, r.count))
      "retirement-clock" => {
        let p : RetirementClock = @json.from_json(@json.parse(r.session))
        Json(
          @backup.retirement_clock_ready(
            p.requested,
            p.current,
            p.old_uptime,
            p.uptime,
            p.grace_days,
          ),
        )
      }
      "retention" => {
        let p : RetentionRequest = @json.from_json(@json.parse(r.session))
        Json(
          @backup.retention_keep(
            p.records,
            p.keep_last,
            0,
            0,
            0,
            p.protected_ids,
          ),
        )
      }
      "ledger-new" => {
        guard ledgers.length() < 16 && !ledgers.contains(r.session) else {
          raise @backup.Invalid("ledger session budget")
        }
        ledgers[r.session] = @backup.PagedLedger::new()
        Json::null()
      }
      "ledger-record" => {
        ledgers[r.session].accept(r.record.unwrap())
        Json::null()
      }
      "ledger-finish" => {
        ledgers[r.session].finish(r.entries, r.chunks, r.total)
        Json::null()
      }
      "page" => {
        @backup.validate_page_link(
          r.sequence,
          r.previous,
          r.count,
          bytes.length(),
        )
        Json::null()
      }
      "hash-new" => {
        guard hashes.length() < 16 && !hashes.contains(r.session) else {
          raise @backup.Invalid("hash session budget")
        }
        hashes[r.session] = @backup.Hasher::new()
        Json::null()
      }
      "hash-push" => {
        hashes[r.session].update(bytes)
        Json::null()
      }
      "hash-finish" => {
        let result = hashes[r.session].finish()
        hashes.remove(r.session) |> ignore
        Json(result)
      }
      "chunk-new" => {
        guard chunks.length() < 16 && !chunks.contains(r.session) else {
          raise @backup.Invalid("chunk session budget")
        }
        chunks[r.session] = @backup.Chunker::new()
        Json::null()
      }
      "chunk-push" =>
        Json(
          chunks[r.session]
          .push(bytes)
          .map(fn(b) { @crypto.bytes_to_hex_string(b) }),
        )
      "chunk-finish" => {
        let last = chunks[r.session].finish()
        chunks.remove(r.session) |> ignore
        match last {
          Some(bytes) => Json(@crypto.bytes_to_hex_string(bytes))
          None => Json::null()
        }
      }
      "close" => {
        ledgers.remove(r.session) |> ignore
        chunks.remove(r.session) |> ignore
        hashes.remove(r.session) |> ignore
        Json::null()
      }
      _ => raise @backup.Invalid("unsupported storage bridge action")
    }
    Json({ "ok": Json(true), "value": value }).stringify()
  } catch {
    _ =>
      Json({ "ok": Json(false), "error": Json("storage validation rejected") }).stringify()
  }
}

///|
fn main {
  expose(command)
}
