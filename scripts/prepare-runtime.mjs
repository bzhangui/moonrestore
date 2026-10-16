// Fetch an exact official Windows runtime; verify before adding it to a bundle.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Embedded desktop package currently supports Windows x64");
const version = process.version;
if (!/^v\d+\.\d+\.\d+$/.test(version))
  throw new Error("Invalid Node release version");
const root = fileURLToPath(new URL("../.local/runtime/", import.meta.url));
fs.mkdirSync(root, { recursive: true });
async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error("Official runtime download failed: " + response.status);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error("Runtime download exceeds budget");
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const base = "https://nodejs.org/dist/" + version + "/",
  sums = (await download(base + "SHASUMS256.txt", 262144)).toString();
const expected = sums
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find((parts) => parts[1] === "win-x64/node.exe")?.[0];
if (!/^[a-f0-9]{64}$/.test(expected || ""))
  throw new Error("Official runtime checksum missing");
const executable = path.join(root, "node.exe"),
  hash = (b) => createHash("sha256").update(b).digest("hex");
let bytes = fs.existsSync(executable) ? fs.readFileSync(executable) : null;
if (!bytes || hash(bytes) !== expected) {
  bytes = await download(base + "win-x64/node.exe", 268435456);
  if (hash(bytes) !== expected) throw new Error("Runtime checksum mismatch");
  fs.writeFileSync(executable, bytes);
}
const license = await download(
  "https://raw.githubusercontent.com/nodejs/node/" + version + "/LICENSE",
  2097152,
);
fs.writeFileSync(path.join(root, "NODE_LICENSE.txt"), license);
const evidence = {
  version,
  sha256: expected,
  source: base + "win-x64/node.exe",
  checksums_source: base + "SHASUMS256.txt",
  license_source:
    "https://raw.githubusercontent.com/nodejs/node/" + version + "/LICENSE",
  license_sha256: hash(license),
  publisher_gpg_signature_verified: false,
};
fs.writeFileSync(
  path.join(root, "provenance.json"),
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    official_runtime_prepared: true,
    version,
    sha256: expected,
    bytes: bytes.length,
  }),
);
