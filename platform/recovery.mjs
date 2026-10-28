// Domain decisions stay in MoonBit. This layer binds previews, private evidence,
// independent donor I/O and strictly new-target-only recovery capabilities.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Host, publishDirectory } from "./adapter.mjs";
import {
  core,
  hash,
  options,
  openHost,
  fingerprint,
  saveReport,
} from "./maintenance.mjs";
import {
  checked,
  readPrivate,
  writePrivate,
  mkdirPrivate,
  stateHome,
} from "./vault.mjs";
import { checkpoint, credentials } from "./activity.mjs";
import { repositoryKind } from "./repository-kind.mjs";
import { runEngine } from "./engine-client.mjs";

const id = (s) => {
  if (typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s))
    throw new Error("Invalid snapshot ID");
  return s;
};
const canonical = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const overlap = (a, b) =>
  canonical(a) === canonical(b) ||
  canonical(a).startsWith(canonical(b) + path.sep) ||
  canonical(b).startsWith(canonical(a) + path.sep);
const readonly = (env = {}) => ({
  ...env,
  MOONRESTORE_READ_ONLY: "1",
  MOONRESTORE_RECOVERY_TARGET: "",
});
const integer = (n, min, max) => {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error("Invalid recovery budget");
  return n;
};
function outputPath(file, repo) {
  file = checked(file, false);
  if (overlap(file, checked(repo)) || fs.existsSync(file))
    throw new Error("New output must be outside repository");
  checked(path.dirname(file));
  let ancestor = path.dirname(file);
  while (path.dirname(ancestor) !== ancestor) {
    if (
      fs.existsSync(path.join(ancestor, ".git")) &&
      !canonical(file).startsWith(
        canonical(path.join(ancestor, ".local")) + path.sep,
      )
    )
      throw new Error(
        "Private recovery preparation must not be exported into public source files",
      );
    ancestor = path.dirname(ancestor);
  }
  return file;
}
function reportFiles(report, details = false) {
  const copy = structuredClone(report);
  if (!details) {
    for (const issue of copy.issues || []) delete issue.path;
    for (const result of copy.results || []) delete result.path;
    delete copy.target;
    delete copy.repository;
  }
  return saveReport(copy, { details });
}
function targetPlan(repo, target) {
  const source = checked(repo),
    destination = checked(target, false);
  if (
    overlap(source, destination) ||
    fs.existsSync(destination) ||
    !fs.statSync(checked(path.dirname(destination))).isDirectory()
  )
    throw new Error("Recovery requires a NEW non-overlapping destination");
  return destination;
}
export async function rescuePlan({
  repository,
  snapshot,
  target,
  selections = [],
  recoveryKeyFile,
}) {
  id(snapshot);
  if (
    !Array.isArray(selections) ||
    selections.length > 128 ||
    selections.some((x) => typeof x !== "string") ||
    (recoveryKeyFile !== undefined &&
      (typeof recoveryKeyFile !== "string" || !recoveryKeyFile))
  )
    throw new Error("Invalid recovery selection");
  target = targetPlan(repository, target);
  const env = readonly(
    recoveryKeyFile
      ? {
          MOONRESTORE_PASSWORD: "",
          MOONRESTORE_KEY_FILE: checked(recoveryKeyFile),
        }
      : {},
  );
  const before = fingerprint(repository);
  if (repositoryKind(repository).paged)
    return {
      ...(await runEngine(
        "restore-preview",
        { repository, snapshot, target, selections, partial: true },
        { env },
      )),
      source_read_only: true,
    };
  const result = await core(
    [
      "rescue-plan",
      repository,
      snapshot,
      ...selections.flatMap((s) => ["--prefix", s]),
    ],
    { env, allowFailure: true },
  );
  if (fingerprint(repository) !== before)
    throw new Error("Repository changed during rescue preview");
  return {
    ...result,
    target,
    source_read_only: true,
    confirmation: hash(
      JSON.stringify({
        repository: canonical(checked(repository)),
        snapshot,
        target,
        selections,
        before,
        result,
      }),
    ),
  };
}
export async function rescueToNewTarget(p) {
  if (typeof p.acceptPartial !== "boolean" || !p.acceptPartial)
    throw new Error("Explicit partial rescue acceptance required");
  if (repositoryKind(p.repository).paged) {
    const {
        repository,
        snapshot,
        target,
        selections = [],
        confirmation,
        recoveryKeyFile,
      } = p,
      env = recoveryKeyFile
        ? {
            MOONRESTORE_PASSWORD: "",
            MOONRESTORE_KEY_FILE: checked(recoveryKeyFile),
          }
        : {};
    const result = await runEngine(
      "restore",
      { repository, snapshot, target, selections, confirmation, partial: true },
      { env, allowFailure: true },
    );
    if (!result.post_restore_readback)
      throw new Error("Rescue readback not completed");
    return {
      ...result,
      source_read_only: true,
      real_cross_host_verified: false,
      files: reportFiles(result),
    };
  }
  const preview = await rescuePlan(p);
  if (
    typeof p.confirmation !== "string" ||
    p.confirmation !== preview.confirmation
  )
    throw new Error("Rescue preview changed or confirmation missing");
  const env = readonly(
    p.recoveryKeyFile
      ? {
          MOONRESTORE_PASSWORD: "",
          MOONRESTORE_KEY_FILE: checked(p.recoveryKeyFile),
        }
      : {},
  );
  env.MOONRESTORE_RECOVERY_TARGET = preview.target;
  const result = await core(
    [
      "rescue",
      p.repository,
      p.snapshot,
      preview.target,
      "--accept-partial",
      "true",
      ...(p.selections || []).flatMap((s) => ["--prefix", s]),
    ],
    { env, allowFailure: true },
  );
  if (!result.restored || !result.post_restore_readback)
    throw new Error("Recovery output was not independently read back");
  const report = {
    ...result,
    kind: "emergency_restore",
    source_read_only: true,
    evidence_time: new Date().toISOString(),
    data_only: true,
    real_cross_host_verified: false,
  };
  return { ...report, files: reportFiles(report), target: preview.target };
}
export async function recoveryChecklist(repository, output) {
  output = outputPath(output, repository);
  const listed = await core(["list", repository], { env: readonly() });
  if (!listed.snapshots.length || listed.snapshots.length > 5000)
    throw new Error("Checklist requires 1..5000 validated snapshots");
  const kind = repositoryKind(repository);
  const host = kind.paged
    ? null
    : openHost(repository, {
        environment: {
          ...process.env,
          ...credentials(repository),
          ...readonly(),
        },
      });
  let encrypted, profile, identity;
  try {
    encrypted = kind.paged ? kind.encrypted : !!host.key;
    profile = kind.paged ? "paged-v4" : host.profile;
    identity =
      host?.vault?.id ||
      hash(readPrivate(path.join(checked(repository), "moonrestore"), 128));
  } finally {
    host?.clean();
  }
  const record = {
    format: 1,
    tool: "MoonRestore",
    kind: "recovery_preparation",
    created: new Date().toISOString(),
    repository_identity: identity,
    encrypted,
    profile,
    snapshots: listed.snapshots.map((s) => ({ id: s.id, created: s.created })),
    contains_keys: false,
    contains_file_names: false,
    proof_of_recoverability: false,
    steps: [
      "保留兼容版本的独立运行包；不依赖旧任务和旧账号。",
      "恢复密钥与仓库、准备清单分开保管并验证。",
      "先用 emergency-preview 获取实际范围和确认摘要。",
      "emergency-restore 只读源仓库，写入全新目标并独立读回；部分恢复不报全量成功。",
      "确认恢复结果，再自行处理原始工作文件。原仓库和密钥不要公开。",
    ],
  };
  writePrivate(output, JSON.stringify(record, null, 2));
  return {
    ok: true,
    output,
    snapshots: record.snapshots.length,
    contains_keys: false,
    proof_of_recoverability: false,
  };
}

