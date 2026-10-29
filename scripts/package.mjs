import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { moon, moonEnv } from "./build.mjs";
const project = fileURLToPath(new URL("../", import.meta.url));
const sourceVersion = JSON.parse(
  fs.readFileSync(path.join(project, "package.json"), "utf8"),
).version;
const embedded = process.env.MOONRESTORE_BUNDLE_RUNTIME === "1";
if (embedded) {
  for (const script of ["prepare-runtime.mjs", "build-desktop.mjs"]) {
    const r = spawnSync(
      process.execPath,
      [path.join(project, "scripts", script)],
      { cwd: project, stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("Desktop prerequisites failed");
  }
}
const build = spawnSync(
  process.execPath,
  [path.join(project, "scripts", "build.mjs"), "--frozen"],
  { cwd: project, stdio: "inherit" },
);
if (build.error || build.status !== 0)
  throw new Error("Build failed; no bundle created");
const parent = path.join(project, ".local", "releases");
fs.mkdirSync(parent, { recursive: true });
const destination = path.join(
  parent,
  `moonrestore-${sourceVersion}-${process.platform}-${process.arch}-${randomUUID().slice(0, 8)}`,
);
fs.mkdirSync(destination); // Never overwrite a previous bundle.
const files = [
  "bin/moonrestore.mjs",
  "bin/engine-worker.mjs",
  "bin/sqlite-export.mjs",
  "bin/sqlite-verify.mjs",
  "bin/wal-fetch.mjs",
  "platform/adapter.mjs",
  "scripts/console.ps1",
  "scripts/verify-package.mjs",
  "开始使用.cmd",
  "platform/vault.mjs",
  "platform/maintenance.mjs",
  "platform/retention.mjs",
  "platform/jobs.mjs",
  "platform/workbench.mjs",
  "platform/activity.mjs",
  "platform/explorer.mjs",
  "platform/notifications.mjs",
  "platform/system.mjs",
  "platform/recovery.mjs",
  "platform/recovery-target.mjs",
  "platform/applications.mjs",
  "platform/sqlite-recovery.mjs",
  "platform/search-index.mjs",
  "platform/s3.mjs",
  "platform/remote.mjs",
  "platform/remote-audit.mjs",
  "platform/readiness.mjs",
  "platform/state-migration.mjs",
  "platform/snapshot-provider.mjs",
  "platform/vss-native.mjs",
  "platform/paged-store.mjs",
  "platform/paged-cache.mjs",
  "platform/paged-journal.mjs",
  "platform/paged-selection.mjs",
  "platform/paged-restore.mjs",
  "platform/private-operation.mjs",
  "platform/fidelity.mjs",
  "platform/paged-service.mjs",
  "platform/paged-compat.mjs",
  "platform/paged-copy.mjs",
  "platform/paged-remote.mjs",
  "platform/paged-retention.mjs",
  "platform/paged-scrub.mjs",
  "platform/engine-client.mjs",
  "platform/repository-kind.mjs",
  "platform/storage-capabilities.mjs",
  "platform/upgrade-commands.mjs",
  "platform/wal-health.mjs",
  "platform/plan-runner.mjs",
  "platform/alert-delivery.mjs",
  "platform/paged-operations.mjs",
  "platform/paged-maintenance.mjs",
  "platform/postgres-physical.mjs",
  "platform/monitor-receiver.mjs",
  "platform/contracts.mjs",
  "platform/journal.mjs",
  "platform/operations.mjs",
  "platform/postgresql.mjs",
  "platform/archive.mjs",
  "platform/plans.mjs",
  "platform/plan-scheduler.mjs",
  "platform/os-schedule.mjs",
  "platform/recovery-policy.mjs",
  "platform/attestation.mjs",
  "platform/distribution.mjs",
  "platform/rescue-kit.mjs",
  "platform/support.mjs",
  "ui/index.html",
  "ui/style.css",
  "ui/app.js",
  "ui/enhancements.js",
  "ui/recovery.js",
  "ui/durable.js",
  "ui/readiness.js",
  "_build/js/release/build/cmd/main/main.js",
  "_build/js/release/build/cmd/storage/storage.js",
  "examples/demo.mjs",
  "examples/scenarios.mjs",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "licenses/MoonBit-Apache-2.0.txt",
  "docs/OPERATIONS.md",
  "docs/FORMAT.md",
  "docs/THIRD_PARTY.md",
  "docs/WORKBENCH.md",
  "docs/RECOVERY.md",
  "docs/DESKTOP.md",
  "docs/PRACTICAL_0_3.md",
  "docs/RECOVERY_0_4.md",
  "docs/APPLICATIONS.md",
  "docs/REMOTE.md",
  "docs/RELIABILITY_0_5.md",
  "docs/RELIABILITY_0_6.md",
  "docs/RELIABILITY_0_7.md",
  "docs/RELIABILITY_0_8.md",
  "docs/FAULT_MATRIX_0_8.md",
  "docs/UPGRADE_0_9.md",
  "docs/RELIABILITY_0_9.md",
  "docs/RELIABILITY_0_10.md",
];
files.push(
  "_build/host/" + (process.platform === "win32" ? "fidelity.exe" : "fidelity"),
);
if (process.platform !== "win32") files.push("_build/host/rename_noreplace");
if (embedded)
  files.push(
    "scripts/desktop-host.mjs",
    "打开工作台.cmd",
    "安装到当前用户.cmd",
  );
const hashes = {};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const rel of files) {
  const from = path.join(project, rel),
    to = path.join(destination, rel);
  if (!fs.statSync(from).isFile())
    throw new Error("Missing bundle file: " + rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  hashes[rel] = hash(fs.readFileSync(to));
}
let runtime;
if (embedded) {
  for (const [from, rel] of [
    [".local/runtime/node.exe", "runtime/node.exe"],
    [".local/runtime/NODE_LICENSE.txt", "runtime/NODE_LICENSE.txt"],
    [".local/desktop/MoonRestore.exe", "MoonRestore.exe"],
  ]) {
    const target = path.join(destination, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(
      path.join(project, from),
      target,
      fs.constants.COPYFILE_EXCL,
    );
    hashes[rel] = hash(fs.readFileSync(target));
  }
  runtime = JSON.parse(
    fs.readFileSync(path.join(project, ".local/runtime/provenance.json")),
  );
}
fs.copyFileSync(
  path.join(project, "docs", "PORTABLE.md"),
  path.join(destination, "README.md"),
);
hashes["README.md"] = hash(
  fs.readFileSync(path.join(destination, "README.md")),
);
const metadata = JSON.stringify(
  {
    name: "moonrestore-portable",
    version: sourceVersion,
    private: true,
    type: "module",
    engines: { node: ">=22.16.0" },
  },
  null,
  2,
);
fs.writeFileSync(path.join(destination, "package.json"), metadata, {
  flag: "wx",
});
hashes["package.json"] = hash(metadata);
const inventory = JSON.stringify(
  {
    format: 1,
    kind: "moonrestore_component_inventory",
    version: sourceVersion,
    components: [
      {
        name: "MoonRestore",
        version: sourceVersion,
        license: "Apache-2.0",
        repository: "https://github.com/bzhangui/moonrestore",
      },
      {
        name: "moonbitlang/x",
        version: "0.5.5",
        license_file: "licenses/MoonBit-Apache-2.0.txt",
      },
      ...(runtime
        ? [
            {
              name: "Node.js",
              version: runtime.version,
              license_file: "runtime/NODE_LICENSE.txt",
            },
          ]
        : []),
    ],
    npm_runtime_dependencies: [],
    complete_external_system_inventory: false,
  },
  null,
  2,
);
fs.writeFileSync(path.join(destination, "components.json"), inventory, {
  flag: "wx",
});
hashes["components.json"] = hash(inventory);
const version = spawnSync(moon, ["version", "--all"], {
  cwd: project,
  env: moonEnv,
  encoding: "utf8",
});
if (version.status !== 0) throw new Error("Unable to record toolchain");
const manifest = {
  format: 1,
  version: sourceVersion,
  platform: process.platform,
  arch: process.arch,
  toolchain: version.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+(?:[A-Za-z]:[\\/]|\/)[^\r\n]*$/, ""))
    .join("\n"),
  files: hashes,
  ...(runtime ? { runtime } : {}),
  application_signed: false,
};
fs.writeFileSync(
  path.join(destination, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  { flag: "wx" },
);
const verified = spawnSync(
  process.execPath,
  [path.join(project, "scripts", "verify-package.mjs"), destination],
  { cwd: project, stdio: "inherit" },
);
if (verified.status !== 0) throw new Error("Bundle verification failed");
const smoke = spawnSync(
  process.execPath,
  [path.join(destination, "bin", "moonrestore.mjs"), "version"],
  { cwd: destination, encoding: "utf8" },
);
if (
  smoke.status !== 0 ||
  !smoke.stdout.includes("MoonRestore " + sourceVersion)
)
  throw new Error("Bundle smoke test failed");
const functional = spawnSync(
  process.execPath,
  [path.join(project, "scripts", "smoke-portable.mjs"), destination],
  { cwd: project, stdio: "inherit" },
);
if (functional.status !== 0)
  throw new Error("Bundle functional smoke test failed");
if (embedded) {
  const native = spawnSync(
    path.join(destination, "MoonRestore.exe"),
    ["--check"],
    { cwd: destination, timeout: 30000 },
  );
  if (native.status !== 0)
    throw new Error("Native package verification failed");
}
console.log(
  JSON.stringify(
    {
      ok: true,
      bundle: destination,
      file_count: Object.keys(hashes).length,
      runtime_required: embedded
        ? "included Node " + runtime.version
        : "Node.js >= 22.16.0",
      publicly_published: false,
    },
    null,
    2,
  ),
);
