// Durable orchestration. The MoonBit core still validates content, paths and state.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { Host, safeRelative } from "./adapter.mjs";
import { RecoverySession } from "./recovery-target.mjs";
import { Journal, atomicPrivate, operationId } from "./journal.mjs";
import { core, hash, options } from "./maintenance.mjs";
import { checked, readPrivate, stateHome } from "./vault.mjs";
import { credentials, activity } from "./activity.mjs";
const identity = (p) => {
  const s = fs.statSync(checked(p));
  return { dev: s.dev, ino: s.ino };
};
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const canonical = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const crash = (point) => {
  if (process.env.MOONRESTORE_TEST_CRASH === point) process.exit(86);
  if (process.env.MOONRESTORE_TEST_FAILURE === point)
    throw new Error("Injected operation failure: " + point);
};
const summary = (c) => ({
  ok: c.state === "completed",
  operation: c.id,
  kind: c.kind,
  state: c.state,
  started: c.started,
  snapshot: c.snapshot || c.pendingSnapshot || null,
  checkpoint_files: c.files || 0,
  checkpoint_chunks: c.partialChunks || 0,
  post_restore_readback: c.readback === true,
  error_code: c.errorCode || null,
});
async function transition(j, c, next) {
  if (!(await core(["operation-transition", c.state, next])).ok)
    throw new Error("Illegal operation transition");
  c.state = next;
  c.updated = new Date().toISOString();
  j.save(c);
}

export class DurableBackupHost extends Host {
  constructor(repository, id) {
    super();
    this.journal = new Journal(repository, id);
    try {
      this.control = this.journal.load();
      if (this.control.kind !== "backup" || this.control.state !== "running")
        throw new Error("Not an active backup");
      this.journal.acquire(false, { worker: true });
    } catch (e) {
      this.journal.close();
      throw e;
    }
  }
  lock() {
    super.lock();
    try {
      const file = this.repoPath(".lock/owner.json"),
        owner = JSON.parse(readPrivate(file, 1024));
      atomicPrivate(
        file,
        Buffer.from(JSON.stringify({ ...owner, operation: this.journal.id })),
      );
    } catch (e) {
      this.unlock();
      throw e;
    }
  }
  operation(op, a, bytes) {
    if (op === "clock") return this.control.started;
    if (op === "checkpoint_prepare") {
      this.requireLock();
      const source = checked(a.source);
      if (
        canonical(source) !== canonical(this.control.source) ||
        !same(identity(source), this.control.sourceIdentity)
      )
        throw new Error("Backup source identity changed");
      const inventory = [...this.sourceEntries].map(([name, { stat: s }]) => [
        name,
        s.dev,
        s.ino,
        s.size,
        s.mtimeMs,
        s.ctimeMs,
      ]);
      const config = JSON.stringify({
        parameters: a,
        inventory: hash(JSON.stringify(inventory)),
      });
      if (this.control.config && this.control.config !== config)
        throw new Error("Checkpoint parameters changed");
      this.control.config = config;
      this.journal.save(this.control);
      this.ready = true;
      return null;
    }
    if (op === "checkpoint_get" || op === "checkpoint_put") {
      this.requireLock();
      if (!this.ready) throw new Error("Checkpoint not prepared");
      if (op === "checkpoint_get")
        return this.journal.getFile(safeRelative(a.path));
      safeRelative(a.path);
      this.journal.putFile(a);
      this.control.files = (this.control.files || 0) + 1;
      this.journal.save(this.control);
      crash("checkpoint-file");
      return null;
    }
    if (op === "checkpoint_partial_get" || op === "checkpoint_partial_put") {
      this.requireLock();
      if (!this.ready) throw new Error("Checkpoint not prepared");
      safeRelative(a.path);
      if (op === "checkpoint_partial_get")
        return this.journal.getPartial(a.path);
      this.journal.putPartial(a);
      this.control.partialChunks = a.parts.length;
      this.journal.save(this.control);
      crash("checkpoint-chunks");
      return null;
    }
    if (op === "commit") {
      this.control.pendingSnapshot = a.id;
      this.journal.save(this.control);
      if (fs.existsSync(this.storagePath("manifest", a.id))) {
        if (
          hash(bytes) !== a.id ||
          !this.readStored("manifest", a.id).equals(Buffer.from(bytes))
        )
          throw new Error("Existing snapshot mismatch");
        return null;
      }
      const result = super.operation(op, a, bytes);
      crash("checkpoint-committed");
      return result;
    }
    return super.operation(op, a, bytes);
  }
  clean() {
    try {
      super.clean();
    } finally {
      this.journal?.close();
    }
  }
}