export async function rebuildCopy(
  repository,
  snapshot,
  donor,
  destination,
  { encrypted, destinationPassword } = {},
) {
  id(snapshot);
  const sources = [checked(repository), checked(donor)];
  destination = targetPlan(repository, destination);
  if (sources.some((s) => overlap(s, destination)))
    throw new Error("Rebuild overlaps a source");
  if (encrypted !== undefined && typeof encrypted !== "boolean")
    throw new Error("Invalid encrypted flag");
  if (
    destinationPassword !== undefined &&
    typeof destinationPassword !== "string"
  )
    throw new Error("Invalid destination password");
  const from = openHost(sources[0], {
    environment: { ...process.env, ...credentials(sources[0]), ...readonly() },
  });
  let second, target;
  let stage;
  try {
    const donorEnv = {
      ...process.env,
      ...credentials(sources[1]),
      ...readonly(),
      MOONRESTORE_PASSWORD:
        process.env.MOONRESTORE_DONOR_PASSWORD ||
        credentials(sources[1]).MOONRESTORE_PASSWORD ||
        "",
      MOONRESTORE_KEY_FILE:
        process.env.MOONRESTORE_DONOR_KEY_FILE ||
        credentials(sources[1]).MOONRESTORE_KEY_FILE ||
        "",
    };
    second = openHost(sources[1], { environment: donorEnv });
    // A damaged primary manifest may be supplied by the donor, but its logical
    // ID must still match the caller's pinned snapshot before any output write.
    let manifest,
      model,
      manifestFromDonor = false;
    for (const [index, source] of [from, second].entries()) {
      try {
        const candidate = source.readStored("manifest", snapshot);
        if (hash(candidate) !== snapshot) throw new Error();
        const validated = await core(["catalog", sources[index], snapshot], {
          env: index ? donorEnv : readonly(),
        });
        manifest = candidate;
        model = validated;
        manifestFromDonor = !!index;
        break;
      } catch {}
    }
    if (!manifest || !model)
      throw new Error("No verified source for the pinned snapshot manifest");
    const encrypt = encrypted ?? !!from.key;
    if (!encrypt && destinationPassword !== undefined)
      throw new Error(
        "Password supplied for a plaintext destination; explicitly request encryption",
      );
    if (from.key && !encrypt)
      throw new Error(
        "Encrypted source cannot silently downgrade to plaintext",
      );
    const destEnv = {
      ...process.env,
      MOONRESTORE_READ_ONLY: "0",
      MOONRESTORE_RECOVERY_TARGET: "",
      MOONRESTORE_INIT_ENCRYPTED: encrypt ? "1" : "0",
      MOONRESTORE_INIT_LARGE: model.format === 3 ? "1" : "0",
      MOONRESTORE_PASSWORD:
        destinationPassword ?? process.env.MOONRESTORE_DEST_PASSWORD ?? "",
      MOONRESTORE_KEY_FILE: "",
    };
    if (encrypt && !destEnv.MOONRESTORE_PASSWORD)
      throw new Error("New encrypted destination password required");
    stage = path.join(
      path.dirname(destination),
      `.moonrestore-${randomUUID()}.partial`,
    );
    target = new Host({ environment: destEnv });
    target.operation("init", { path: stage });
    target.operation("open", { path: stage });
    target.lock();
    const seen = new Map();
    let repaired = 0;
    for (const entry of model.entries)
      for (const part of entry.chunks) {
        checkpoint("rebuild", {
          checked_objects: seen.size,
          donor_objects: repaired,
        });
        if (seen.has(part.id)) {
          if (seen.get(part.id) !== part.size)
            throw new Error("Conflicting object sizes");
          continue;
        }
        let data;
        for (const [index, source] of [from, second].entries()) {
          try {
            const candidate = source.readStored("object", part.id);
            if (candidate.length !== part.size || hash(candidate) !== part.id)
              throw new Error();
            data = candidate;
            if (index) repaired++;
            break;
          } catch {}
        }
        if (!data)
          throw new Error(
            "No verified source for a required object; original repositories preserved",
          );
        const stored = target.store(part.id, data);
        if (!stored.created && hash(target.bytes) !== part.id)
          throw new Error("Rebuild destination mismatch");
        seen.set(part.id, part.size);
        await new Promise((resolve) => setImmediate(resolve));
      }
    if (hash(manifest) !== snapshot)
      throw new Error("Rebuild manifest changed");
    target.operation("commit", { id: snapshot }, manifest);
    target.clean();
    target = null;
    const audit = await core(["audit", stage, snapshot], {
      env: { ...destEnv, ...readonly() },
    });
    if (!audit.ok) throw new Error("Rebuild final full audit failed");
    publishDirectory(stage, destination);
    stage = null;
    const report = {
      ok: true,
      kind: "verified_rebuild",
      snapshot,
      scope: "one_snapshot",
      donor_objects: repaired,
      manifest_from_donor: manifestFromDonor,
      verified_objects: seen.size,
      encrypted: encrypt,
      original_repositories_modified: false,
      evidence_time: new Date().toISOString(),
      real_cross_host_verified: false,
    };
    return { ...report, destination, files: reportFiles(report) };
  } finally {
    from.clean();
    second?.clean();
    target?.clean();
    // Failed new staging stays private and unpublished for investigation.
  }
}

