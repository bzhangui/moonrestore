// Verifies a finite, no-link executable bundle before any code in it is run.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checked, readPrivate } from "./vault.mjs";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function verifyDistribution(directory, expectedManifest) {
  const root = checked(directory),
    manifestFile = path.join(root, "manifest.json"),
    bytes = readPrivate(manifestFile, 1048576),
    manifestHash = sha256(bytes);
  if (
    expectedManifest !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedManifest) ||
      expectedManifest !== manifestHash)
  )
    throw new Error("Trusted bundle manifest hash mismatch");
  const m = JSON.parse(bytes);
  if (
    m.format !== 1 ||
    !m.files ||
    typeof m.files !== "object" ||
    Array.isArray(m.files) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(m.version || "") ||
    Object.keys(m.files).length > 128 ||
    !Object.hasOwn(m.files, "bin/moonrestore.mjs") ||
    !Object.hasOwn(m.files, "_build/js/release/build/cmd/main/main.js") ||
    !Object.hasOwn(m.files, "LICENSE") ||
    !Object.hasOwn(m.files, "NOTICE")
  )
    throw new Error("Invalid executable bundle manifest");
  let total = 0;
  for (const [rel, expected] of Object.entries(m.files)) {
    if (
      !rel ||
      /[\\:\x00-\x1f]/.test(rel) ||
      path.isAbsolute(rel) ||
      rel.split("/").some((p) => !p || p === "." || p === "..") ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error("Unsafe bundle path/digest");
    const file = checked(path.join(root, ...rel.split("/"))),
      s = fs.lstatSync(file),
      limit = rel === "runtime/node.exe" ? 268435456 : 16777216;
    if (
      !s.isFile() ||
      s.nlink !== 1 ||
      s.size > limit ||
      (total += s.size) > 536870912
    )
      throw new Error("Bundle file/total budget");
    if (sha256(readPrivate(file, limit)) !== expected)
      throw new Error("Bundle checksum mismatch");
  }
  return {
    ok: true,
    manifest: m,
    manifest_sha256: manifestHash,
    files: Object.keys(m.files).length,
    bytes: total,
    signature_verified: false,
  };
}
