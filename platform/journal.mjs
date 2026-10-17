import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { openHost, hash } from "./maintenance.mjs";
import {
  checked,
  readPrivate,
  writePrivate,
  mkdirPrivate,
  stateHome,
  seal,
  unseal,
  storageId,
} from "./vault.mjs";
import { credentials } from "./activity.mjs";
export const operationId = (id) => {
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      id,
    )
  )
    throw new Error("Invalid operation ID");
  return id;
};
export function atomicPrivate(file, bytes) {
  checked(path.dirname(file));
  const temp = file + "." + randomUUID() + ".tmp";
  writePrivate(temp, bytes);
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    const fd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
}
export function repositoryBinding(host) {
  const s = fs.statSync(host.repo),
    identity = fs.existsSync(path.join(host.repo, "repository-id"))
      ? readPrivate(path.join(host.repo, "repository-id"), 128)
      : Buffer.alloc(0);
  return hash(
    JSON.stringify({
      root: process.platform === "win32" ? host.repo.toLowerCase() : host.repo,
      dev: s.dev,
      ino: s.ino,
      identity: identity.toString("hex"),
      magic: readPrivate(path.join(host.repo, "moonrestore"), 128).toString(),
      vault: host.vault?.id,
      check: host.vault?.check,
    }),
  );
}
export class Journal {
  constructor(
    repository,
    id,
    { create = false, environment = process.env } = {},
  ) {
    this.host = openHost(checked(repository), {
      environment: {
        ...environment,
        ...credentials(repository),
        MOONRESTORE_READ_ONLY: "1",
      },
    });
    try {
      this.binding = repositoryBinding(this.host);
      this.id = operationId(id);
      this.parent = mkdirPrivate(path.join(stateHome(), "operations"));
      this.root = checked(path.join(this.parent, this.id), false);
      if (create) {
        fs.mkdirSync(this.root, { mode: 0o700 });
        fs.mkdirSync(path.join(this.root, "files"), { mode: 0o700 });
      }
      checked(this.root);
      this.controlFile = path.join(this.root, "control.json");
    } catch (e) {
      this.host.clean();
      throw e;
    }
  }
  encode(kind, value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 33554432) throw new Error("Journal budget");
    const digest = hash(bytes),
      purpose = "operation-" + this.id + "-" + kind;
    return Buffer.from(
      JSON.stringify({
        format: 1,
        binding: this.binding,
        encrypted: !!this.host.key,
        digest: this.host.key ? null : digest,
        physical: storageId(this.host.key, purpose, digest),
        payload: (this.host.key
          ? seal(this.host.key, this.host.vault, purpose, digest, bytes)
          : bytes
        ).toString("base64"),
      }),
    );
  }
  read(kind, file) {
    const record = JSON.parse(readPrivate(file, 44742000));
    if (
      record.format !== 1 ||
      record.binding !== this.binding ||
      record.encrypted !== !!this.host.key ||
      (this.host.key
        ? record.digest !== null
        : typeof record.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(record.digest)) ||
      typeof record.physical !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.physical) ||
      typeof record.payload !== "string" ||
      record.payload.length > 44740000
    )
      throw new Error("Journal identity or envelope mismatch");
    let bytes = Buffer.from(record.payload, "base64");
    if (bytes.toString("base64") !== record.payload)
      throw new Error("Journal encoding");
    const purpose = "operation-" + this.id + "-" + kind;
    let digest = record.digest;
    if (this.host.key) {
      const opened = unseal(
        this.host.key,
        this.host.vault,
        purpose,
        record.physical,
        bytes,
      );
      bytes = opened.bytes;
      digest = opened.id;
    }
    if (
      bytes.length > 33554432 ||
      hash(bytes) !== digest ||
      storageId(this.host.key, purpose, digest) !== record.physical
    )
      throw new Error("Journal integrity mismatch");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  load() {
    const c = this.read("control", this.controlFile);
    if (
      c.id !== this.id ||
      c.binding !== this.binding ||
      !["backup", "restore"].includes(c.kind) ||
      !["prepared", "running", "paused", "failed", "completed"].includes(
        c.state,
      )
    )
      throw new Error("Invalid operation state");
    return c;
  }
  save(c) {
    if (repositoryBinding(this.host) !== this.binding)
      throw new Error("Repository identity changed");
    atomicPrivate(this.controlFile, this.encode("control", c));
  }
  filePath(relative) {
    return path.join(
      this.root,
      "files",
      storageId(
        this.host.key,
        "operation-" + this.id + "-path",
        hash(relative),
      ) + ".json",
    );
  }
  getFile(relative) {
    const file = this.filePath(relative);
    if (!fs.existsSync(file)) return null;
    return this.read("file-" + hash(relative), file);
  }
  putFile(entry) {
    const file = this.filePath(entry.path);
    atomicPrivate(file, this.encode("file-" + hash(entry.path), entry));
  }
  clearStale(name, recover = false) {
    if (!["run.lock", "worker.lock"].includes(name))
      throw new Error("Unknown lease");
    const lock = path.join(this.root, name);
    if (fs.existsSync(lock)) {
      if (!recover)
        throw new Error(
          "Operation locked; explicit --recover is required after its owner stops",
        );
      const owner = JSON.parse(
        readPrivate(path.join(checked(lock), "owner.json"), 1024),
      );
      if (
        owner.host !== os.hostname() ||
        !Number.isInteger(owner.pid) ||
        owner.pid <= 0 ||
        owner.operation !== this.id
      )
        throw new Error("Foreign or invalid operation lock");
      try {
        process.kill(owner.pid, 0);
        throw new Error("Operation owner is still running");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
  }
  acquire(recover = false, { worker = false } = {}) {
    const name = worker ? "worker.lock" : "run.lock",
      lock = path.join(this.root, name);
    this.clearStale(name, recover);
    fs.mkdirSync(lock, { mode: 0o700 });
    writePrivate(
      path.join(lock, "owner.json"),
      JSON.stringify({
        host: os.hostname(),
        pid: process.pid,
        operation: this.id,
      }),
    );
    this.lock = lock;
  }
  close() {
    try {
      if (this.lock) {
        const owner = JSON.parse(
          readPrivate(path.join(checked(this.lock), "owner.json"), 1024),
        );
        if (owner.pid !== process.pid || owner.operation !== this.id)
          throw new Error("Operation lease changed");
        fs.unlinkSync(path.join(this.lock, "owner.json"));
        fs.rmdirSync(this.lock);
        this.lock = null;
      }
    } finally {
      this.host.clean();
    }
  }
}
