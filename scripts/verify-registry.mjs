// Independent registry consumer: no path/workspace override and no credentials output.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { moon, moonEnv, versionCheck } from "./build.mjs";
// Source development versions are not automatically published.
const version = process.argv[2] || "0.5.0";
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Expected an explicit release version");
const [major, minor] = version.split(".").map(Number),
  recovery = major > 0 || minor >= 4,
  operations = major > 0 || minor >= 5;
const extra = recovery
  ? `///|
fn verify_recovery_operations() -> Unit raise {
  let bytes = b"independent new API consumer"
  let file : @backup.Entry = {path:"sample.txt",kind:"file",size:bytes.length().to_int64(),hash:@backup.digest(bytes),chunks:[{id:@backup.digest(bytes),size:bytes.length()}]}
  let snapshot : @backup.Snapshot = {format:1,created:"2026-10-17T00:00:00.000Z",label:"new API consumer",config:@backup.ChunkConfig::default(),entries:[file]}
  assert_eq(@backup.rescue_entries(snapshot, [], ["sample.txt"]), [file])
  let batch = @backup.verification_batch(snapshot, 0, 1, 1048576L)
  assert_eq(batch.paths, ["sample.txt"])
  assert_eq(batch.next, batch.total)
  ${
    operations
      ? `@backup.validate_checkpoint_entry(file, snapshot.config, @backup.Limits::default())
  assert_true(@backup.operation_transition("paused", "running"))
  assert_false(@backup.operation_transition("prepared", "completed"))
  assert_true(@backup.clock_guard(100L, 110L, 20L))
  assert_false(@backup.clock_guard(100L, 90L, 20L))`
      : ""
  }
}

///|
test "published recovery and operation API" { verify_recovery_operations() }
`
  : "";
const parent = fileURLToPath(new URL("../.local/", import.meta.url));
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, "registry-consumer-"));
const run = (args) => {
  const r = spawnSync(moon, args, {
    cwd: directory,
    env: moonEnv,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(
      "Registry consumer command failed: " +
        args.join(" ") +
        "\n" +
        r.stdout +
        "\n" +
        r.stderr,
    );
  return r.stdout.trim();
};
fs.writeFileSync(
  path.join(directory, "moon.mod"),
  'name = "consumer/moonrestore_verification"\nversion = "0.0.0"\n',
);
fs.writeFileSync(
  path.join(directory, "moon.pkg"),
  'import { "bzhangui/moonrestore/core" @backup, }\npkgtype(kind: "executable")\n',
);
fs.writeFileSync(
  path.join(directory, "main.mbt"),
  `///|
fn verify_integrity() -> Unit raise {
  assert_eq(@backup.digest(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  let bytes = b"independent registry consumer"
  let pieces = @backup.chunk(bytes)
  let refs : Array[@backup.ChunkRef] = pieces.map(fn(part) { { id: @backup.digest(part), size: part.length(), } })
  for i = 0; i < pieces.length(); i = i + 1 { @backup.verify_chunk(refs[i], pieces[i]) }
  let snapshot : @backup.Snapshot = {
    format: 1, created: "2026-10-16T00:00:00.000Z", label: "registry consumer",
    config: @backup.ChunkConfig::default(),
    entries: [{ path: "sample.txt", kind: "file", size: bytes.length().to_int64(), hash: @backup.digest(bytes), chunks: refs, }],
  }
  let text = snapshot.encode()
  assert_eq(@backup.decode_snapshot(text, @backup.text_digest(text)), snapshot)
  assert_eq(@backup.select_entries(snapshot, ["sample.txt"]).length(), 1)
  let metadata : Array[@backup.FileMetadata] = [{path:"sample.txt",mtime_ms:1700000000000L,mode:384}]
  let extended = @backup.encode_with_metadata(snapshot, metadata)
  assert_eq(@backup.decode_metadata(extended, @backup.text_digest(extended)), metadata)
}

///|
fn verify_maintenance() -> Unit raise {
  let old_id = @backup.digest(b"old")
  let new_id = @backup.digest(b"new")
  let records : Array[@backup.RetentionRecord] = [{id: old_id, created: "2026-10-01T00:00:00.000Z",}, {id: new_id, created: "2026-10-16T00:00:00.000Z",}]
  assert_eq(@backup.retention_keep(records, 1, 0, 0, 0, []), [new_id])
  assert_eq(@backup.retention_keep(records, 1, 0, 0, 0, [old_id]).length(), 2)
  assert_eq(@backup.capacity_state(68719476736L, 68719476735L, 0L), 1)
  assert_eq(@backup.source_change_state(69, 100, false, 30), 2)
  @backup.Limits::large().validate_for_format(3)
  assert_eq(@backup.Limits::large().max_file_bytes, 68719476736L)
}

///|
fn main { try { verify_integrity(); verify_maintenance(); ${recovery ? "verify_recovery_operations(); " : ""}println("registry consumer verified") } catch { e => abort("consumer failed: \\{e}") } }

///|
test "published integrity API" { verify_integrity() }

///|
test "published maintenance API" { verify_maintenance() }

${extra}
`,
);
console.log(versionCheck());
run(["update"]);
run(["add", "bzhangui/moonrestore@" + version]);
run(["fmt"]);
const targets = [];
for (const target of ["js", "wasm", "wasm-gc", "native"]) {
  run(["check", "--target", target, "--deny-warn"]);
  run(["build", "--target", target, "--release", "--deny-warn"]);
  const output = run(["run", ".", "--target", target]);
  if (!output.includes("registry consumer verified"))
    throw new Error("Missing consumer assertion");
  const tests = run(["test", "--target", target, "--deny-warn"]);
  targets.push({ target, ok: true, output, tests });
}
const report = {
  module: "bzhangui/moonrestore",
  version,
  ok: true,
  independent_registry_download: true,
  targets,
};
fs.writeFileSync(
  path.join(directory, "verification.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
