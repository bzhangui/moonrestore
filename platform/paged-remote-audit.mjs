// Bounded ciphertext observations, not a substitute for a full restore audit.
import { createHash } from "node:crypto";
const id = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const version = (v) =>
  typeof v === "string" && v.length > 0 && v.length <= 1024 && v !== "null";
const sha = (b) => createHash("sha256").update(b).digest("hex");
export function pagedReceiptRoot(r, key) {
  const match =
    typeof key === "string" &&
    key.match(
      /^([A-Za-z0-9_-]{1,64}\/[a-f0-9-]{36})\/receipts\/([a-f0-9]{64})\.json$/,
    );
  if (
    !match ||
    r?.format !== 2 ||
    r.kind !== "moonrestore_paged_encrypted_snapshot" ||
    r.encrypted !== true ||
    !id(r.snapshot) ||
    !Number.isSafeInteger(r.members) ||
    r.members < 4 ||
    r.members > 524288 ||
    !/^[1-9][0-9]{0,12}$/.test(r.bytes) ||
    Number(r.bytes) > 2199023255552 ||
    !Array.isArray(r.pages) ||
    r.pages.length !== Math.ceil(r.members / 128)
  )
    throw new Error("Invalid paged audit root");
  const namespace = match[1];
  const seen = new Set();
  for (const p of r.pages) {
    if (
      !p ||
      !id(p.checksum) ||
      p.key !== namespace + "/receipt-pages/" + p.checksum ||
      seen.has(p.key) ||
      !/^[1-9][0-9]{0,5}$/.test(p.size) ||
      Number(p.size) > 262144 ||
      !version(p.version)
    )
      throw new Error("Invalid pinned audit page");
    seen.add(p.key);
  }
  return namespace;
}
export async function auditPagedReceipt(
  backend,
  key,
  read,
  r,
  { offset, batch, retentionDays, now },
) {
  const namespace = pagedReceiptRoot(r, key);
  if (offset >= r.members) throw new Error("Audit offset beyond receipt");
  const end = Math.min(offset + batch, r.members),
    minimum = now + retentionDays * 86400000;
  let until = Number.MAX_SAFE_INTEGER,
    observedBytes = 0;
  const retention = (response) => {
    if (!retentionDays) return;
    const date = Date.parse(
      response.headers.get("x-amz-object-lock-retain-until-date"),
    );
    if (
      response.headers.get("x-amz-object-lock-mode") !== "COMPLIANCE" ||
      !(date >= minimum)
    )
      throw new Error("Paged retention not reported or insufficient");
    until = Math.min(until, date);
  };
  retention(read);
  const seen = new Set();
  let checked = 0;
  for (
    let i = Math.floor(offset / 128);
    i <= Math.floor((end - 1) / 128);
    i++
  ) {
    const ref = r.pages[i],
      fetched = await backend.get(ref.key, {
        version: ref.version,
        checksum: ref.checksum,
      });
    if (
      fetched.bytes.length !== Number(ref.size) ||
      sha(fetched.bytes) !== ref.checksum
    )
      throw new Error("Paged receipt page checksum/size mismatch");
    retention(fetched);
    const page = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(fetched.bytes),
    );
    if (
      !Array.isArray(page) ||
      page.length !== Math.min(128, r.members - i * 128)
    )
      throw new Error("Invalid paged audit page length");
    for (let j = 0; j < page.length; j++) {
      const m = page[j];
      if (
        !m ||
        typeof m.path !== "string" ||
        !(
          ["moonrestore", "repository-id", "encryption.json"].includes(
            m.path,
          ) || /^(pages|packs|snapshots)\/[a-f0-9]{64}$/.test(m.path)
        ) ||
        !id(m.checksum) ||
        m.key !== namespace + "/content/" + m.checksum ||
        !version(m.version) ||
        !/^[1-9][0-9]{0,7}$/.test(m.size) ||
        Number(m.size) > 8388704
      )
        throw new Error("Invalid paged audit member");
      const position = i * 128 + j;
      if (position < offset || position >= end) continue;
      if (seen.has(m.path)) throw new Error("Duplicate paged audit member");
      seen.add(m.path);
      const data = await backend.get(m.key, {
        version: m.version,
        checksum: m.checksum,
      });
      if (
        data.bytes.length !== Number(m.size) ||
        sha(data.bytes) !== m.checksum
      )
        throw new Error("Paged remote member checksum/size mismatch");
      retention(data);
      checked++;
      observedBytes += data.bytes.length;
    }
  }
  const complete = offset === 0 && end === r.members;
  if (
    complete &&
    (String(observedBytes) !== r.bytes ||
      !["moonrestore", "repository-id", "encryption.json"].every((p) =>
        seen.has(p),
      ) ||
      [...seen].filter((p) => p.startsWith("snapshots/")).length !== 1)
  )
    throw new Error("Incomplete paged audit inventory");
  return {
    ok: true,
    kind: "remote_version_audit",
    receipt_format: 2,
    snapshot: r.snapshot,
    checked,
    total: r.members,
    next_offset: end < r.members ? end : null,
    entire_receipt_checked: complete,
    inventory_uniqueness_verified: complete,
    version_pinned: true,
    plaintext_content_verified: false,
    cleanup_authorized: false,
    server_retention_reported: retentionDays > 0,
    requested_remaining_days: retentionDays,
    minimum_retention_until: retentionDays
      ? new Date(until).toISOString()
      : null,
    remote_writes: false,
    delete_permission_tested: false,
    real_cloud_provider_verified: false,
  };
}
