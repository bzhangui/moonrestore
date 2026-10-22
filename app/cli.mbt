///|
fn help() -> String {
  let text =
    #|MoonRestore 0.7 — verifiable incremental backups
    #|Usage: node bin/moonrestore.mjs <command> ...
    #|  init <repository>                       Create a NEW repository
    #|  backup <repository> <source>             Backup a directory tree
    #|  backup-resumable <repo> <source>         Durable verified file checkpoints
    #|  restore-resumable <repo> <id> <NEW-target>  Verify prefix and full disk readback
    #|  operation-status <repo> <UUID> | operation-resume <repo> <UUID> [--recover]
    #|  plan-save <private-config.json> | plan-list | plan-status <UUID>
    #|  plan-run <UUID> [--recover --restart --accept-anomaly]  Explicit flags only
    #|  plan-schedule <UUID> <PRIVATE-JSON> --confirm <UUID> | plan-schedules | plan-run-due
    #|  plan-scheduler-recover --confirm recover-stopped-plan-scheduler  No active takeover
    #|  plan-schedule-preview <UUID> | plan-schedule-install <UUID> --confirm EXACT_TASK
    #|  readiness | watchdog-check [--notify]  Local observations only, no implicit network
    #|  readiness-send HTTPS_ENDPOINT [--allow-remote]  Redacted counts, not paths
    #|  state-status | state-migrate-preview OLD_STATE NEW_STATE
    #|  state-migrate OLD_STATE NEW_STATE --confirm PREVIEW_HASH  No keys or overwrite
    #|  protection-preview <repo> <PRIVATE-JSON> | protection-apply <repo> <PRIVATE-JSON> --confirm HASH
    #|  protection-status <repo>                Persistent pins and retention window
    #|  signing-key-create <NEW-private-dir>    Password-encrypted Ed25519 key
    #|  artifact-sign <FILE> <PRIVATE-PEM> <NEW-signature> --subject snapshot|archive|package
    #|  artifact-verify <FILE> <signature> <TRUSTED-PUBLIC-PEM> [--anchor FILE --trust HASH]
    #|  rescue-kit <repo> <id> <NEW-kit> --bundle BUNDLE --bundle-sha256 HASH
    #|  rescue-check <kit> <TRUSTED-recipe-hash> <repo>
    #|  rescue-restore <kit> <TRUSTED-recipe-hash> <repo> <NEW-target>
    #|  support-report [--output NEW-private-file]  Allowlisted counts/capabilities only
    #|  postgres-backup <repo> --database DB --user USER --pg-dump ABS --pg-restore ABS
    #|  archive-export <repo> <NEW-archive> [--no-compress]
    #|  archive-import <archive> <external-checksum> <NEW-repo>
    #|  key-migrate <source-repo> <NEW-encrypted-repo>  Private destination password env
    #|  providers                               Versioned built-in capabilities
    #|    --label <text> --exclude <relative>    Repeat exclude; exact path prefixes
    #|    --min <bytes> --avg <bytes> --max <bytes>  CDC tuning
    #|  list <repository>                       List validated snapshots
    #|  plan <repository> <source> --exclude <relative>  Preflight without payload writes
    #|  status <repository>                     Storage and orphan inventory (no deletion)
    #|  verify <repository> <snapshot-id|all>    Full file/chunk verification
    #|  restore <repository> <id> <NEW-target>   No overwrite; full pre-verification
    #|    --prefix <relative>                   Repeat to select up to 128 files/subtrees
    #|  diff <repository> <old-id> <new-id>      Added/modified/removed paths
    #|  recover <repository>                    Remove dead same-host lock/temp files
    #|  audit <repository> <id|all>              Structured full integrity diagnosis
    #|  catalog <repository> <id>                Validated private file inventory
    #|  rescue-plan <repository> <id>           Verify rescuable files, no output writes
    #|  rescue <repository> <id> <NEW-target> --accept-partial true
    #|  scrub-snapshot <repository> <id> --cursor N --files N --bytes N
    #|  emergency-preview <repo> <id> <NEW-target> [--key-file FILE]
    #|  emergency-restore <repo> <id> <NEW-target> --accept-partial --confirmation HASH
    #|  recovery-checklist <repo> <NEW-private-file>
    #|  rebuild-copy <repo> <id> <donor> <NEW-repo> [--encrypted]
    #|  scrub <repo> [--files N --bytes N --snapshot ID]
    #|  health-status <repo> [--max-age-hours N]
    #|  index-build <repo> | index-search <repo> <query> [--offset N]
    #|  sqlite-backup <repo> <database> [--label text --timeout ms]
    #|  sqlite-recover <repo> <id> <NEW-dir> --confirm <NEW-dir> [--checks PRIVATE_JSON]
    #|  vss-plan <source> | provider-rehearsal <repo>  No native VSS
    #|  s3-push <repo> <id> --endpoint URL --bucket NAME [--allow-remote]
    #|  s3-restore <receipt-key> <checksum> <NEW-repo> --endpoint URL --bucket NAME
    #|  remote-audit RECEIPT_KEY SHA --endpoint URL --bucket NAME --version PIN [--offset N --batch N --remaining-days N --allow-remote]
    #|  remote-writer-policy BUCKET PREFIX     Reviewable IAM template only, not applied
    #|    See docs/REMOTE.md for credentials, versions and explicit retention consent
    #|  retention-plan <repository> <keep-last>  Preview only; --daily/weekly/monthly N
    #|  report <repository> [id|all]            Private JSON/HTML report; --details opt-in
    #|  drill <repository> <id>                 Isolated restore and disk readback
    #|  capacity <repository> <source>          Conservative free-space preflight
    #|  init-encrypted <NEW-repository>         Password from MOONRESTORE_PASSWORD
    #|  init-large <NEW-repository>             Explicit format 3; --encrypted optional
    #|  replicate <repository> <destination>    Verified copy; optional --encrypted
    #|  key-export <repository> --output <NEW-private-file> | key-store <repository>
    #|  job-add <id> --repo <repository> --source <source> [--every-minutes N]
    #|  jobs | job-run <id> | run-due            Local jobs; no implicit OS registration
    #|  schedule-preview <id> | schedule-install <id> --confirm <task-name>
    #|  prune <repository> [--keep-last N] [--apply <preview-token>]
    #|  purge <repository> <batch> [--apply <preview-token>]  Minimum 7-day grace
    #|  maintenance-recover <repository> --confirm <repository-identity>
    #|  maintenance-restore <repository> <batch> --confirm <repository-identity>
    #|  workbench [--port 8790]                  Authenticated loopback UI
    #|  help | version
    #|JSON outputs; byte counts are decimal strings. All IDs use 64 lowercase hex.
  text
}

