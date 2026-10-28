// File/object checkpoint journal. Resume re-reads source data and verifies every
// reusable object; it does not restore a private hash implementation's internals.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  randomUUID,
  randomBytes,
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
import { PagedStore, PagedIndex } from "./paged-store.mjs";
import { pagedBinding } from "./paged-cache.mjs";
import { backupPaged, verifyPaged } from "./paged-operations.mjs";
import { options } from "./maintenance.mjs";
import { checkpoint } from "./activity.mjs";
import { captureNative } from "./fidelity.mjs";
const stat = (s) => ({
  dev: String(s.dev),
  ino: String(s.ino),
  size: String(s.size),
  mtime: String(s.mtimeNs),
  ctime: String(s.ctimeNs),
  mode: String(s.mode),
});
export function sourceInventory(store, source, excludes = []) {
  const root = checked(source),
    session = randomUUID();
  let count = 0,
    files = 0,
    bytes = 0n;
  if (!fs.lstatSync(root).isDirectory())
    throw new Error("Directory inventory required");
  const skip = (r) => excludes.some((x) => r === x || r.startsWith(x + "/"));
  for (const x of excludes) store.core("path", { session: x });
  const relativeHome = path
    .relative(root, path.resolve(stateHome()))
    .split(path.sep)
    .join("/");
  if (
    (relativeHome === "" ||
      (!relativeHome.startsWith("../") && !path.isAbsolute(relativeHome))) &&
    !skip(relativeHome)
  )
    throw new Error("Private state inside source must be explicitly excluded");
  const index = new PagedIndex(store);
  index.db.exec(
    "CREATE TABLE inventory(k TEXT PRIMARY KEY,payload BLOB NOT NULL);",
  );
  const visit = (folder, prefix = "", depth = 0) => {
    if (depth > 64) throw new Error("Inventory depth budget");
    const before = fs.lstatSync(checked(folder), { bigint: true });
    if (!before.isDirectory()) throw new Error("Source directory changed");
    const k = index.key("inventory", prefix.toLowerCase()),
      value = {
        relative: prefix,
        stat: stat(before),
        ...(store.format === 5 ? { native: captureNative(folder) } : {}),
      };
    index.db
      .prepare("INSERT INTO inventory VALUES(?,?)")
      .run(k, index.encode("inventory", k, value));
    if (++count > 1000001) throw new Error("Source inventory entry budget");
    const dir = fs.opendirSync(folder);
    try {
      for (let d = dir.readSync(); d; d = dir.readSync()) {
        checkpoint("paged_source_inventory");
        const r = prefix ? prefix + "/" + d.name : d.name;
        if (skip(r)) continue;
        store.core("path", { session: r });
        const file = checked(path.join(folder, d.name)),
          s = fs.lstatSync(file, { bigint: true });
        if (s.isDirectory()) visit(file, r, depth + 1);
        else if (
          s.isFile() &&
          (s.nlink === 1n || (store.format === 5 && s.nlink > 1n))
        ) {
          if (
            ++count > 1000001 ||
            s.size > 68719476736n ||
            (bytes += s.size) > 1099511627776n
          )
            throw new Error("Source inventory entry/byte budget");
          files++;
          const key = index.key("inventory", r.toLowerCase());
          index.db
            .prepare("INSERT INTO inventory VALUES(?,?)")
            .run(
              key,
              index.encode("inventory", key, {
                relative: r,
                stat: stat(s),
                ...(store.format === 5 ? { native: captureNative(file) } : {}),
              }),
            );
        } else throw new Error("Source inventory links/special files refused");
      }
    } finally {
      dir.closeSync();
    }
    if (
      JSON.stringify(stat(before)) !==
      JSON.stringify(stat(fs.lstatSync(folder, { bigint: true })))
    )
      throw new Error("Source changed during inventory");
  };
  try {
    visit(root);
    store.core("hash-new", { session });
    for (const row of index.db
      .prepare("SELECT k,payload FROM inventory ORDER BY k")
      .iterate())
      store.core(
        "hash-push",
        { session },
        Buffer.from(
          JSON.stringify(index.decode("inventory", row.k, row.payload)) + "\n",
        ),
      );
    return {
      digest: store.core("hash-finish", { session }),
      entries:
        index.db.prepare("SELECT count(*) AS n FROM inventory").get().n - 1,
      files,
      logical_bytes: String(bytes),
    };
  } finally {
    store.core("close", { session });
    index.close();
  }
}
class PagedJournal {
  constructor(store, id, { create = false } = {}) {
    this.store = store;
    this.id = operationId(id);
    this.binding = pagedBinding(store);
    this.folder = checked(
      path.join(
        mkdirPrivate(path.join(stateHome(), "paged-operations-v1")),
        id,
      ),
      false,
    );
    if (create) {
      fs.mkdirSync(this.folder, { mode: 0o700 });
      writePrivate(path.join(this.folder, "integrity.key"), randomBytes(32));
      fs.mkdirSync(path.join(this.folder, "batches"), { mode: 0o700 });
    }
    this.key = readPrivate(path.join(this.folder, "integrity.key"), 32);
    if (this.key.length !== 32)
      throw new Error("Operation integrity key invalid");
  }
  file(kind) {
    if (kind === "control") return path.join(this.folder, "control.json");
    if (!/^batch-[0-9]{1,7}$/.test(kind)) throw new Error("Journal kind");
    return path.join(this.folder, "batches", kind + ".json");
  }
  encode(kind, value) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length > 262144) throw new Error("Checkpoint byte budget");
    const digest = this.store.logical(plain),
      purpose = "paged-operation-" + this.id + "-" + kind,
      raw = this.store.encode(purpose, digest, plain),
      mac = createHmac("sha256", this.key)
        .update(this.binding + "\n" + kind + "\n")
        .update(raw)
        .digest("hex");
    return Buffer.from(
      JSON.stringify({
        format: 1,
        binding: this.binding,
        digest,
        mac,
        payload: raw.toString("base64"),
      }),
    );
  }
  read(kind) {
    const r = JSON.parse(readPrivate(this.file(kind), 350000));
    if (
      r.format !== 1 ||
      r.binding !== this.binding ||
      !/^[a-f0-9]{64}$/.test(r.digest || "") ||
      typeof r.payload !== "string"
    )
      throw new Error("Journal binding invalid");
    const raw = Buffer.from(r.payload, "base64"),
      mac = createHmac("sha256", this.key)
        .update(this.binding + "\n" + kind + "\n")
        .update(raw)
        .digest(),
      given = Buffer.from(r.mac || "", "hex");
    if (
      raw.toString("base64") !== r.payload ||
      given.length !== 32 ||
      !timingSafeEqual(mac, given)
    )
      throw new Error("Journal authentication invalid");
    const bytes = this.store.decode(
      "paged-operation-" + this.id + "-" + kind,
      r.digest,
      raw,
    );
    if (this.store.logical(bytes) !== r.digest)
      throw new Error("Checkpoint digest invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  load() {
    const r = this.read("control");
    if (
      r.id !== this.id ||
      r.binding !== this.binding ||
      !["prepared", "running", "paused", "failed", "completed"].includes(
        r.phase,
      ) ||
      !Number.isInteger(r.batches) ||
      r.batches < 0 ||
      r.batches > 1000000
    )
      throw new Error("Invalid operation control");
    return r;
  }
  save(r) {
    if (pagedBinding(this.store) !== this.binding)
      throw new Error("Operation repository changed");
    atomicPrivate(this.file("control"), this.encode("control", r));
  }
  batch(r, records) {
    if (!records.length) return;
    const kind = "batch-" + r.batches,
      value = { sequence: r.batches, previous: r.chain, records },
      bytes = this.encode(kind, value),
      file = this.file(kind);
    if (fs.existsSync(file)) {
      const existing = this.read(kind);
      if (JSON.stringify(existing) !== JSON.stringify(value))
        fs.renameSync(
          file,
          path.join(
            this.folder,
            "batches",
            "orphan-" + kind + "-" + randomUUID() + ".json",
          ),
        );
    }
    if (!fs.existsSync(file)) writePrivate(file, bytes);
    r.chain = this.store.logical(Buffer.from(JSON.stringify(value)));
    r.batches++;
    r.checkpoint_chunks += records.length;
    this.save(r);
  }
  seed(r, index) {
    let previous = "";
    for (let n = 0; n < r.batches; n++) {
      const batch = this.read("batch-" + n);
      if (
        batch.sequence !== n ||
        batch.previous !== previous ||
        !Array.isArray(batch.records) ||
        batch.records.length > 128
      )
        throw new Error("Checkpoint chain invalid");
      for (const row of batch.records) {
        if (
          row.kind !== "chunk" ||
          row.path !== "" ||
          !Number.isInteger(row.offset) ||
          row.offset < 6 ||
          !/^\d{1,7}$/.test(row.size || "") ||
          Number(row.size) < 1 ||
          Number(row.size) > 1048576 ||
          !["id", "pack"].every((k) => /^[a-f0-9]{64}$/.test(row[k] || ""))
        )
          throw new Error("Checkpoint chunk invalid");
        index.put("objects", index.key("object", row.id), row);
      }
      previous = this.store.logical(Buffer.from(JSON.stringify(batch)));
    }
    if (previous !== r.chain) throw new Error("Checkpoint chain head mismatch");
  }
  close() {
    this.key.fill(0);
  }
}
function summary(r) {
  return {
    ok: r.phase === "completed",
    operation: r.id,
    state: r.phase,
    started: r.started,
    snapshot: r.snapshot ?? null,
    checkpoint_batches: r.batches,
    checkpoint_chunks: r.checkpoint_chunks,
    resume_mode: "authenticated_rescan_and_verified_object_reuse",
    post_commit_verified: r.verified === true,
    post_restore_readback: false,
    cleanup_blocked: r.cleanup_blocked ?? true,
    error_code: r.error_code ?? null,
  };
}
export async function createPagedOperation(
  repository,
  source,
  { label = "", excludes = [] } = {},
) {
  const store = await PagedStore.open(repository);
  let journal;
  try {
    if (
      typeof label !== "string" ||
      label.length > 200 ||
      !Array.isArray(excludes) ||
      excludes.length > 64 ||
      Buffer.byteLength(JSON.stringify(excludes)) > 8192
    )
      throw new Error("Invalid operation options");
    source = checked(source);
    const normalized = (v) =>
      process.platform === "win32" ? v.toLowerCase() : v;
    if (
      normalized(source) === normalized(store.repo) ||
      normalized(store.repo).startsWith(normalized(source) + path.sep) ||
      normalized(source).startsWith(normalized(store.repo) + path.sep)
    )
      throw new Error("Operation source overlaps repository");
    const id = randomUUID();
    journal = new PagedJournal(store, id, { create: true });
    const inventory = sourceInventory(store, source, excludes),
      s = fs.statSync(source, { bigint: true });
    const r = {
      format: 1,
      id,
      binding: journal.binding,
      source,
      source_identity: [s.dev, s.ino].map(String).join(":"),
      inventory: inventory.digest,
      label,
      excludes,
      started: new Date().toISOString(),
      phase: "prepared",
      batches: 0,
      checkpoint_chunks: 0,
      chain: "",
      snapshot: null,
      verified: false,
    };
    journal.save(r);
    return { ...summary(r), ok: true, prepared: true };
  } finally {
    journal?.close();
    store.close();
  }
}
function acquire(journal, recover) {
  const lock = path.join(journal.folder, ".lock");
  if (fs.existsSync(lock)) {
    const owner = JSON.parse(readPrivate(path.join(lock, "owner.json"), 512));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
      throw new Error("Invalid operation lease PID");
    let dead = false;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") dead = true;
      else throw e;
    }
    if (
      !recover ||
      !dead ||
      owner.host !== os.hostname() ||
      owner.id !== journal.id
    )
      throw new Error(
        "Operation lease active/foreign or exact recovery required",
      );
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  writePrivate(
    path.join(lock, "owner.json"),
    JSON.stringify({ id: journal.id, pid: process.pid, host: os.hostname() }),
  );
  return () => {
    fs.unlinkSync(checked(path.join(lock, "owner.json")));
    fs.rmdirSync(lock);
  };
}
export async function runPagedOperation(
  repository,
  id,
  { recover = false } = {},
) {
  const store = await PagedStore.open(repository),
    journal = new PagedJournal(store, id);
  let release, r;
  try {
    release = acquire(journal, recover);
    r = journal.load();
    if (r.phase === "completed") {
      await verifyPaged(repository, r.snapshot);
      return { ...summary(r), idempotent: true };
    }
    const lock = path.join(store.repo, ".lock");
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(
        readPrivate(path.join(lock, "owner.json"), 1024),
      );
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
        throw new Error("Invalid repository lease PID");
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") dead = true;
        else throw e;
      }
      if (
        !recover ||
        !dead ||
        owner.host !== os.hostname() ||
        owner.operation !== id ||
        owner.repository !== store.repoId
      )
        throw new Error("Repository writer is not the exact dead operation");
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
    if (
      r.pending_snapshot &&
      fs.existsSync(store.file("snapshot", r.pending_snapshot))
    ) {
      await verifyPaged(repository, r.pending_snapshot);
      r.snapshot = r.pending_snapshot;
      r.verified = true;
      r.phase = "completed";
      journal.save(r);
      return { ...summary(r), publication_reconciled: true };
    }
    const s = fs.statSync(checked(r.source), { bigint: true });
    if (
      [s.dev, s.ino].map(String).join(":") !== r.source_identity ||
      sourceInventory(store, r.source, r.excludes).digest !== r.inventory
    )
      throw new Error("Operation source changed; create a new operation");
    if (r.phase === "running" && recover) {
      if (!store.core("transition", { session: "running", previous: "paused" }))
        throw new Error("Invalid recovery transition");
      r.phase = "paused";
      journal.save(r);
    }
    if (!store.core("transition", { session: r.phase, previous: "running" }))
      throw new Error("Invalid operation transition");
    r.phase = "running";
    r.error_code = null;
    journal.save(r);
    const result = await backupPaged(repository, r.source, {
      label: r.label,
      excludes: r.excludes,
      operationId: id,
      startedAt: r.started,
      seed: (index) => journal.seed(r, index),
      onCheckpoint: (rows) => {
        journal.batch(r, rows);
        if (process.env.MOONRESTORE_TEST_CRASH === "paged-checkpoint")
          process.exit(86);
      },
      onRoot: (snapshot) => {
        r.pending_snapshot = snapshot;
        journal.save(r);
      },
    });
    r.snapshot = result.snapshot;
    r.phase = "completed";
    r.verified = true;
    r.history_audit = result.history_audit;
    r.cleanup_blocked = result.cleanup_blocked;
    journal.save(r);
    return { ...result, ...summary(r) };
  } catch (error) {
    if (r && r.phase !== "completed") {
      r.phase = "failed";
      r.error_code = "PAGED_OPERATION_FAILED";
      try {
        journal.save(r);
      } catch {}
    }
    throw error;
  } finally {
    try {
      release?.();
    } finally {
      journal.close();
      store.close();
    }
  }
}
export async function pagedOperationStatus(repository, id) {
  const store = await PagedStore.open(repository),
    journal = new PagedJournal(store, id);
  try {
    const r = journal.load();
    return { ...summary(r), ok: true, completed: r.phase === "completed" };
  } finally {
    journal.close();
    store.close();
  }
}
export async function pagedOperationCommand(args) {
  const [command, ...rest] = args;
  if (
    ![
      "paged-operation-create",
      "paged-operation-run",
      "paged-operation-status",
    ].includes(command)
  )
    return null;
  const { positionals: p, values: v } = options(
    rest,
    ["label", "exclude", "recover"],
    ["recover"],
  );
  if (command === "paged-operation-create" && p.length === 2 && !v.recover)
    return createPagedOperation(...p, {
      label: v.label ?? "",
      excludes: v.exclude ?? [],
    });
  if (
    command === "paged-operation-run" &&
    p.length === 2 &&
    Object.keys(v).every((k) => k === "recover")
  )
    return runPagedOperation(...p, { recover: !!v.recover });
  if (
    command === "paged-operation-status" &&
    p.length === 2 &&
    !Object.keys(v).length
  )
    return pagedOperationStatus(...p);
  throw new Error("Invalid paged operation arguments");
}
