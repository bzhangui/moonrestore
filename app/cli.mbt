///|
fn help() -> String {
  let text =
  #|MoonRestore 0.1 — verifiable incremental backups
  #|Usage: node bin/moonrestore.mjs <command> ...
  #|  init <repository>                       Create a NEW repository
  #|  backup <repository> <source>             Backup a directory tree
  #|    --label <text> --exclude <relative>    Repeat exclude; exact path prefixes
  #|    --min <bytes> --avg <bytes> --max <bytes>  CDC tuning
  #|  list <repository>                       List validated snapshots
  #|  plan <repository> <source> --exclude <relative>  Preflight without payload writes
  #|  status <repository>                     Storage and orphan inventory (no deletion)
  #|  verify <repository> <snapshot-id|all>    Full file/chunk verification
  #|  restore <repository> <id> <NEW-target>   No overwrite; full pre-verification
  #|    --prefix <relative>                   Restore one file/subtree
  #|  diff <repository> <old-id> <new-id>      Added/modified/removed paths
  #|  recover <repository>                    Remove dead same-host lock/temp files
  #|  help | version
  #|JSON outputs; byte counts are decimal strings. All IDs use 64 lowercase hex.
  text
}

///|
fn parse_size(text : String) -> Int raise {
  guard text.length() > 0 && text.length() <= 8 else { raise @core.Invalid("invalid integer option") }
  let mut n = 0
  for c in text {
    guard c >= '0' && c <= '9' else { raise @core.Invalid("integer option must contain decimal digits") }
    n = n * 10 + c.to_int() - '0'.to_int()
  }
  n
}

///|
pub fn run(args : Array[String]) -> Unit raise {
  if args.is_empty() || args[0] == "help" || args[0] == "--help" {
    println(help()); return
  }
  if args[0] == "version" { println("MoonRestore 0.1.0"); return }
  let command = args[0]
  let required = match command {
    "init" | "list" | "recover" | "status" => 2
    "backup" | "verify" | "plan" => 3
    "restore" | "diff" => 4
    _ => raise @core.Invalid("unknown command; use help")
  }
  guard args.length() >= required else { raise @core.Invalid("missing command arguments; use help") }
  let mut label = ""
  let mut prefix = ""
  let excludes : Array[String] = []
  let mut minimum = 8192
  let mut average = 32768
  let mut maximum = 131072
  let used : Map[String, Bool] = Map([])
  let mut i = required
  while i < args.length() {
    guard i + 1 < args.length() else { raise @core.Invalid("option requires a value") }
    let key = args[i]
    let value = args[i + 1]
    guard key == "--exclude" || !used.contains(key) else { raise @core.Invalid("duplicate option") }
    used[key] = true
    match (command, key) {
      ("backup", "--label") => label = value
      ("backup", "--exclude") | ("plan", "--exclude") => { @core.validate_path(value); excludes.push(value) }
      ("backup", "--min") => minimum = parse_size(value)
      ("backup", "--avg") => average = parse_size(value)
      ("backup", "--max") => maximum = parse_size(value)
      ("restore", "--prefix") => prefix = value
      _ => raise @core.Invalid("unknown or inapplicable option: \{key}")
    }
    i += 2
  }
  let repo = args[1]
  if command == "init" {
    println(io("init", {"path": repo}).stringify()); return
  }
  io_unit("open", {"path": repo})
  if command == "recover" {
    println(io("recover", Json::null()).stringify()); return
  }
  io_unit("lock", Json::null())
  let result = match command {
    "backup" => backup(args[2], label, excludes,
      {min_size: minimum, average_size: average, max_size: maximum}, @core.Limits::default())
    "list" => list_snapshots()
    "status" => status()
    "plan" => plan_backup(args[2], excludes)
    "verify" => if args[2] == "all" {
      let ids : Array[String] = @json.from_json(io("list", Json::null()))
      let reports : Array[Json] = []
      for id in ids { reports.push(verify(id)) }
      {"ok": true, "verified_snapshots": reports.to_json()}
    } else { verify(args[2]) }
    "restore" => restore(args[2], args[3], prefix)
    "diff" => compare_snapshots(args[2], args[3])
    _ => raise @core.Invalid("unreachable command")
  }
  io_unit("unlock", Json::null())
  println(result.stringify())
}
