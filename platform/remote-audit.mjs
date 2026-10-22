import { S3Backend } from "./s3.mjs";
import { options } from "./maintenance.mjs";

const id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function receipt(bytes) {
  const r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    r.format !== 1 ||
    r.kind !== "moonrestore_encrypted_snapshot" ||
    r.encrypted !== true ||
    !id(r.snapshot) ||
    !Array.isArray(r.members) ||
    r.members.length < 3 ||
    r.members.length > 100003
  )
    throw new Error("Invalid pinned receipt");
  const seen = new Set();
  let total = 0,
    manifests = 0;
  for (const m of r.members) {
    if (
      !m ||
      typeof m.path !== "string" ||
      !/^(moonrestore|encryption\.json|objects\/[a-f0-9]{2}\/[a-f0-9]{64}|snapshots\/[a-f0-9]{64}\.json)$/.test(
        m.path,
      ) ||
      seen.has(m.path) ||
      !id(m.checksum) ||
      !/^([1-9][0-9]{0,8})$/.test(m.size) ||
      Number(m.size) > 33554496 ||
      typeof m.key !== "string" ||
      typeof m.version !== "string" ||
      !m.version ||
      m.version === "null"
    )
      throw new Error("Version-pinned receipt members required");
    if (
      m.path.startsWith("objects/") &&
      (m.path.slice(8, 10) !== m.path.slice(11, 13) || Number(m.size) > 1048640)
    )
      throw new Error("Invalid encrypted object member");
    total += Number(m.size);
    if (total > 1099511627776) throw new Error("Remote audit byte budget");
    seen.add(m.path);
    if (m.path.startsWith("snapshots/")) manifests++;
  }
  if (
    !seen.has("moonrestore") ||
    !seen.has("encryption.json") ||
    manifests !== 1
  )
    throw new Error("Incomplete encrypted snapshot receipt");
  return r;
}
export async function auditRemote(
  backend,
  key,
  checksum,
  {
    version,
    offset = 0,
    batch = 100,
    retentionDays = 0,
    now = Date.now(),
  } = {},
) {
  if (
    !(backend instanceof S3Backend) ||
    !id(checksum) ||
    typeof version !== "string" ||
    !version ||
    version === "null" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100003 ||
    !Number.isInteger(batch) ||
    batch < 1 ||
    batch > 1000 ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 0 ||
    retentionDays > 3650 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("Pinned version and bounded audit options required");
  const read = await backend.get(key, { version, checksum }),
    r = receipt(read.bytes);
  if (offset >= r.members.length)
    throw new Error("Audit offset beyond receipt");
  const selected = r.members.slice(offset, offset + batch),
    minimum = now + retentionDays * 86400000;
  const locked = (response) =>
    response.headers.get("x-amz-object-lock-mode") === "COMPLIANCE" &&
    Date.parse(response.headers.get("x-amz-object-lock-retain-until-date")) >=
      minimum;
  if (retentionDays && !locked(read))
    throw new Error("Receipt retention not reported or insufficient");
  for (const member of selected) {
    const data = await backend.get(member.key, {
      version: member.version,
      checksum: member.checksum,
    });
    if (data.bytes.length !== Number(member.size))
      throw new Error("Remote member size mismatch");
    if (retentionDays && !locked(data))
      throw new Error("Member retention not reported or insufficient");
  }
  return {
    ok: true,
    kind: "remote_version_audit",
    snapshot: r.snapshot,
    checked: selected.length,
    total: r.members.length,
    next_offset:
      offset + selected.length < r.members.length
        ? offset + selected.length
        : null,
    entire_receipt_checked:
      offset === 0 && selected.length === r.members.length,
    version_pinned: true,
    plaintext_content_verified: false,
    server_retention_reported: retentionDays > 0,
    requested_remaining_days: retentionDays,
    remote_writes: false,
    delete_permission_tested: false,
    real_cloud_provider_verified: false,
  };
}
export function remoteWriterPolicy(bucket, prefix) {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(prefix)
  )
    throw new Error("Explicit bucket and prefix required");
  const resource = "arn:aws:s3:::" + bucket + "/" + prefix + "/*";
  return {
    ok: true,
    template_only: true,
    applied: false,
    retention_permission_included: false,
    policy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:GetObjectVersion",
            "s3:GetObjectRetention",
            "s3:PutObject",
          ],
          Resource: resource,
        },
        {
          Effect: "Deny",
          Action: [
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
            "s3:BypassGovernanceRetention",
          ],
          Resource: resource,
        },
      ],
    },
    warning:
      "Review against the real provider; this does not change an account or prove independence.",
  };
}
export async function remoteAuditCommand(args) {
  const [c, ...a] = args;
  if (!["remote-audit", "remote-writer-policy"].includes(c)) return null;
  if (c === "remote-writer-policy") {
    const { positionals: p } = options(a, []);
    if (p.length !== 2) throw new Error("Expected bucket and prefix");
    return remoteWriterPolicy(...p);
  }
  const { positionals: p, values: v } = options(
    a,
    [
      "endpoint",
      "bucket",
      "region",
      "version",
      "offset",
      "batch",
      "remaining-days",
      "allow-remote",
    ],
    ["allow-remote"],
  );
  if (p.length !== 2 || !v.endpoint || !v.bucket)
    throw new Error("Expected receipt key/checksum and explicit backend");
  const backend = new S3Backend({
    endpoint: v.endpoint,
    bucket: v.bucket,
    region: v.region || "us-east-1",
    allowRemote: v["allow-remote"] === true,
    accessKeyId: process.env.MOONRESTORE_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.MOONRESTORE_S3_SECRET_ACCESS_KEY,
    sessionToken: process.env.MOONRESTORE_S3_SESSION_TOKEN,
  });
  return auditRemote(backend, p[0], p[1], {
    version: v.version,
    offset: v.offset === undefined ? 0 : Number(v.offset),
    batch: v.batch === undefined ? 100 : Number(v.batch),
    retentionDays:
      v["remaining-days"] === undefined ? 0 : Number(v["remaining-days"]),
  });
}
