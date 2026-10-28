// Continuity of archived segment NAMES and verified receipt bytes is necessary,
// not PostgreSQL replay certification. LSNs are never converted to wall time.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checked, readPrivate } from "./vault.mjs";
import { newFile, bounded } from "./paged-store.mjs";
import { checkpoint } from "./activity.mjs";
function root(directory) {
  const r = checked(directory);
  if (
    bounded(path.join(r, "moonrestore-wal"), 64).toString() !==
    "moonrestore-wal-archive-v1\n"
  )
    throw new Error("Explicit WAL archive required");
  return r;
}
function segmentSize(n) {
  if (
    !Number.isSafeInteger(n) ||
    n < 1048576 ||
    n > 1073741824 ||
    (n & (n - 1)) !== 0
  )
    throw new Error("WAL segment size must be a power of two 1MiB..1GiB");
  return n;
}
function lsn(value) {
  if (
    typeof value !== "string" ||
    !/^[A-F0-9]{1,8}\/[A-F0-9]{1,8}$/.test(value)
  )
    throw new Error("Canonical LSN required");
  const [a, b] = value.split("/");
  return (BigInt("0x" + a) << 32n) + BigInt("0x" + b);
}
function segmentIndex(name, bytes) {
  const count = 4294967296n / BigInt(bytes),
    segment = BigInt("0x" + name.slice(16));
  if (segment >= count)
    throw new Error("WAL segment number outside configured size");
  return BigInt("0x" + name.slice(8, 16)) * count + segment;
}
function verifyFile(directory, name) {
  const file = checked(path.join(directory, name)),
    r = JSON.parse(readPrivate(path.join(directory, name + ".json"), 1024)),
    fd = fs.openSync(file, "r"),
    h = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > 1073741824n ||
      before.size < 1n
    )
      throw new Error("WAL member budget");
    while (true) {
      checkpoint("wal_receipt_verify");
      const n = fs.readSync(fd, buffer);
      if (!n) break;
      h.update(buffer.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      r.size !== Number(before.size) ||
      r.sha256 !== h.digest("hex")
    )
      throw new Error("WAL receipt/hash mismatch");
    return r;
  } finally {
    fs.closeSync(fd);
  }
}
export function bindWalArchive(
  directory,
  { systemIdentifier, segmentBytes, confirmation } = {},
) {
  const r = root(directory);
  segmentSize(segmentBytes);
  if (
    typeof systemIdentifier !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(systemIdentifier) ||
    confirmation !== directory
  )
    throw new Error("Explicit cluster identity binding required");
  const value = {
    format: 1,
    system_identifier: systemIdentifier,
    segment_bytes: segmentBytes,
    operator_asserted: true,
    wal_header_identity_verified: false,
  };
  const file = path.join(r, "cluster.json");
  if (fs.existsSync(file)) {
    if (
      JSON.stringify(JSON.parse(readPrivate(file, 2048))) !==
      JSON.stringify(value)
    )
      throw new Error("WAL archive already bound to another cluster");
    return { ok: true, idempotent: true, ...value };
  }
  newFile(file, Buffer.from(JSON.stringify(value)));
  return { ok: true, ...value };
}
export function walHealth(
  directory,
  { baseMetadata, expectedEndLsn, timeline, archiveStatusDirectory } = {},
) {
  const r = root(directory),
    binding = JSON.parse(readPrivate(path.join(r, "cluster.json"), 2048));
  segmentSize(binding.segment_bytes);
  const base = JSON.parse(readPrivate(checked(baseMetadata), 262144));
  if (
    base.format !== 1 ||
    base.kind !== "postgresql_physical" ||
    base.system_identifier !== binding.system_identifier ||
    !Array.isArray(base.wal_ranges) ||
    !base.wal_ranges.length ||
    base.wal_ranges.length > 1000 ||
    !Number.isSafeInteger(timeline) ||
    timeline < 1 ||
    timeline > 4294967295
  )
    throw new Error("Physical base/cluster/timeline identity mismatch");
  const end = expectedEndLsn === undefined ? null : lsn(expectedEndLsn),
    t = timeline.toString(16).toUpperCase().padStart(8, "0"),
    segments = new Map();
  let history = 0,
    invalid = 0,
    other = 0,
    count = 0;
  const it = fs.opendirSync(r);
  try {
    for (let d = it.readSync(); d; d = it.readSync()) {
      if (++count > 200005) throw new Error("WAL inventory budget");
      if (!/^[A-F0-9]{24}$/.test(d.name)) continue;
      if (!d.name.startsWith(t)) {
        other++;
        continue;
      }
      try {
        const v = verifyFile(r, d.name);
        if (v.size !== binding.segment_bytes)
          throw new Error("WAL segment size mismatch");
        segments.set(
          segmentIndex(d.name, binding.segment_bytes).toString(),
          d.name,
        );
      } catch {
        invalid++;
      }
    }
  } finally {
    it.closeSync();
  }
  const ranges = base.wal_ranges.filter((v) => v.Timeline === timeline);
  if (!ranges.length)
    throw new Error(
      "Requested timeline not present in verified physical base metadata; cross-timeline target needs a new base/replay validation",
    );
  let start = null,
    baseEnd = 0n;
  for (const v of ranges) {
    const a = lsn(v["Start-LSN"]),
      b = lsn(v["End-LSN"]);
    if (b <= a) throw new Error("Invalid physical base WAL range");
    if (start === null || a < start) start = a;
    if (b > baseEnd) baseEnd = b;
  }
  if (end !== null && end < baseEnd)
    throw new Error("Target precedes physical base end");
  const first = start / BigInt(binding.segment_bytes),
    last = ((end ?? baseEnd) - 1n) / BigInt(binding.segment_bytes);
  if (last - first > 100000n) throw new Error("WAL coverage range budget");
  let missing = 0,
    firstMissing = null,
    contiguous = first - 1n;
  const gaps = [];
  for (let n = first; n <= last; n++) {
    if (!segments.has(n.toString())) {
      missing++;
      firstMissing ??= n.toString();
      if (gaps.length < 100) gaps.push(n.toString());
    } else if (firstMissing === null) contiguous = n;
  }
  let backlog = null,
    oldest = null;
  if (archiveStatusDirectory !== undefined) {
    const dir = checked(archiveStatusDirectory),
      iterator = fs.opendirSync(dir);
    backlog = 0;
    let n = 0;
    try {
      for (let d = iterator.readSync(); d; d = iterator.readSync()) {
        if (++n > 100000) throw new Error("Archiver status budget");
        if (!/^[A-F0-9]{24}\.ready$/.test(d.name)) continue;
        const s = fs.lstatSync(checked(path.join(dir, d.name)));
        if (!s.isFile() || s.nlink !== 1)
          throw new Error("Archiver status link refused");
        backlog++;
        oldest = oldest === null ? s.mtimeMs : Math.min(oldest, s.mtimeMs);
      }
    } finally {
      iterator.closeSync();
    }
  }
  if (timeline > 1 && fs.existsSync(path.join(r, t + ".history"))) {
    try {
      verifyFile(r, t + ".history");
      history = 1;
    } catch {
      invalid++;
    }
  }
  return {
    ok: missing === 0 && invalid === 0 && end !== null,
    kind: "wal_archive_health",
    timeline,
    system_identifier: binding.system_identifier,
    cluster_binding_operator_asserted: true,
    wal_header_identity_verified: false,
    verified_segments: segments.size,
    other_timeline_segments: other,
    missing_segments: missing,
    first_missing_segment_index: firstMissing,
    gaps,
    gaps_truncated: missing > gaps.length,
    invalid_members: invalid,
    continuous_segment_end_lsn_decimal: (
      (contiguous + 1n) *
      BigInt(binding.segment_bytes)
    ).toString(),
    expected_target_declared: end !== null,
    backlog_ready: backlog,
    oldest_backlog_age_ms:
      oldest === null ? null : Math.max(0, Date.now() - oldest),
    history_receipt_verified: history === 1,
    recoverable_until_time: null,
    replay_verified: false,
    production_rpo_guaranteed: false,
    wal_deletions_permitted: false,
    base_backup_must_be_retained: true,
  };
}
