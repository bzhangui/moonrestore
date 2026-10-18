// Standard Ed25519 detached attestations. Trust is supplied out of band, never
// inferred from a public key embedded in an untrusted archive or package.
import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { checked, readPrivate, writePrivate } from "./vault.mjs";
import { atomicPrivate } from "./journal.mjs";
import { options } from "./maintenance.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const digest = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
function strict(x, keys) {
  if (
    !x ||
    typeof x !== "object" ||
    Array.isArray(x) ||
    Object.keys(x).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(x, k))
  )
    throw new Error("Invalid attestation fields");
}
function publicKey(file) {
  const key = createPublicKey(readPrivate(file, 4096));
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Expected Ed25519 key");
  return { key, id: hash(key.export({ type: "spki", format: "der" })) };
}
function password() {
  const p = process.env.MOONRESTORE_SIGNING_PASSWORD;
  if (
    typeof p !== "string" ||
    Buffer.byteLength(p) < 12 ||
    Buffer.byteLength(p) > 4096
  )
    throw new Error(
      "Set a private 12..4096 byte MOONRESTORE_SIGNING_PASSWORD; never pass it as an argument",
    );
  return p;
}
export function createSigningKey(destination) {
  const passphrase = password(),
    dir = checked(destination, false);
  checked(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o700 }); // New destination, never replace an old key.
  const pair = generateKeyPairSync("ed25519"),
    pem = pair.publicKey.export({ type: "spki", format: "pem" });
  writePrivate(
    path.join(dir, "private.pem"),
    pair.privateKey.export({
      type: "pkcs8",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase,
    }),
  );
  writePrivate(path.join(dir, "public.pem"), pem);
  return {
    ok: true,
    kind: "signing_key",
    encrypted_private_key: true,
    key_id: publicKey(path.join(dir, "public.pem")).id,
    private_key_uploaded: false,
    keep_key_separate: true,
  };
}
function payload(x) {
  strict(x, [
    "format",
    "kind",
    "subject",
    "sha256",
    "sequence",
    "previous",
    "created",
    "key_id",
  ]);
  if (
    x.format !== 1 ||
    x.kind !== "moonrestore-attestation" ||
    !["snapshot", "archive", "package"].includes(x.subject) ||
    !digest(x.sha256) ||
    !digest(x.key_id) ||
    !Number.isSafeInteger(x.sequence) ||
    x.sequence < 1 ||
    (x.sequence === 1 ? x.previous !== null : !digest(x.previous)) ||
    typeof x.created !== "string" ||
    !Number.isFinite(Date.parse(x.created)) ||
    new Date(x.created).toISOString() !== x.created
  )
    throw new Error("Invalid attestation payload");
  return {
    format: 1,
    kind: x.kind,
    subject: x.subject,
    sha256: x.sha256,
    sequence: x.sequence,
    previous: x.previous,
    created: x.created,
    key_id: x.key_id,
  };
}
export function signArtifact(
  input,
  keyFile,
  output,
  { subject, sequence = 1, previous = null } = {},
) {
  const passphrase = password(),
    pem = readPrivate(keyFile, 8192);
  if (!pem.toString().startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----"))
    throw new Error("Only password-encrypted PKCS8 signing keys accepted");
  const key = createPrivateKey({ key: pem, passphrase });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Expected Ed25519 key");
  const keyId = hash(
      createPublicKey(key).export({ type: "spki", format: "der" }),
    ),
    p = payload({
      format: 1,
      kind: "moonrestore-attestation",
      subject,
      sha256: hash(readPrivate(input, 67108864)),
      sequence,
      previous,
      created: new Date().toISOString(),
      key_id: keyId,
    }),
    bytes = Buffer.from(JSON.stringify(p)),
    envelope = Buffer.from(
      JSON.stringify({
        payload: p,
        signature: sign(null, bytes, key).toString("base64"),
      }),
    );
  writePrivate(checked(output, false), envelope);
  return {
    ok: true,
    key_id: keyId,
    attestation_hash: hash(envelope),
    sequence,
    subject,
    content_sha256: p.sha256,
    signature_created: true,
    business_correctness_proven: false,
  };
}
export function verifyArtifact(
  input,
  signatureFile,
  publicFile,
  { anchor, trust } = {},
) {
  const raw = readPrivate(signatureFile, 16384),
    envelope = JSON.parse(raw);
  strict(envelope, ["payload", "signature"]);
  const p = payload(envelope.payload),
    key = publicKey(publicFile),
    signature =
      typeof envelope.signature === "string"
        ? Buffer.from(envelope.signature, "base64")
        : Buffer.alloc(0);
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== envelope.signature ||
    key.id !== p.key_id ||
    !verify(null, Buffer.from(JSON.stringify(p)), key.key, signature) ||
    hash(readPrivate(input, 67108864)) !== p.sha256
  )
    throw new Error(
      "Signature, trusted public key or artifact content mismatch",
    );
  const receiptHash = hash(raw);
  let rollbackProtected = false;
  if (anchor) {
    const file = checked(anchor, false);
    checked(path.dirname(file));
    const lock = file + ".lock";
    fs.mkdirSync(lock, { mode: 0o700 });
    try {
      if (fs.existsSync(file)) {
        const a = JSON.parse(readPrivate(file, 16384));
        strict(a, [
          "format",
          "key_id",
          "subject",
          "sequence",
          "attestation_hash",
        ]);
        if (
          a.format !== 1 ||
          a.key_id !== p.key_id ||
          a.subject !== p.subject ||
          !digest(a.attestation_hash) ||
          !Number.isSafeInteger(a.sequence) ||
          a.sequence < 1 ||
          (p.sequence !== a.sequence && p.sequence !== a.sequence + 1) ||
          (p.sequence === a.sequence
            ? receiptHash !== a.attestation_hash
            : p.previous !== a.attestation_hash)
        )
          throw new Error("Rollback, chain gap or anchor mismatch");
      } else if (p.sequence !== 1 || trust !== receiptHash) {
        throw new Error(
          "First anchor requires exact independently trusted attestation hash and sequence 1",
        );
      }
      atomicPrivate(
        file,
        Buffer.from(
          JSON.stringify({
            format: 1,
            key_id: p.key_id,
            subject: p.subject,
            sequence: p.sequence,
            attestation_hash: receiptHash,
          }),
        ),
      );
      rollbackProtected = true;
    } finally {
      fs.rmdirSync(lock);
    }
  } else if (trust !== undefined)
    throw new Error("Trust pin requires an anchor file");
  return {
    ok: true,
    signature_verified: true,
    key_id: key.id,
    content_sha256: p.sha256,
    sequence: p.sequence,
    attestation_hash: receiptHash,
    rollback_protected_by_local_anchor: rollbackProtected,
    compromised_local_account_protected: false,
    business_correctness_proven: false,
  };
}
export function attestationCommand(args) {
  const [c, ...a] = args;
  if (!["signing-key-create", "artifact-sign", "artifact-verify"].includes(c))
    return null;
  const { positionals: p, values: v } = options(a, [
    "subject",
    "sequence",
    "previous",
    "anchor",
    "trust",
  ]);
  if (c === "signing-key-create" && p.length === 1 && !Object.keys(v).length)
    return createSigningKey(p[0]);
  if (
    c === "artifact-sign" &&
    p.length === 3 &&
    v.subject &&
    Object.keys(v).every((k) => ["subject", "sequence", "previous"].includes(k))
  )
    return signArtifact(...p, {
      subject: v.subject,
      sequence: v.sequence === undefined ? 1 : Number(v.sequence),
      previous: v.previous ?? null,
    });
  if (
    c === "artifact-verify" &&
    p.length === 3 &&
    Object.keys(v).every((k) => ["anchor", "trust"].includes(k))
  )
    return verifyArtifact(...p, { anchor: v.anchor, trust: v.trust });
  throw new Error("Invalid attestation command");
}
