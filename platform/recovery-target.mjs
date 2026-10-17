// Separate capabilities: a strict read-only repository Host and a new-target-only
// writer. No target operation is allowed on the read-only Host itself.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Host, safeRelative, publishDirectory } from "./adapter.mjs";
import { checked } from "./vault.mjs";

const canonical = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const contains = (a, b) =>
  canonical(a) === canonical(b) ||
  canonical(b).startsWith(canonical(a) + path.sep);
const syncDir = (dir) => {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};
const outputOps = new Set([
  "begin_restore",
  "restore_dir",
  "restore_open",
  "restore_write",
  "restore_close",
  "finish_restore",
]);
export class RecoverySession {
  constructor({ repository, target, environment = process.env }) {
    this.repository = checked(repository);
    this.target = checked(target, false);
    this.parent = checked(path.dirname(this.target));
    if (
      fs.existsSync(this.target) ||
      !fs.statSync(this.parent).isDirectory() ||
      contains(this.repository, this.target) ||
      contains(this.target, this.repository)
    )
      throw new Error("Recovery requires a new non-overlapping target");
    this.reader = new Host({
      environment: { ...environment, MOONRESTORE_READ_ONLY: "1" },
    });
    this.stage = null;
    this.file = null;
    this.files = [];
    this.total = 0n;
  }
  get bytes() {
    return this.reader.bytes;
  }
  execute(op, text, bytes) {
    if (!outputOps.has(op)) return this.reader.execute(op, text, bytes);
    try {
      return JSON.stringify({
        ok: true,
        value: this.write(op, JSON.parse(text), bytes),
      });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error.message });
    }
  }
  write(op, value, bytes) {
    this.reader.pulse("recovery_output");
    if (op === "begin_restore") {
      if (
        this.stage ||
        canonical(checked(value.target, false)) !== canonical(this.target) ||
        fs.existsSync(this.target)
      )
        throw new Error("Recovery target changed or already exists");
      this.stage = path.join(
        this.parent,
        `.moonrestore-${randomUUID()}.partial`,
      );
      fs.mkdirSync(this.stage, { mode: 0o700 });
      return { staging: this.stage };
    }
    if (!this.stage) throw new Error("Recovery target is not active");
    const member = (name) =>
      checked(path.join(this.stage, safeRelative(name)), false);
    if (op === "restore_dir") {
      fs.mkdirSync(member(value.path), { mode: 0o700 });
      return null;
    }
    if (op === "restore_open") {
      if (this.file || this.files.length >= 100000)
        throw new Error("Invalid recovery file state");
      const name = safeRelative(value.path);
      this.file = {
        name,
        fd: fs.openSync(member(name), "wx", 0o600),
        size: 0n,
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
        throw new Error("Recovery output budget");
      fs.writeFileSync(this.file.fd, bytes);
      this.file.digest.update(bytes);
      this.file.size += BigInt(bytes.length);
      this.total += BigInt(bytes.length);
      return null;
    }
    if (op === "restore_close") {
      if (!this.file) throw new Error("No recovery file open");
      fs.fsyncSync(this.file.fd);
      fs.closeSync(this.file.fd);
      this.files.push({
        name: this.file.name,
        size: this.file.size,
        hash: this.file.digest.digest("hex"),
      });
      this.file = null;
      return null;
    }
    if (op === "finish_restore") {
      if (this.file || fs.existsSync(this.target))
        throw new Error("Recovery target publication refused");
      const buffer = Buffer.alloc(65536);
      for (const file of this.files) {
        const name = member(file.name),
          stat = fs.lstatSync(name);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          BigInt(stat.size) !== file.size
        )
          throw new Error("Recovery readback metadata mismatch");
        const fd = fs.openSync(name, "r"),
          digest = createHash("sha256");
        try {
          let size;
          while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            this.reader.pulse("recovery_readback");
            digest.update(buffer.subarray(0, size));
          }
        } finally {
          fs.closeSync(fd);
        }
        if (digest.digest("hex") !== file.hash)
          throw new Error("Recovery readback hash mismatch");
      }
      checked(this.parent);
      syncDir(this.stage);
      publishDirectory(this.stage, this.target);
      syncDir(this.parent);
      this.stage = null;
      return {
        target: this.target,
        post_restore_readback: true,
        readback_files: this.files.length,
      };
    }
    throw new Error("Unknown recovery target operation");
  }
  clean() {
    if (this.file) {
      fs.closeSync(this.file.fd);
      this.file = null;
    }
    // Unpublished staging is retained for diagnosis, never recursively deleted.
    this.reader.clean();
  }
}