export class DurableRecoverySession extends RecoverySession {
  constructor(repository, id) {
    const journal = new Journal(repository, id);
    let control;
    try {
      control = journal.load();
      if (control.kind !== "restore" || control.state !== "running")
        throw new Error("Not an active restore");
      super({ repository, target: control.target });
    } catch (e) {
      journal.close();
      throw e;
    }
    this.journal = journal;
    this.control = control;
    try {
      this.journal.acquire(false, { worker: true });
    } catch (e) {
      super.clean();
      this.journal.close();
      throw e;
    }
  }
  write(op, value, bytes) {
    if (op === "begin_restore") {
      if (
        this.stage ||
        canonical(checked(value.target, false)) !== canonical(this.target) ||
        fs.existsSync(this.target)
      )
        throw new Error("Restore target changed");
      if (this.control.stage) {
        const stage = checked(this.control.stage);
        if (
          path.dirname(stage) !== this.parent ||
          !/^\.moonrestore-[a-f0-9-]+\.partial$/.test(path.basename(stage)) ||
          !same(identity(stage), this.control.stageIdentity)
        )
          throw new Error("Restore staging identity changed");
        this.stage = stage;
        return { staging: stage, resumed: true };
      }
      const result = super.write(op, value, bytes);
      this.control.stage = this.stage;
      this.control.stageIdentity = identity(this.stage);
      this.journal.save(this.control);
      return result;
    }
    if (op === "restore_dir" && this.stage) {
      const p = checked(path.join(this.stage, safeRelative(value.path)), false);
      if (fs.existsSync(p)) {
        if (!fs.statSync(p).isDirectory())
          throw new Error("Staging directory mismatch");
        this.directories.add(value.path);
        return null;
      }
    }
    if (op === "restore_open") {
      if (!this.stage || this.file)
        throw new Error("Invalid resumable file state");
      const name = safeRelative(value.path),
        p = checked(path.join(this.stage, name), false);
      if (!fs.existsSync(p)) return super.write(op, value, bytes);
      const fd = fs.openSync(
          p,
          fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0),
        ),
        s = fs.fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1) {
        fs.closeSync(fd);
        throw new Error("Invalid resumable prefix");
      }
      this.file = {
        name,
        fd,
        size: 0n,
        oldSize: s.size,
        digest: createHash("sha256"),
      };
      return null;
    }
    if (op === "restore_write") {
      if (
        !this.file ||
        bytes.length > 1048576 ||
        this.total + BigInt(bytes.length) > 1099511627776n
      )
        throw new Error("Restore budget");
      const offset = Number(this.file.size),
        prefix = Math.min(
          bytes.length,
          Math.max(0, (this.file.oldSize || 0) - offset),
        );
      if (prefix) {
        const old = Buffer.alloc(prefix);
        if (
          fs.readSync(this.file.fd, old, 0, prefix, offset) !== prefix ||
          !old.equals(Buffer.from(bytes).subarray(0, prefix))
        )
          throw new Error("Restore prefix differs; retained for diagnosis");
      }
      let written = prefix;
      while (written < bytes.length) {
        const n = fs.writeSync(
          this.file.fd,
          bytes,
          written,
          bytes.length - written,
          offset + written,
        );
        if (n <= 0) throw new Error("Short restore write");
        written += n;
      }
      this.file.digest.update(bytes);
      this.file.size += BigInt(bytes.length);
      this.total += BigInt(bytes.length);
      this.reader.pulse("resumable_output");
      fs.fsyncSync(this.file.fd);
      crash("checkpoint-prefix");
      return null;
    }
    if (
      op === "restore_close" &&
      this.file &&
      (this.file.oldSize || 0) > Number(this.file.size)
    )
      throw new Error("Unexpected extra restore prefix bytes");
    if (op === "finish_restore") {
      this.control.phase = "publishing";
      this.journal.save(this.control);
      const result = super.write(op, value, bytes);
      crash("checkpoint-published");
      this.control.readback = true;
      this.journal.save(this.control);
      return result;
    }
    return super.write(op, value, bytes);
  }
  clean() {
    try {
      super.clean();
    } finally {
      this.journal?.close();
    }
  }
}