function evidenceLocation(repository) {
  return path.join(
    mkdirPrivate(path.join(stateHome(), "verification")),
    hash(canonical(checked(repository))) + ".json",
  );
}
function evidenceIdentity(repository) {
  const root = checked(repository),
    stat = fs.lstatSync(root);
  const parts = [
    canonical(root),
    String(stat.dev),
    String(stat.ino),
    readPrivate(path.join(root, "moonrestore"), 128).toString(),
  ];
  for (const name of ["repository-id", "encryption.json"]) {
    const member = path.join(root, name);
    if (fs.existsSync(member)) parts.push(hash(readPrivate(member, 4096)));
  }
  return hash(JSON.stringify(parts));
}
function loadEvidence(file, binding) {
  if (!fs.existsSync(file)) return { format: 1, binding, snapshots: {} };
  const value = JSON.parse(readPrivate(file, 8388608));
  if (
    value.format !== 1 ||
    !value.snapshots ||
    Array.isArray(value.snapshots) ||
    Object.keys(value.snapshots).length > 5000
  )
    throw new Error("Invalid verification state; preserve and inspect it");
  if (value.binding !== binding) return { format: 1, binding, snapshots: {} };
  for (const [key, s] of Object.entries(value.snapshots)) {
    id(key);
    if (
      !s ||
      typeof s !== "object" ||
      !Number.isSafeInteger(s.cursor) ||
      s.cursor < 0 ||
      !Number.isSafeInteger(s.failed) ||
      s.failed < 0 ||
      !Number.isSafeInteger(s.checked) ||
      s.checked < 0 ||
      s.failed > s.checked ||
      !Number.isFinite(Date.parse(s.started)) ||
      (s.last_error !== undefined &&
        !Number.isFinite(Date.parse(s.last_error))) ||
      (s.last &&
        (!Number.isSafeInteger(s.last.checked) ||
          s.last.checked < 0 ||
          !Number.isSafeInteger(s.last.failed) ||
          s.last.failed < 0 ||
          s.last.failed > s.last.checked ||
          !Number.isFinite(Date.parse(s.last.started)) ||
          !Number.isFinite(Date.parse(s.last.finished))))
    )
      throw new Error("Invalid verification evidence");
  }
  return value;
}
async function listedSnapshots(repository) {
  const result = await core(["list", repository], { env: readonly() });
  if (result.snapshots.length > 5000)
    throw new Error("Health evidence limit is 5000 snapshots");
  return result.snapshots;
}
export async function scrub(
  repository,
  { maxFiles = 100, maxBytes = "268435456", snapshot } = {},
) {
  if (repositoryKind(repository).paged)
    return runEngine(
      "scrub",
      { repository, maxFiles, maxBytes, ...(snapshot ? { snapshot } : {}) },
      { allowFailure: true },
    );
  integer(maxFiles, 1, 1000);
  if (
    typeof maxBytes !== "string" ||
    !/^[1-9][0-9]{0,12}$/.test(maxBytes) ||
    BigInt(maxBytes) > 1099511627776n
  )
    throw new Error("Invalid verification byte budget");
  if (snapshot) id(snapshot);
  const file = evidenceLocation(repository),
    lock = file + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const ids = await listedSnapshots(repository);
    if (!ids.length)
      return {
        ok: false,
        kind: "scrub",
        empty_repository: true,
        whole_repository_verified: false,
      };
    if (snapshot && !ids.some((s) => s.id === snapshot))
      throw new Error("Unknown scrub snapshot");
    const binding = evidenceIdentity(repository),
      state = loadEvidence(file, binding);
    const available = ids
      .filter((s) => !snapshot || s.id === snapshot)
      .sort(
        (a, b) =>
          (state.snapshots[a.id]?.last?.finished || "").localeCompare(
            state.snapshots[b.id]?.last?.finished || "",
          ) || a.id.localeCompare(b.id),
      );
    const chosen = available[0].id,
      record = state.snapshots[chosen] || {
        cursor: 0,
        failed: 0,
        checked: 0,
        started: new Date().toISOString(),
      };
    if (record.cursor === 0) {
      record.failed = 0;
      record.checked = 0;
      record.started = new Date().toISOString();
    }
    let result,
      completedCycle = null;
    try {
      result = await core(
        [
          "scrub-snapshot",
          repository,
          chosen,
          "--cursor",
          String(record.cursor),
          "--files",
          String(maxFiles),
          "--bytes",
          maxBytes,
        ],
        { env: readonly(), allowFailure: true },
      );
      record.failed += result.failed_files;
      record.checked += result.checked_files;
      record.cursor = result.next;
      record.last_error = result.failed_files
        ? new Date().toISOString()
        : record.last_error;
      if (result.next === result.total) {
        record.last = {
          started: record.started,
          finished: new Date().toISOString(),
          checked: record.checked,
          failed: record.failed,
        };
        record.cursor = 0;
        completedCycle = record.last;
        if (!record.failed) delete record.last_error;
      }
    } catch {
      record.last_error = new Date().toISOString();
      result = {
        ok: false,
        kind: "verification_batch",
        snapshot: chosen,
        error: "batch_unavailable_or_budget_refused",
        whole_repository_verified: false,
      };
    }
    state.snapshots[chosen] = record;
    if (evidenceIdentity(repository) !== binding)
      throw new Error("Repository identity changed during verification");
    const current = new Set(ids.map((s) => s.id));
    for (const key of Object.keys(state.snapshots))
      if (!current.has(key)) delete state.snapshots[key];
    const temp = file + "." + randomUUID() + ".tmp";
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > 8388608)
      throw new Error("Verification state budget");
    writePrivate(temp, encoded);
    fs.renameSync(temp, file);
    const safe = {
      ...result,
      results: undefined,
      evidence_time: new Date().toISOString(),
      source_read_only: true,
      completed_cycle: completedCycle,
    };
    return { ...safe, files: reportFiles(safe) };
  } finally {
    fs.rmdirSync(lock);
  }
}
export async function recoveryHealth(repository, { maxAgeHours = 168 } = {}) {
  if (repositoryKind(repository).paged)
    return runEngine(
      "scrub-status",
      { repository, maxAgeHours },
      { allowFailure: true },
    );
  integer(maxAgeHours, 1, 8760);
  const ids = await listedSnapshots(repository),
    state = loadEvidence(
      evidenceLocation(repository),
      evidenceIdentity(repository),
    ),
    now = Date.now();
  const snapshots = ids.map((s) => {
    const record = state.snapshots[s.id],
      last = record?.last;
    const finished = last && Date.parse(last.finished),
      started = last && Date.parse(last.started);
    const fresh =
      Number.isFinite(finished) &&
      Number.isFinite(started) &&
      finished <= now &&
      started <= finished &&
      now - started <= maxAgeHours * 3600000;
    return {
      snapshot: s.id,
      state:
        record?.last_error || last?.failed
          ? "failed"
          : !last
            ? "unknown"
            : fresh
              ? "verified_in_window"
              : "stale",
      last_cycle: last || null,
      next_cursor: record?.cursor || 0,
    };
  });
  return {
    ok:
      !!snapshots.length &&
      snapshots.every((s) => s.state === "verified_in_window"),
    kind: "recovery_health",
    evidence_time: new Date().toISOString(),
    max_age_hours: maxAgeHours,
    snapshots,
    empty_repository: !snapshots.length,
    guarantee_of_future_recovery: false,
    real_cross_host_verified: false,
  };
}

