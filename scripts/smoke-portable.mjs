// Exercise only synthetic data, through the copied runtime, without MoonBit SDK.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { removeOwned } from "../platform/maintenance.mjs";
const bundle = path.resolve(process.argv[2] || "");
if (!fs.statSync(path.join(bundle, "manifest.json")).isFile())
  throw new Error("Expected verified portable bundle");
const parent = fs.realpathSync(os.tmpdir()),
  root = fs.mkdtempSync(path.join(parent, "moonrestore-portable-smoke-"));
try {
  const source = path.join(root, "source"),
    repository = path.join(root, "encrypted");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "sample.txt"),
    "controlled portable backup",
  );
  const env = {
    ...process.env,
    MOONRESTORE_HOME: path.join(root, "state"),
    MOONRESTORE_PASSWORD: "controlled-portable-smoke-only",
  };
  const run = (args) => {
    const result = spawnSync(
      fs.existsSync(path.join(bundle, "runtime/node.exe"))
        ? path.join(bundle, "runtime/node.exe")
        : process.execPath,
      [path.join(bundle, "bin", "moonrestore.mjs"), ...args],
      {
        cwd: bundle,
        env,
        encoding: "utf8",
        timeout: 60000,
        shell: false,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  run(["init-encrypted", repository]);
  const snapshot = run(["backup", repository, source]).snapshot;
  assert.equal(run(["report", repository, "all"]).ok, true);
  const drill = run(["drill", repository, snapshot]);
  assert.equal(drill.ok, true);
  assert.equal(drill.post_restore_readback, true);
  const target = path.join(root, "emergency");
  const preview = run(["emergency-preview", repository, snapshot, target]);
  const rescued = run([
    "emergency-restore",
    repository,
    snapshot,
    target,
    "--accept-partial",
    "--confirmation",
    preview.confirmation,
  ]);
  assert.equal(rescued.post_restore_readback, true);
  assert.equal(
    fs.readFileSync(path.join(target, "sample.txt"), "utf8"),
    "controlled portable backup",
  );
  assert.equal(run(["scrub", repository]).ok, true);
  assert.equal(run(["health-status", repository]).ok, true);
  assert.equal(run(["index-build", repository]).ok, true);
  assert.equal(run(["index-search", repository, "sample"]).total, 1);
  assert.equal(run(["provider-rehearsal", repository]).lease_released, true);
  const { DatabaseSync } = await import("node:sqlite");
  const database = path.join(root, "app.sqlite"),
    db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE sample(value); INSERT INTO sample VALUES('synthetic packaged SQLite');",
    );
  } finally {
    db.close();
  }
  assert.equal(
    run(["sqlite-backup", repository, database]).post_restore_readback,
    true,
  );
  const durable = run(["backup-resumable", repository, source]);
  assert.equal(durable.state, "completed");
  assert.equal(
    run([
      "restore-resumable",
      repository,
      durable.snapshot,
      path.join(root, "durable-restore"),
    ]).post_restore_readback,
    true,
  );
  const archive = path.join(root, "archive"),
    exported = run(["archive-export", repository, archive]),
    imported = path.join(root, "imported");
  assert.equal(
    run(["archive-import", archive, exported.checksum, imported])
      .destination_audited,
    true,
  );
  const config = path.join(root, "private-config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      name: "portable reliability",
      type: "files",
      repository,
      source,
      reserveBytes: 0,
    }),
  );
  const plan = run(["plan-save", config]);
  assert.equal(run(["plan-run", plan.id]).ok, true);
  const schedule = path.join(root, "private-schedule.json");
  fs.writeFileSync(
    schedule,
    JSON.stringify({ enabled: true, intervalMinutes: 1440 }),
  );
  assert.equal(
    run(["plan-schedule", plan.id, schedule, "--confirm", plan.id]).ok,
    true,
  );
  assert.equal(run(["plan-run-due"]).results[0].ok, true);
  const protection = path.join(root, "private-protection.json");
  fs.writeFileSync(
    protection,
    JSON.stringify({ minimumDays: 30, pins: [durable.snapshot] }),
  );
  const previewProtection = run(["protection-preview", repository, protection]);
  assert.equal(
    run([
      "protection-apply",
      repository,
      protection,
      "--confirm",
      previewProtection.confirmation,
    ]).pins_content_verified,
    true,
  );
  env.MOONRESTORE_SIGNING_PASSWORD = "synthetic-portable-signing-only";
  const keys = path.join(root, "signing-keys"),
    signature = path.join(root, "manifest-signature.json"),
    manifest = path.join(bundle, "manifest.json"),
    manifestHash = createHash("sha256")
      .update(fs.readFileSync(manifest))
      .digest("hex");
  run(["signing-key-create", keys]);
  const signed = run([
    "artifact-sign",
    manifest,
    path.join(keys, "private.pem"),
    signature,
    "--subject",
    "package",
  ]);
  assert.equal(
    run([
      "artifact-verify",
      manifest,
      signature,
      path.join(keys, "public.pem"),
      "--anchor",
      path.join(root, "anchor.json"),
      "--trust",
      signed.attestation_hash,
    ]).signature_verified,
    true,
  );
  const kit = path.join(root, "offline-kit"),
    rescue = run([
      "rescue-kit",
      repository,
      durable.snapshot,
      kit,
      "--bundle",
      bundle,
      "--bundle-sha256",
      manifestHash,
    ]);
  assert.equal(rescue.key_included, false);
  assert.equal(
    run(["rescue-check", kit, rescue.recipe_sha256, repository])
      .content_verified,
    false,
  );
  const rescuedTarget = path.join(root, "offline-restored");
  assert.equal(
    run([
      "rescue-restore",
      kit,
      rescue.recipe_sha256,
      repository,
      rescuedTarget,
    ]).post_restore_readback,
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(rescuedTarget, "sample.txt"), "utf8"),
    "controlled portable backup",
  );
  const support = run(["support-report"]);
  assert.equal(JSON.stringify(support).includes(root), false);
  assert.equal(support.secrets_included, false);
  env.MOONRESTORE_DEST_PASSWORD = "synthetic-new-key-password";
  const migrated = path.join(root, "new-key");
  assert.equal(
    run(["key-migrate", repository, migrated]).new_repository_key,
    true,
  );
  env.MOONRESTORE_PASSWORD = env.MOONRESTORE_DEST_PASSWORD;
  assert.equal(run(["verify", migrated, durable.snapshot]).ok, true);
  console.log(
    JSON.stringify({
      portable_runtime_smoke: true,
      encrypted_backup: true,
      report: true,
      restore_readback: true,
      emergency_recovery: true,
      scrub_and_index: true,
      provider_lifecycle_rehearsal: true,
      packaged_sqlite_online_backup: true,
      durable_backup_restore: true,
      segmented_archive: true,
      unified_plan: true,
      new_key_migration: true,
      plan_scheduler: true,
      recovery_point_protection: true,
      detached_signature_and_anchor: true,
      offline_rescue_fresh_state: true,
      allowlisted_diagnostics: true,
    }),
  );
} finally {
  removeOwned(root, parent, "moonrestore-portable-smoke-");
}