// Publication may have succeeded just before interruption. Only an owned inode
// plus a complete independent catalog readback can resolve that uncertainty.
async function verifyPublished(c) {
  if (c.phase !== "publishing" || !same(identity(c.target), c.stageIdentity))
    throw new Error("Existing restore target is not this operation");
  const model = await core(["catalog", c.repository, c.snapshot], {
      env: { MOONRESTORE_READ_ONLY: "1" },
    }),
    expected = new Map(model.entries.map((e) => [e.path, e]));
  let count = 0;
  function walk(dir, prefix = "") {
    const it = fs.opendirSync(checked(dir));
    try {
      for (let d = it.readSync(); d; d = it.readSync()) {
        const rel = prefix ? prefix + "/" + d.name : d.name,
          p = checked(path.join(dir, d.name)),
          s = fs.lstatSync(p),
          entry = expected.get(rel);
        if (
          !entry ||
          s.isSymbolicLink() ||
          (entry.kind === "dir") !== s.isDirectory() ||
          (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))
        )
          throw new Error("Published restore tree mismatch");
        count++;
        if (s.isDirectory()) walk(p, rel);
        else {
          if (BigInt(s.size) !== BigInt(entry.size))
            throw new Error("Published restore size mismatch");
          const fd = fs.openSync(p, "r"),
            digest = createHash("sha256"),
            buffer = Buffer.alloc(65536);
          try {
            let n;
            while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
              digest.update(buffer.subarray(0, n));
          } finally {
            fs.closeSync(fd);
          }
          if (digest.digest("hex") !== entry.hash)
            throw new Error("Published restore hash mismatch");
        }
      }
    } finally {
      it.closeSync();
    }
  }
  walk(c.target);
  if (count !== expected.size) throw new Error("Incomplete published restore");
  c.readback = true;
}
export async function runOperation(repository, id, { recover = false } = {}) {
  const j = new Journal(repository, operationId(id));
  let c,
    started = false;
  try {
    j.acquire(recover);
    c = j.load();
    if (c.state === "completed") return summary(c);
    // A coordinator can die while its worker is still alive. Never start a
    // second writer merely because the parent lease is stale.
    j.clearStale("worker.lock", recover);
    if (c.state === "running") {
      if (!recover) throw new Error("Interrupted operation requires --recover");
      await transition(j, c, "failed");
    }
    const lock = path.join(j.host.repo, ".lock");
    if (c.kind === "backup" && fs.existsSync(lock)) {
      const owner = JSON.parse(
        readPrivate(path.join(checked(lock), "owner.json"), 1024),
      );
      if (!recover || owner.operation !== id || owner.host !== os.hostname())
        throw new Error("Unrelated repository lock; refusing recovery");
      await core(["recover", repository]);
    }
    await transition(j, c, "running");
    started = true;
    const env = { MOONRESTORE_OPERATION_ID: id, ...credentials(repository) };
    if (c.kind === "backup") {
      if (
        c.pendingSnapshot &&
        fs.existsSync(j.host.storagePath("manifest", c.pendingSnapshot))
      ) {
        await core(["verify", repository, c.pendingSnapshot]);
        c.snapshot = c.pendingSnapshot;
      } else {
        const result = await core(
          ["backup", repository, c.source, ...c.arguments],
          { env },
        );
        c = j.load();
        c.snapshot = result.snapshot;
        await core(["verify", repository, c.snapshot]);
      }
    } else {
      if (fs.existsSync(c.target)) await verifyPublished(c);
      else {
        await core(["restore", repository, c.snapshot, c.target], { env });
        c = j.load();
        if (c.readback !== true) throw new Error("Missing restore readback");
      }
    }
    await transition(j, c, "completed");
    return summary(c);
  } catch (e) {
    if (started && c && c.state === "running") {
      // Preserve the child's latest checkpoint, not a stale parent object.
      c = j.load();
      c.errorCode = activity()?.signal?.aborted
        ? "operation_cancelled"
        : "operation_failed";
      await transition(j, c, activity()?.signal?.aborted ? "paused" : "failed");
    }
    throw new Error("Operation " + id + " failed: " + e.message);
  } finally {
    j.close();
  }
}
export async function createOperation({
  repository,
  source,
  snapshot,
  target,
  arguments: args = [],
}) {
  repository = checked(repository);
  const id = randomUUID(),
    j = new Journal(repository, id, { create: true });
  try {
    const c = {
      id,
      binding: j.binding,
      repository,
      kind: source ? "backup" : "restore",
      state: "prepared",
      started: new Date().toISOString(),
      files: 0,
    };
    if (source) {
      c.source = checked(source);
      if (!fs.statSync(c.source).isDirectory())
        throw new Error("Directory required");
      c.sourceIdentity = identity(c.source);
      c.arguments = args;
    } else {
      if (typeof snapshot !== "string" || !/^[a-f0-9]{64}$/.test(snapshot))
        throw new Error("Invalid snapshot");
      c.snapshot = snapshot;
      c.target = checked(target, false);
      if (fs.existsSync(c.target))
        throw new Error("New restore target required");
    }
    j.save(c);
  } finally {
    j.close();
  }
  return id;
}
export function operationStatus(repository, id) {
  const j = new Journal(repository, id);
  try {
    return summary(j.load());
  } finally {
    j.close();
  }
}
export async function operationCommand(args) {
  const [command, ...rest] = args;
  if (command === "providers")
    return {
      ok: true,
      providers: (await import("./contracts.mjs")).providerCatalog(),
    };
  if (
    ![
      "backup-resumable",
      "restore-resumable",
      "operation-resume",
      "operation-status",
    ].includes(command)
  )
    return null;
  const { positionals: p, values: v } = options(
    rest,
    ["label", "exclude", "recover"],
    ["recover"],
  );
  if (command === "backup-resumable") {
    if (p.length !== 2 || v.recover)
      throw new Error(
        "Usage: backup-resumable REPO SOURCE [--label TEXT] [--exclude PATH]",
      );
    const a = [];
    if (v.label !== undefined) a.push("--label", v.label);
    for (const x of v.exclude || []) a.push("--exclude", x);
    const id = await createOperation({
      repository: p[0],
      source: p[1],
      arguments: a,
    });
    return runOperation(p[0], id);
  }
  if (command === "restore-resumable") {
    if (p.length !== 3 || Object.keys(v).length)
      throw new Error("Usage: restore-resumable REPO SNAPSHOT NEW_TARGET");
    const id = await createOperation({
      repository: p[0],
      snapshot: p[1],
      target: p[2],
    });
    return runOperation(p[0], id);
  }
  if (
    p.length !== 2 ||
    v.label ||
    v.exclude ||
    (command === "operation-status" && v.recover)
  )
    throw new Error("Usage: operation-resume/status REPO UUID [--recover]");
  return command === "operation-status"
    ? operationStatus(p[0], p[1])
    : runOperation(p[0], p[1], { recover: v.recover === true });
}