export async function recoveryCommand(args) {
  const command = args[0];
  if (
    ![
      "emergency-preview",
      "emergency-restore",
      "recovery-checklist",
      "rebuild-copy",
      "scrub",
      "health-status",
    ].includes(command)
  )
    return null;
  const { values: v, positionals: p } = options(
    args.slice(1),
    [
      "confirmation",
      "accept-partial",
      "key-file",
      "files",
      "bytes",
      "snapshot",
      "max-age-hours",
      "encrypted",
    ],
    ["accept-partial", "encrypted"],
  );
  const requireArgs = (n, allowed) => {
    if (p.length !== n || Object.keys(v).some((k) => !allowed.includes(k)))
      throw new Error("Invalid recovery command arguments");
  };
  if (command === "recovery-checklist") {
    requireArgs(2, []);
    return recoveryChecklist(...p);
  }
  if (command === "rebuild-copy") {
    requireArgs(4, ["encrypted"]);
    return rebuildCopy(...p, { encrypted: v.encrypted });
  }
  if (command === "scrub") {
    requireArgs(1, ["files", "bytes", "snapshot"]);
    return scrub(p[0], {
      maxFiles: v.files === undefined ? 100 : Number(v.files),
      maxBytes: v.bytes,
      snapshot: v.snapshot,
    });
  }
  if (command === "health-status") {
    requireArgs(1, ["max-age-hours"]);
    return recoveryHealth(p[0], {
      maxAgeHours:
        v["max-age-hours"] === undefined ? 168 : Number(v["max-age-hours"]),
    });
  }
  requireArgs(
    3,
    command === "emergency-preview"
      ? ["key-file"]
      : ["key-file", "accept-partial", "confirmation"],
  );
  const request = {
    repository: p[0],
    snapshot: p[1],
    target: p[2],
    recoveryKeyFile: v["key-file"],
    confirmation: v.confirmation,
    acceptPartial: v["accept-partial"] || false,
  };
  return command === "emergency-preview"
    ? rescuePlan(request)
    : rescueToNewTarget(request);
}
