// Destructive lifecycle is opt-in, bound to an authenticated private request,
// two confirmations, full fresh audits, replacement readback and >=7 days grace.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
} from "./vault.mjs";
import { atomicPrivate, operationId } from "./journal.mjs";
import {
  PagedStore,
  PagedIndex,
  indexSnapshot,
  bounded,
  newFile,
  syncDirectory,
} from "./paged-store.mjs";
import { pagedBinding } from "./paged-cache.mjs";
import { listPlans, assertCleanupGuard } from "./plans.mjs";
import { protectRetention } from "./recovery-policy.mjs";
import { drill } from "./maintenance.mjs";
class Control {
  constructor(store) {
    this.store = store;
    this.binding = pagedBinding(store);
    this.folder = mkdirPrivate(
      path.join(stateHome(), "paged-retirement-v1", this.binding),
    );
    const file = path.join(this.folder, "integrity.key");
    if (!fs.existsSync(file)) writePrivate(file, randomBytes(32));
    this.key = readPrivate(file, 32);
    if (this.key.length !== 32) throw new Error("Invalid retirement key");
  }
  file(id) {
    return path.join(this.folder, operationId(id) + ".json");
  }
  save(id, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 262000) throw new Error("Retirement request budget");
    const digest = this.store.logical(bytes),
      raw = this.store.encode("retirement", digest, bytes),
      mac = createHmac("sha256", this.key)
        .update(this.binding)
        .update(raw)
        .digest("hex");
    atomicPrivate(
      this.file(id),
      Buffer.from(
        JSON.stringify({ digest, mac, payload: raw.toString("base64") }),
      ),
    );
  }
  read(id) {
    const r = JSON.parse(readPrivate(this.file(id), 350000)),
      raw = Buffer.from(r.payload ?? "", "base64"),
      given = Buffer.from(r.mac ?? "", "hex"),
      expected = createHmac("sha256", this.key)
        .update(this.binding)
        .update(raw)
        .digest();
    if (
      !/^[a-f0-9]{64}$/.test(r.digest ?? "") ||
      given.length !== 32 ||
      !timingSafeEqual(given, expected) ||
      raw.toString("base64") !== r.payload
    )
      throw new Error("Retirement authentication failed");
    const bytes = this.store.decode("retirement", r.digest, raw);
    if (this.store.logical(bytes) !== r.digest)
      throw new Error("Retirement digest failed");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  close() {
    this.key.fill(0);
  }
}
function config(c) {
  if (
    !c ||
    Object.keys(c).some(
      (k) =>
        ![
          "keepLast",
          "minimumDays",
          "pins",
          "graceDays",
          "acknowledgeLocalOnly",
        ].includes(k),
    ) ||
    !Number.isSafeInteger(c.keepLast) ||
    c.keepLast < 1 ||
    c.keepLast > 1000 ||
    !Number.isSafeInteger(c.minimumDays ?? 7) ||
    (c.minimumDays ?? 7) < 1 ||
    (c.minimumDays ?? 7) > 36500 ||
    !Number.isSafeInteger(c.graceDays ?? 7) ||
    (c.graceDays ?? 7) < 7 ||
    (c.graceDays ?? 7) > 365 ||
    !Array.isArray(c.pins ?? []) ||
    (c.pins ?? []).length > 100 ||
    (c.pins ?? []).some((x) => !/^[a-f0-9]{64}$/.test(x)) ||
    c.acknowledgeLocalOnly !== true
  )
    throw new Error(
      "Bounded retention and explicit local-only risk acknowledgement required",
    );
  return {
    keepLast: c.keepLast,
    minimumDays: c.minimumDays ?? 7,
    pins: [...new Set(c.pins ?? [])].sort(),
    graceDays: c.graceDays ?? 7,
    acknowledgeLocalOnly: true,
  };
}
function snapshotState(store, index, c, now) {
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid retirement clock");
  assertCleanupGuard(store.repo, now);
  const roots = [],
    pins = new Set(c.pins);
  for (const id of store.snapshots()) {
    if (roots.length >= 1000) throw new Error("Retirement root budget 1000");
    const root = indexSnapshot(store, index, id);
    if (Date.parse(root.created) > now) throw new Error("Future snapshot time");
    roots.push({
      id,
      model: root,
      raw: store.logical(bounded(store.file("snapshot", id), 65600)),
    });
    if (now - Date.parse(root.created) <= c.minimumDays * 86400000)
      pins.add(id);
  }
  const protection = protectRetention(store.repo, roots, now);
  for (const id of protection.pins) pins.add(id);
  for (const p of listPlans(now).plans ?? []) {
    if (p.unavailable)
      throw new Error(
        "Unavailable plan prevents proving retention dependencies",
      );
    const canonical = (v) =>
      process.platform === "win32"
        ? path.resolve(v).toLowerCase()
        : path.resolve(v);
    if (canonical(p.config.repository) === canonical(store.repo)) {
      if (p.running || p.activeOperation)
        throw new Error("Active plan prevents retirement");
      for (const evidence of Object.values(p.evidence ?? {}))
        if (evidence?.snapshot) pins.add(evidence.snapshot);
    }
  }
  const records = roots.map((r) => ({ id: r.id, created: r.model.created })),
    keep = store.core("retention", {
      session: JSON.stringify({
        records,
        keep_last: c.keepLast,
        protected_ids: [...pins],
      }),
    });
  roots.sort((a, b) => a.id.localeCompare(b.id));
  const candidates = roots.filter((r) => !keep.includes(r.id)),
    replacement = roots
      .filter((r) => keep.includes(r.id))
      .sort(
        (a, b) =>
          b.model.created.localeCompare(a.model.created) ||
          a.id.localeCompare(b.id),
      )[0]?.id;
  return {
    roots,
    candidates,
    replacement,
    revision: store.logical(
      Buffer.from(
        JSON.stringify({
          roots: roots.map((r) => ({ id: r.id, raw: r.raw })),
          config: c,
          protection: protection.policy,
          pins: [...pins].sort(),
        }),
      ),
    ),
  };
}
export async function retirementPreview(
  repository,
  input,
  { now = Date.now() } = {},
) {
  const c = config(input),
    store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  try {
    const s = snapshotState(store, index, c, now);
    return {
      ok: true,
      kind: "paged_retirement_preview",
      candidate_snapshots: s.candidates.map((r) => r.id),
      replacement: s.replacement,
      minimum_grace_days: c.graceDays,
      confirmation: s.revision,
      roots_remain_live: true,
      config: c,
      independent_copy_verified: false,
    };
  } finally {
    index.close();
    store.close();
  }
}
export async function requestRetirement(
  repository,
  input,
  confirmation,
  { now = Date.now(), uptimeSeconds = os.uptime() } = {},
) {
  if (
    !Number.isSafeInteger(Math.floor(uptimeSeconds * 1000)) ||
    uptimeSeconds < 0
  )
    throw new Error("Invalid monotonic retirement clock");
  const c = config(input),
    store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  let control;
  try {
    store.lock();
    const s = snapshotState(store, index, c, now);
    if (confirmation !== s.revision || !s.replacement || !s.candidates.length)
      throw new Error("Retirement preview changed or no eligible roots");
    control = new Control(store);
    const id = randomUUID();
    control.save(id, {
      format: 1,
      id,
      binding: control.binding,
      config: c,
      requested: now,
      requestedUptime: Math.floor(uptimeSeconds * 1000),
      state: "requested",
      replacement: s.replacement,
      candidates: s.candidates.map((r) => ({ id: r.id, raw: r.raw })),
      completed: [],
      rootInventory: s.roots.map((r) => ({ id: r.id, raw: r.raw })),
      revision: s.revision,
    });
    return {
      ok: true,
      request: id,
      state: "requested",
      roots_remain_live: true,
      earliest_finalize: new Date(now + c.graceDays * 86400000).toISOString(),
      confirmation: store.logical(
        Buffer.from(id + "\n" + s.revision + "\nfinalize"),
      ),
      permanently_deleted: 0,
    };
  } finally {
    control?.close();
    index.close();
    store.close();
  }
}
export async function finalizeRetirement(
  repository,
  id,
  confirmation,
  { now = Date.now(), uptimeSeconds = os.uptime() } = {},
) {
  if (
    !Number.isSafeInteger(Math.floor(uptimeSeconds * 1000)) ||
    uptimeSeconds < 0
  )
    throw new Error("Invalid monotonic retirement clock");
  const store = await PagedStore.open(repository),
    index = new PagedIndex(store);
  let control;
  try {
    store.lock();
    control = new Control(store);
    const r = control.read(id);
    if (
      r.binding !== control.binding ||
      r.id !== id ||
      !["requested", "finalizing", "completed"].includes(r.state) ||
      !store.core("retirement-clock", {
        session: JSON.stringify({
          requested: String(r.requested),
          current: String(now),
          old_uptime: String(r.requestedUptime),
          uptime: String(Math.floor(uptimeSeconds * 1000)),
          grace_days: r.config.graceDays,
        }),
      })
    )
      throw new Error("Retirement grace/identity/state not verified");
    if (
      confirmation !==
      store.logical(Buffer.from(id + "\n" + r.revision + "\nfinalize"))
    )
      throw new Error("Second retirement confirmation required");
    if (r.state === "completed")
      return {
        ok: true,
        idempotent: true,
        permanently_deleted: r.completed.length,
      };
    assertCleanupGuard(store.repo, now);
    const current = [];
    for (const snap of store.snapshots()) {
      if (current.length >= 1000) throw new Error("Root budget");
      const root = indexSnapshot(store, index, snap);
      current.push({
        id: snap,
        model: root,
        raw: store.logical(bounded(store.file("snapshot", snap), 65600)),
      });
    }
    const old = r.rootInventory
        .filter((v) => !r.completed.includes(v.id))
        .sort((a, b) => a.id.localeCompare(b.id)),
      present = new Map(current.map(({ id, raw }) => [id, raw]));
    if (old.some((v) => present.get(v.id) !== v.raw))
      throw new Error("An original root changed since retirement request");
    // New independently audited roots are welcome during the grace period.
    // They never broaden the original, explicitly confirmed deletion set.
    // Re-evaluate current protections (including newly added pins and plan dependencies).
    const state = snapshotState(store, index, r.config, now),
      eligible = new Set(state.candidates.map((v) => v.id));
    if (
      r.candidates.some(
        (v) => !r.completed.includes(v.id) && !eligible.has(v.id),
      )
    )
      throw new Error("Protection changed; retirement refused");
    const proof = await drill(repository, r.replacement);
    if (!proof.ok || !proof.post_restore_readback)
      throw new Error("Replacement recovery drill required");
    r.state = "finalizing";
    control.save(id, r);
    for (const candidate of r.candidates) {
      if (r.completed.includes(candidate.id)) continue;
      const file = store.file("snapshot", candidate.id),
        raw = bounded(file, 65600);
      if (store.logical(raw) !== candidate.raw)
        throw new Error("Retirement root changed");
      // Preserve exact root bytes privately before explicit permanent root removal.
      const saved = path.join(
        control.folder,
        id + "-" + path.basename(file) + ".root",
      );
      if (!fs.existsSync(saved)) newFile(saved, raw);
      else if (store.logical(bounded(saved, 65600)) !== candidate.raw)
        throw new Error("Retirement recovery root conflict");
      // Intent persisted first; on uncertain interruption, missing root requires manual inspection, never automatic guesswork.
      r.pending = candidate.id;
      control.save(id, r);
      store.fail("retirement-before-unlink");
      fs.unlinkSync(file);
      syncDirectory(path.dirname(file));
      r.completed.push(candidate.id);
      r.pending = null;
      control.save(id, r);
    }
    r.state = "completed";
    control.save(id, r);
    return {
      ok: true,
      request: id,
      permanently_deleted: r.completed.length,
      replacement_drill: true,
      objects_deleted: 0,
      object_gc_separate: true,
      private_root_receipts_preserved: true,
    };
  } finally {
    control?.close();
    index.close();
    store.close();
  }
}
