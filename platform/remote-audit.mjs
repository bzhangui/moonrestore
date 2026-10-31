import { S3Backend } from "./s3.mjs";
import { options } from "./maintenance.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  stateHome,
  mkdirPrivate,
  readPrivate,
  writePrivate,
} from "./vault.mjs";
import { auditPagedReceipt } from "./paged-remote-audit.mjs";

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
    offset > 524288 ||
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
  const read = await backend.get(key, { version, checksum });
  if (read.bytes.length > 33554496)
    throw new Error("Remote receipt byte budget");
  const parsed = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(read.bytes),
  );
  if (parsed.format === 2)
    return auditPagedReceipt(backend, key, read, parsed, {
      offset,
      batch,
      retentionDays,
      now,
    });
  const r = receipt(read.bytes);
  if (offset >= r.members.length)
    throw new Error("Audit offset beyond receipt");
  const selected = r.members.slice(offset, offset + batch),
    minimum = now + retentionDays * 86400000;
  let retainUntil = Number.MAX_SAFE_INTEGER;
  const locked = (response) =>
    response.headers.get("x-amz-object-lock-mode") === "COMPLIANCE" &&
    Date.parse(response.headers.get("x-amz-object-lock-retain-until-date")) >=
      minimum;
  if (retentionDays && !locked(read))
    throw new Error("Receipt retention not reported or insufficient");
  if (retentionDays)
    retainUntil = Math.min(
      retainUntil,
      Date.parse(read.headers.get("x-amz-object-lock-retain-until-date")),
    );
  for (const member of selected) {
    const data = await backend.get(member.key, {
      version: member.version,
      checksum: member.checksum,
    });
    if (data.bytes.length !== Number(member.size))
      throw new Error("Remote member size mismatch");
    if (retentionDays && !locked(data))
      throw new Error("Member retention not reported or insufficient");
    if (retentionDays)
      retainUntil = Math.min(
        retainUntil,
        Date.parse(data.headers.get("x-amz-object-lock-retain-until-date")),
      );
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
    minimum_retention_until: retentionDays
      ? new Date(retainUntil).toISOString()
      : null,
  };
}
export async function auditRemoteCycle(
  backend,
  key,
  checksum,
  {
    cycleId,
    version,
    batch = 100,
    retentionDays = 0,
    now = Date.now(),
    retry = false,
    recover = false,
  } = {},
) {
  if (
    !(backend instanceof S3Backend) ||
    !id(checksum) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      cycleId || "",
    ) ||
    typeof version !== "string" ||
    !version ||
    typeof retry !== "boolean" ||
    typeof recover !== "boolean" ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error("Explicit audit cycle identity/version required");
  const descriptor = {
    endpoint: backend.config.endpoint,
    bucket: backend.config.bucket,
    region: backend.config.region,
    key,
    checksum,
    version,
    retentionDays,
  };
  const binding = createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex");
  const folder = mkdirPrivate(path.join(stateHome(), "remote-audit-cycles")),
    file = path.join(folder, cycleId + ".json"),
    lock = file + ".lock";
  const integrity = path.join(folder, "integrity.key");
  if (!fs.existsSync(integrity)) {
    if (fs.existsSync(file))
      throw new Error(
        "Audit integrity key missing; start a new cycle in a fresh state",
      );
    try {
      writePrivate(integrity, randomBytes(32));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const integrityKey = readPrivate(integrity, 32);
  if (integrityKey.length !== 32)
    throw new Error("Invalid audit integrity key");
  const mac = (record) =>
    createHmac("sha256", integrityKey)
      .update(JSON.stringify(record))
      .digest("hex");
  if (fs.existsSync(lock) && recover) {
    const owner = JSON.parse(readPrivate(path.join(lock, "owner.json"), 512));
    if (
      owner.host !== os.hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1
    )
      throw new Error("Audit lock identity unavailable");
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive) throw new Error("Audit cycle still active");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  writePrivate(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, host: os.hostname() }),
  );
  const save = (r) => {
    const temp = file + "." + randomUUID() + ".tmp";
    writePrivate(temp, JSON.stringify({ record: r, mac: mac(r) }));
    try {
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  };
  let record;
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(readPrivate(file, 4096));
      if (
        !saved.record ||
        !id(saved.mac) ||
        !timingSafeEqual(
          Buffer.from(saved.mac, "hex"),
          Buffer.from(mac(saved.record), "hex"),
        )
      )
        throw new Error("Audit cursor authentication failed");
      record = saved.record;
    } else
      record = {
        format: 1,
        cycle: cycleId,
        binding,
        started: now,
        updated: now,
        offset: 0,
        total: null,
        state: "incomplete",
        minimumRetention: null,
      };
    if (
      record.format !== 1 ||
      record.cycle !== cycleId ||
      record.binding !== binding ||
      !Number.isSafeInteger(record.offset) ||
      record.offset < 0 ||
      record.offset > 524288 ||
      !Number.isSafeInteger(record.started) ||
      !Number.isSafeInteger(record.updated) ||
      now < record.updated ||
      now - record.started > 3600000
    )
      throw new Error(
        "Audit cycle binding, cursor, clock or freshness invalid; use a new cycle",
      );
    if (record.state === "failed" && !retry)
      throw new Error(
        "Audit cycle failed; explicit retry or new cycle required",
      );
    if (record.state === "complete") {
      if (
        record.total !== record.offset ||
        (retentionDays &&
          record.minimumRetention < now + retentionDays * 86400000)
      )
        throw new Error(
          "Completed observation no longer meets requested retention; use a new cycle",
        );
      return {
        ...record,
        ok: true,
        entire_receipt_checked: true,
        inventory_uniqueness_verified: false,
        cleanup_authorized: false,
        plaintext_content_verified: false,
        real_cloud_provider_verified: false,
        cached_completed_observation: true,
        new_remote_reads: false,
      };
    }
    let result;
    try {
      result = await auditRemote(backend, key, checksum, {
        version,
        batch,
        offset: record.offset,
        retentionDays,
        now,
      });
    } catch (error) {
      save({ ...record, state: "failed", updated: now });
      throw error;
    }
    if (record.total !== null && record.total !== result.total)
      throw new Error("Receipt total changed within audit cycle");
    const minimum = result.minimum_retention_until
      ? Math.min(
          record.minimumRetention ?? Number.MAX_SAFE_INTEGER,
          Date.parse(result.minimum_retention_until),
        )
      : null;
    const completed = result.next_offset === null;
    if (
      completed &&
      retentionDays &&
      minimum < Math.max(now, Date.now()) + retentionDays * 86400000
    ) {
      save({ ...record, state: "failed", updated: now });
      throw new Error(
        "Retention shortened or insufficient at cycle completion",
      );
    }
    record = {
      ...record,
      offset: result.next_offset ?? result.total,
      total: result.total,
      updated: now,
      state: completed ? "complete" : "incomplete",
      minimumRetention: minimum,
    };
    save(record);
    return {
      ok: true,
      kind: "remote_audit_cycle",
      cycle: cycleId,
      state: record.state,
      checked: record.offset,
      total: record.total,
      next_offset: completed ? null : record.offset,
      entire_receipt_checked: completed,
      inventory_uniqueness_verified: false,
      cleanup_authorized: false,
      observed_at: new Date(now).toISOString(),
      plaintext_content_verified: false,
      real_cloud_provider_verified: false,
      remote_writes: false,
      delete_permission_tested: false,
    };
  } finally {
    integrityKey.fill(0);
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
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
  if (
    !["remote-audit", "remote-audit-cycle", "remote-writer-policy"].includes(c)
  )
    return null;
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
      "cycle",
      "retry",
      "recover",
    ],
    ["allow-remote", "retry", "recover"],
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
  if (c === "remote-audit" && (v.cycle !== undefined || v.retry || v.recover))
    throw new Error("Cycle options require remote-audit-cycle");
  if (c === "remote-audit-cycle" && (v.offset !== undefined || !v.cycle))
    throw new Error(
      "Cycle requires --cycle new|UUID; offset is controlled by the journal",
    );
  return (c === "remote-audit-cycle" ? auditRemoteCycle : auditRemote)(
    backend,
    p[0],
    p[1],
    {
      ...(c === "remote-audit-cycle"
        ? {
            cycleId: v.cycle === "new" ? randomUUID() : v.cycle,
            retry: !!v.retry,
            recover: !!v.recover,
          }
        : {}),
      version: v.version,
      offset: v.offset === undefined ? 0 : Number(v.offset),
      batch: v.batch === undefined ? 100 : Number(v.batch),
      retentionDays:
        v["remaining-days"] === undefined ? 0 : Number(v["remaining-days"]),
    },
  );
}
