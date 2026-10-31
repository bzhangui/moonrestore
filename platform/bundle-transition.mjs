// Verified side-by-side copy, never execution, service control or shortcut replacement.
import fs from "node:fs";
import path from "node:path";
import { verifyDistribution } from "./distribution.mjs";
import { checked } from "./vault.mjs";
import { publishDirectory } from "./adapter.mjs";
import { syncDirectory } from "./paged-store.mjs";
const id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const canon = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
export function copyVerifiedBundle(bundle, destination, manifestHash) {
  if (!id(manifestHash))
    throw new Error("Out-of-band trusted manifest SHA-256 required");
  const source = checked(bundle),
    dest = checked(destination, false),
    parent = checked(path.dirname(dest));
  if (
    fs.existsSync(dest) ||
    canon(source) === canon(dest) ||
    canon(dest).startsWith(canon(source) + path.sep) ||
    canon(source).startsWith(canon(dest) + path.sep)
  )
    throw new Error("Separate NEW application directory required");
  const verified = verifyDistribution(source, manifestHash),
    stage = fs.mkdtempSync(path.join(parent, ".moonrestore-install-"));
  // On failure, leave the precisely owned stage for inspection, never overwrite the destination.
  for (const rel of [
    ...Object.keys(verified.manifest.files),
    "manifest.json",
  ]) {
    const from = checked(path.join(source, ...rel.split("/"))),
      to = path.join(stage, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(to, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncDirectory(path.dirname(to));
  }
  verifyDistribution(stage, manifestHash);
  verifyDistribution(source, manifestHash);
  publishDirectory(stage, dest);
  syncDirectory(parent);
  verifyDistribution(dest, manifestHash);
  return {
    ok: true,
    kind: "verified_side_by_side_install",
    version: verified.manifest.version,
    files: verified.files,
    destination: dest,
    manifest_sha256: manifestHash,
    existing_versions_changed: false,
    state_or_keys_copied: false,
    shortcuts_changed: false,
    application_started: false,
    signature_verified: false,
  };
}
export function previewBundleTransition(current, next, currentHash, nextHash) {
  if (!id(currentHash) || !id(nextHash))
    throw new Error("Both out-of-band manifest hashes required");
  const a = verifyDistribution(current, currentHash),
    b = verifyDistribution(next, nextHash),
    formats = (m) => {
      const f = m.supported_repository_formats;
      return Array.isArray(f) &&
        f.length > 0 &&
        f.length <= 5 &&
        new Set(f).size === f.length &&
        f.every((v) => Number.isInteger(v) && v >= 1 && v <= 5)
        ? f
        : [];
    };
  const before = formats(a.manifest),
    after = formats(b.manifest);
  return {
    ok: true,
    preview_only: true,
    current_version: a.manifest.version,
    next_version: b.manifest.version,
    shared_declared_formats: before.filter((v) => after.includes(v)),
    next_formats: after,
    format_declaration_complete: !!before.length && !!after.length,
    manifest_checksums_verified: true,
    publisher_signature_verified: false,
    automatic_activation: false,
    automatic_state_downgrade: false,
    processes_stopped_verified: false,
    rollback_requires_old_bundle_and_compatible_private_state: true,
    repositories_or_private_state_changed: false,
  };
}
export function bundleCommand(args) {
  const [command, ...p] = args;
  if (command === "bundle-copy-verified" && p.length === 3)
    return copyVerifiedBundle(p[0], p[2], p[1]);
  if (command === "bundle-transition-preview" && p.length === 4)
    return previewBundleTransition(...p);
  if (command?.startsWith("bundle-"))
    throw new Error("Invalid bundle arguments");
  return null;
}
