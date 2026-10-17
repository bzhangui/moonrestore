import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { S3Backend } from "./s3.mjs";
import {
  core,
  openHost,
  hash,
  fingerprint,
  options,
  saveReport,
} from "./maintenance.mjs";
import { checked, readPrivate, writePrivate, unseal } from "./vault.mjs";
import { publishDirectory } from "./adapter.mjs";
import { checkpoint, credentials } from "./activity.mjs";
const ro = { MOONRESTORE_READ_ONLY: "1", MOONRESTORE_RECOVERY_TARGET: "" };
const validId = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const safeMember = (s) =>
  s === "moonrestore" ||
  s === "encryption.json" ||
  (/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(s) &&
    s.slice(8, 10) === s.slice(11, 13)) ||
  /^snapshots\/[a-f0-9]{64}\.json$/.test(s);
export async function pushSnapshot(
  repository,
  snapshot,
  backend,
  { prefix = "moonrestore" } = {},
) {
  if (
    !validId(snapshot) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(prefix) ||
    !(backend instanceof S3Backend)
  )
    throw new Error("Invalid remote snapshot request");
  const before = fingerprint(repository),
    model = await core(["catalog", repository, snapshot], { env: ro });
  const audit = await core(["audit", repository, snapshot], { env: ro });
  if (!audit.ok)
    throw new Error("Full source audit required before remote upload");
  const host = openHost(repository, {
    environment: { ...process.env, ...credentials(repository), ...ro },
  });
  try {
    if (!host.key)
      throw new Error(
        "Remote snapshots require an encrypted repository; plaintext upload refused",
      );
    const namespace = prefix + "/" + host.vault.id,
      members = [],
      seen = new Map();
    const upload = async (rel, bytes) => {
      checkpoint("remote_copy", { uploaded_members: members.length });
      const key = namespace + "/content/" + hash(bytes),
        stored = await backend.putImmutable(key, bytes);
      members.push({ path: rel, key, ...stored });
    };
    await upload(
      "moonrestore",
      readPrivate(path.join(host.repo, "moonrestore"), 128),
    );
    const config = readPrivate(path.join(host.repo, "encryption.json"), 4096);
    if (JSON.stringify(JSON.parse(config)) !== JSON.stringify(host.vault))
      throw new Error("Repository encryption configuration changed");
    await upload("encryption.json", config);
    for (const entry of model.entries)
      for (const part of entry.chunks) {
        if (seen.has(part.id)) {
          if (seen.get(part.id) !== part.size)
            throw new Error("Conflicting remote object sizes");
          continue;
        }
        if (seen.size >= 100000)
          throw new Error("Remote snapshot budget (100000 unique objects)");
        const file = host.storagePath("object", part.id),
          raw = readPrivate(file, 1048640),
          physical = path.basename(file),
          plain = unseal(host.key, host.vault, "object", physical, raw);
        if (
          plain.id !== part.id ||
          plain.bytes.length !== part.size ||
          hash(plain.bytes) !== part.id
        )
          throw new Error("Remote source object changed or corrupted");
        await upload("objects/" + physical.slice(0, 2) + "/" + physical, raw);
        seen.set(part.id, part.size);
      }
    const file = host.storagePath("manifest", snapshot),
      raw = readPrivate(file, 33554496),
      physical = path.basename(file).slice(0, -5);
    const plain = unseal(host.key, host.vault, "manifest", physical, raw);
    if (
      plain.id !== snapshot ||
      hash(plain.bytes) !== snapshot ||
      fingerprint(repository) !== before
    )
      throw new Error("Remote source snapshot changed");
    await upload("snapshots/" + physical + ".json", raw);
    const receipt = {
      format: 1,
      kind: "moonrestore_encrypted_snapshot",
      snapshot,
      created: model.created,
      members,
      encrypted: true,
      server_retention_reported: members.every(
        (m) => m.server_retention_reported,
      ),
      physical_independence_verified: false,
    };
    const encoded = Buffer.from(JSON.stringify(receipt));
    if (encoded.length > 33554432)
      throw new Error("Remote receipt size budget");
    const checksum = hash(encoded),
      key = namespace + "/receipts/" + checksum + ".json",
      commit = await backend.putImmutable(key, encoded);
    const report = {
      ok: true,
      kind: "s3_snapshot_copy",
      snapshot,
      receipt_key: key,
      receipt_checksum: checksum,
      receipt_version: commit.version,
      members: members.length,
      server_retention_reported:
        commit.server_retention_reported && receipt.server_retention_reported,
      real_cloud_provider_verified: false,
      deletions_propagated: false,
    };
    return { ...report, files: saveReport(report) };
  } finally {
    host.clean();
  }
}
export async function restoreRemote(
  backend,
  receiptKey,
  checksum,
  destination,
  { version } = {},
) {
  if (!(backend instanceof S3Backend) || !validId(checksum))
    throw new Error("Pinned remote receipt checksum required");
  destination = checked(destination, false);
  const parent = checked(path.dirname(destination));
  if (fs.existsSync(destination))
    throw new Error("Remote restore requires a NEW repository");
  const response = await backend.get(receiptKey, { version, checksum }),
    record = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
    );
  if (
    record.format !== 1 ||
    record.kind !== "moonrestore_encrypted_snapshot" ||
    record.encrypted !== true ||
    !validId(record.snapshot) ||
    !Array.isArray(record.members) ||
    record.members.length > 100003
  )
    throw new Error("Invalid remote receipt");
  const names = new Set();
  let manifests = 0,
    totalBytes = 0;
  for (const member of record.members) {
    if (
      !member ||
      !safeMember(member.path) ||
      names.has(member.path) ||
      !validId(member.checksum) ||
      !/^([1-9][0-9]{0,8})$/.test(member.size) ||
      Number(member.size) > 33554496 ||
      typeof member.key !== "string"
    )
      throw new Error("Invalid remote member");
    totalBytes += Number(member.size);
    if (
      totalBytes > 1099511627776 ||
      (member.path === "moonrestore" && Number(member.size) > 128) ||
      (member.path === "encryption.json" && Number(member.size) > 4096) ||
      (member.path.startsWith("objects/") && Number(member.size) > 1048640)
    )
      throw new Error("Remote receipt exceeds repository budgets");
    names.add(member.path);
    if (member.path.startsWith("snapshots/")) manifests++;
  }
  if (
    !names.has("moonrestore") ||
    !names.has("encryption.json") ||
    manifests !== 1
  )
    throw new Error("Incomplete remote receipt");
  const stage = path.join(parent, `.moonrestore-${randomUUID()}.partial`);
  fs.mkdirSync(stage, { mode: 0o700 });
  for (const folder of ["objects", "snapshots", "tmp"])
    fs.mkdirSync(path.join(stage, folder), { mode: 0o700 });
  for (const member of record.members) {
    checkpoint("remote_restore");
    const body = await backend.get(member.key, {
      version: member.version,
      checksum: member.checksum,
    });
    if (body.bytes.length !== Number(member.size))
      throw new Error("Remote member length mismatch");
    const file = path.join(stage, ...member.path.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writePrivate(file, body.bytes);
  }
  const magic = readPrivate(path.join(stage, "moonrestore"), 128).toString();
  if (
    ![
      "moonrestore-encrypted-repository-v2\n",
      "moonrestore-encrypted-repository-v3\n",
    ].includes(magic)
  )
    throw new Error("Remote repository encryption profile mismatch");
  const audit = await core(["audit", stage, record.snapshot], { env: ro });
  if (!audit.ok) throw new Error("Downloaded repository failed complete audit");
  publishDirectory(stage, destination);
  const report = {
    ok: true,
    kind: "s3_snapshot_restore",
    snapshot: record.snapshot,
    members: record.members.length,
    full_snapshot_audit: true,
    source_receipt_pinned: true,
    real_cloud_provider_verified: false,
  };
  return { ...report, destination, files: saveReport(report) };
}
export async function remoteCommand(args) {
  if (!["s3-push", "s3-restore"].includes(args[0])) return null;
  const { values: v, positionals: p } = options(
    args.slice(1),
    [
      "endpoint",
      "bucket",
      "region",
      "prefix",
      "allow-remote",
      "retention-days",
      "allow-retention",
      "version",
    ],
    ["allow-remote", "allow-retention"],
  );
  if (p.length !== (args[0] === "s3-push" ? 2 : 3) || !v.endpoint || !v.bucket)
    throw new Error(
      "S3 command requires explicit endpoint, bucket and snapshot/receipt arguments",
    );
  if (
    (args[0] === "s3-restore" &&
      ["prefix", "retention-days", "allow-retention"].some((k) => k in v)) ||
    (args[0] === "s3-push" && "version" in v)
  )
    throw new Error("Inapplicable S3 option");
  const backend = new S3Backend({
    endpoint: v.endpoint,
    bucket: v.bucket,
    region: v.region,
    allowRemote: !!v["allow-remote"],
    retentionDays:
      v["retention-days"] === undefined ? 0 : Number(v["retention-days"]),
    allowRetention: !!v["allow-retention"],
    accessKeyId: process.env.MOONRESTORE_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.MOONRESTORE_S3_SECRET_ACCESS_KEY,
    sessionToken: process.env.MOONRESTORE_S3_SESSION_TOKEN,
  });
  return args[0] === "s3-push"
    ? pushSnapshot(p[0], p[1], backend, { prefix: v.prefix })
    : restoreRemote(backend, ...p, { version: v.version });
}