///|
fn parse_size(text : String) -> Int32 raise {
  guard text.length() > 0 && text.length() <= 8 else {
    raise @core.Invalid("invalid integer option")
  }
  let mut n = 0
  for c in text {
    guard c >= '0' && c <= '9' else {
      raise @core.Invalid("integer option must contain decimal digits")
    }
    n = n * 10 + c.to_int() - '0'.to_int()
  }
  n
}

///|
extern "js" fn mark_failed() -> Unit =
  #| () => { process.exitCode = 1; }

///|
pub fn run(args : Array[String]) -> Unit raise {
  if args.is_empty() || args[0] == "help" || args[0] == "--help" {
    println(help())
    return
  }
  if args[0] == "version" {
    println("MoonRestore 0.7.0")
    return
  }
  if args[0] == "operation-transition" {
    guard args.length() == 3 else {
      raise @core.Invalid("expected two task states")
    }
    println(
      ({ "ok": @core.operation_transition(args[1], args[2]) } : Json).stringify(),
    )
    return
  }
  if args[0] == "recovery-goals" {
    guard args.length() == 2 && @utf8.encode(args[1]).length() <= 24000 else {
      raise @core.Invalid("bounded recovery goals expected")
    }
    let inputs : Array[GoalInput] = @json.from_json(@json.parse(args[1]))
    guard inputs.length() <= 32 else {
      raise @core.Invalid("recovery goal batch budget")
    }
    let output : Array[Json] = []
    for item in inputs {
      output.push({
        "goal": @core.recovery_goal(
          item.age_ms,
          item.rpo_ms,
          item.observed_ms,
          item.rto_ms,
          item.evidence_current,
        ).to_json(),
        "schedule": Json(
          @core.schedule_health(
            item.enabled,
            item.blocked,
            item.running,
            item.previous,
            item.now,
            item.due,
            item.grace_ms,
          ),
        ),
      })
    }
    println(({ "ok": true, "results": Json(output) } : Json).stringify())
    return
  }
  if args[0] == "clock-guard" {
    guard args.length() == 4 else {
      raise @core.Invalid("expected clock bounds")
    }
    let previous : Int64 = @json.from_json(Json(args[1]))
    let current : Int64 = @json.from_json(Json(args[2]))
    let forward : Int64 = @json.from_json(Json(args[3]))
    println(
      ({ "ok": @core.clock_guard(previous, current, forward) } : Json).stringify(),
    )
    return
  }
  if args[0] == "schedule-due" {
    guard args.length() == 9 &&
      (args[1] == "true" || args[1] == "false") &&
      (args[2] == "true" || args[2] == "false") else {
      raise @core.Invalid("expected strict scheduler fields")
    }
    let attempts = parse_size(args[3])
    let limit = parse_size(args[4])
    let previous : Int64 = @json.from_json(Json(args[5]))
    let now : Int64 = @json.from_json(Json(args[6]))
    let due : Int64 = @json.from_json(Json(args[7]))
    let forward : Int64 = @json.from_json(Json(args[8]))
    println(
      (
        {
          "ok": true,
          "due": @core.schedule_due(
            args[1] == "true",
            args[2] == "true",
            attempts,
            limit,
            previous,
            now,
            due,
            forward,
          ),
        } : Json).stringify(),
    )
    return
  }
  if args[0] == "capacity-state" {
    guard args.length() == 4 else {
      raise @core.Invalid("capacity-state requires three decimal byte counts")
    }
    let required : Int64 = @json.from_json(Json(args[1]))
    let available : Int64 = @json.from_json(Json(args[2]))
    let reserve : Int64 = @json.from_json(Json(args[3]))
    let state = @core.capacity_state(required, available, reserve)
    println(({ "ok": true, "state": state } : Json).stringify())
    return
  }
  if args[0] == "source-state" {
    guard args.length() == 5 && (args[3] == "true" || args[3] == "false") else {
      raise @core.Invalid(
        "source-state requires counts, strict boolean and drop percentage",
      )
    }
    let state = @core.source_change_state(
      parse_size(args[1]),
      parse_size(args[2]),
      args[3] == "true",
      parse_size(args[4]),
    )
    println(({ "ok": true, "state": state } : Json).stringify())
    return
  }
  let command = args[0]
  let required = match command {
    "init" | "list" | "recover" | "status" => 2
    "backup"
    | "verify"
    | "plan"
    | "audit"
    | "catalog"
    | "retention-plan"
    | "selection-plan"
    | "rescue-plan"
    | "scrub-snapshot" => 3
    "restore" | "diff" | "rescue" => 4
    _ => raise @core.Invalid("unknown command; use help")
  }
  guard args.length() >= required else {
    raise @core.Invalid("missing command arguments; use help")
  }
  let mut label = ""
  let mut prefix = ""
  let selections : Array[String] = []
  let excludes : Array[String] = []
  let mut minimum = 8192
  let mut average = 32768
  let mut maximum = 131072
  let mut daily = 0
  let mut weekly = 0
  let mut monthly = 0
  let mut accept_partial = false
  let mut cursor = 0
  let mut batch_files = 100
  let mut batch_bytes = 1073741824L
  let protected_ids : Array[String] = []
  let used : Map[String, Bool] = Map([])
  let mut i = required
  while i < args.length() {
    guard i + 1 < args.length() else {
      raise @core.Invalid("option requires a value")
    }
    let key = args[i]
    let value = args[i + 1]
    guard key == "--exclude" ||
      key == "--protect" ||
      key == "--prefix" ||
      !used.contains(key) else {
      raise @core.Invalid("duplicate option")
    }
    used[key] = true
    match (command, key) {
      ("backup", "--label") => label = value
      ("backup", "--exclude") | ("plan", "--exclude") => {
        @core.validate_path(value)
        excludes.push(value)
      }
      ("backup", "--min") => minimum = parse_size(value)
      ("backup", "--avg") => average = parse_size(value)
      ("backup", "--max") => maximum = parse_size(value)
      ("restore", "--prefix")
      | ("rescue", "--prefix")
      | ("rescue-plan", "--prefix") => {
        prefix = value
        selections.push(value)
      }
      ("selection-plan", "--prefix") => selections.push(value)
      ("rescue", "--accept-partial") => {
        guard value == "true" else {
          raise @core.Invalid(
            "explicit partial rescue acknowledgement required",
          )
        }
        accept_partial = true
      }
      ("scrub-snapshot", "--cursor") => cursor = parse_size(value)
      ("scrub-snapshot", "--files") => batch_files = parse_size(value)
      ("scrub-snapshot", "--bytes") =>
        batch_bytes = @json.from_json(Json(value))
      ("retention-plan", "--daily") => daily = parse_size(value)
      ("retention-plan", "--weekly") => weekly = parse_size(value)
      ("retention-plan", "--monthly") => monthly = parse_size(value)
      ("retention-plan", "--protect") => protected_ids.push(value)
      _ => raise @core.Invalid("unknown or inapplicable option: \{key}")
    }
    i += 2
  }
  let repo = args[1]
  if command == "init" {
    println(io("init", { "path": repo }).stringify())
    return
  }
  io_unit("open", { "path": repo })
  if command == "recover" {
    println(io("recover", Json::null()).stringify())
    return
  }
  io_unit("lock", Json::null())
  let profile : Int32 = @json.from_json(io("profile", Json::null()))
  let result = match command {
    "backup" =>
      backup(
        args[2],
        label,
        excludes,
        { min_size: minimum, average_size: average, max_size: maximum, },
        if profile == 3 {
          @core.Limits::large()
        } else {
          @core.Limits::default()
        },
      )
    "list" => list_snapshots()
    "status" => status()
    "audit" => audit_snapshots(args[2])
    "catalog" => read_snapshot(args[2]).to_json()
    "selection-plan" => selection_plan(args[2], selections)
    "retention-plan" =>
      retention_plan(parse_size(args[2]), daily, weekly, monthly, protected_ids)
    "plan" => plan_backup(args[2], excludes)
    "verify" =>
      if args[2] == "all" {
        let ids : Array[String] = @json.from_json(io("list", Json::null()))
        let reports : Array[Json] = []
        for id in ids {
          reports.push(verify(id))
        }
        { "ok": true, "verified_snapshots": Json(reports) }
      } else {
        verify(args[2])
      }
    "restore" => restore(args[2], args[3], prefix, selections~)
    "rescue-plan" => rescue(args[2], selections, "")
    "rescue" => {
      guard accept_partial else {
        raise @core.Invalid("use --accept-partial true for explicit rescue")
      }
      rescue(args[2], selections, args[3], apply=true)
    }
    "scrub-snapshot" =>
      scrub_snapshot(args[2], cursor, batch_files, batch_bytes)
    "diff" => compare_snapshots(args[2], args[3])
    _ => raise @core.Invalid("unreachable command")
  }
  io_unit("unlock", Json::null())
  println(result.stringify())
  if result is { "ok": false, .. } {
    mark_failed()
  }
}
