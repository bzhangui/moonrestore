// Optional persistent retention protection. This is a local administrative guard,
// not an immutable backend or a defense against a compromised local account.
import fs from "node:fs";
import path from "node:path";
import { checked, mkdirPrivate, readPrivate, stateHome } from "./vault.mjs";
import { atomicPrivate, repositoryBinding } from "./journal.mjs";
import { openHost, hash, core, options } from "./maintenance.mjs";
import { credentials } from "./activity.mjs";
const id = (x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
function location(repository) {
  const root = checked(repository),
    normal = process.platform === "win32" ? root.toLowerCase() : root;
  return path.join(
    mkdirPrivate(path.join(stateHome(), "retention-protection-v1")),
    hash(normal) + ".json",
  );
}
function binding(repository) {
  const h = openHost(repository, {
    environment: {
      ...process.env,
      ...credentials(repository),
      MOONRESTORE_READ_ONLY: "1",
    },
  });
  try {
    return repositoryBinding(h);
  } finally {
    h.clean();
  }
}
function config(c) {
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    Object.keys(c).some((k) => !["minimumDays", "pins"].includes(k)) ||
    !Number.isSafeInteger(c.minimumDays) ||
    c.minimumDays < 1 ||
    c.minimumDays > 36500 ||
    !Array.isArray(c.pins) ||
    c.pins.length > 100 ||
    c.pins.some((p) => !id(p)) ||
    new Set(c.pins).size !== c.pins.length
  )
    throw new Error("Invalid recovery-point protection policy");
  return { minimumDays: c.minimumDays, pins: [...c.pins].sort() };
}
export function protectionStatus(repository, now = Date.now()) {
  const file = location(repository);
  if (!fs.existsSync(file))
    return { ok: true, configured: false, pins: [], minimumDays: 0 };
  const r = JSON.parse(readPrivate(file, 32768)),
    c = config(r.config);
  if (
    r.format !== 1 ||
    r.binding !== binding(repository) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(r.updated) ||
    r.updated < 0 ||
    now < r.updated
  )
    throw new Error("Protection identity/clock mismatch; cleaning refused");
  return {
    ok: true,
    configured: true,
    ...c,
    updated: r.updated,
    locally_enforced: true,
    immutable_backend_verified: false,
  };
}
export function protectionPreview(repository, input) {
  const c = config(input),
    file = location(repository),
    b = binding(repository),
    previous = fs.existsSync(file) ? hash(readPrivate(file, 32768)) : null;
  return {
    ok: true,
    preview: true,
    config: c,
    confirmation: hash(
      JSON.stringify({
        kind: "recovery_protection",
        binding: b,
        previous,
        config: c,
      }),
    ),
  };
}
export async function applyProtection(repository, input, confirmation) {
  const p = protectionPreview(repository, input);
  if (p.confirmation !== confirmation)
    throw new Error("Protection confirmation changed; preview again");
  const h = openHost(repository, {
    environment: { ...process.env, ...credentials(repository) },
  });
  try {
    h.lock();
    if (protectionPreview(repository, input).confirmation !== confirmation)
      throw new Error("Protection changed");
    for (const snapshot of p.config.pins)
      await core(["verify", repository, snapshot], {
        env: { MOONRESTORE_READ_ONLY: "1" },
      });
    atomicPrivate(
      location(repository),
      Buffer.from(
        JSON.stringify({
          format: 1,
          binding: repositoryBinding(h),
          config: p.config,
          updated: Date.now(),
        }),
      ),
    );
  } finally {
    h.clean();
  }
  return {
    ...protectionStatus(repository),
    pins_content_verified: true,
    business_correctness_proven: false,
  };
}
export function protectRetention(repository, snapshots, now = Date.now()) {
  const p = protectionStatus(repository, now),
    keep = new Set(p.pins);
  if (p.configured)
    for (const s of snapshots) {
      const created = Date.parse(s.model.created);
      if (!Number.isFinite(created) || created > now)
        throw new Error("Invalid recovery-point clock");
      if (now - created <= p.minimumDays * 86400000) keep.add(s.id);
    }
  for (const pin of p.pins)
    if (!snapshots.some((s) => s.id === pin))
      throw new Error("Pinned recovery point is missing; cleaning refused");
  return {
    pins: [...keep].sort(),
    policy: p.configured
      ? hash(readPrivate(location(repository), 32768))
      : null,
  };
}
export function protectionRevision(repository) {
  const p = protectionStatus(repository);
  return p.configured ? hash(readPrivate(location(repository), 32768)) : null;
}
export function assertPurgeProtection(repository, record, now = Date.now()) {
  const p = protectionStatus(repository, now);
  if (!p.configured) return;
  if (
    !Array.isArray(record.snapshots) ||
    record.snapshots.some((s) => !id(s)) ||
    record.snapshots.some((s) => p.pins.includes(s)) ||
    !Number.isFinite(Date.parse(record.created)) ||
    now - Date.parse(record.created) < p.minimumDays * 86400000
  )
    throw new Error(
      "Recovery-point policy blocks purge; restore and preview legacy quarantine first",
    );
}
export async function protectionCommand(args) {
  const [c, ...a] = args;
  if (
    !["protection-status", "protection-preview", "protection-apply"].includes(c)
  )
    return null;
  const { positionals: p, values: v } = options(a, ["confirm"]);
  if (c === "protection-status" && p.length === 1 && !Object.keys(v).length)
    return protectionStatus(p[0]);
  if (
    p.length === 2 &&
    (c === "protection-preview"
      ? !Object.keys(v).length
      : Object.keys(v).length === 1)
  ) {
    const input = JSON.parse(readPrivate(p[1], 32768));
    return c === "protection-preview"
      ? protectionPreview(p[0], input)
      : applyProtection(p[0], input, v.confirm);
  }
  throw new Error("Invalid protection command");
}
