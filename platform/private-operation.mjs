// Private authenticated state is not a backup. Losing it prevents continuation,
// never authorizes guessing at or overwriting an existing destination.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
} from "./vault.mjs";
import { operationId, atomicPrivate } from "./journal.mjs";
import { pagedBinding } from "./paged-cache.mjs";
export class PrivateOperation {
  constructor(store, id, { create = false } = {}) {
    this.store = store;
    this.id = operationId(id);
    this.binding = pagedBinding(store);
    this.folder = checked(
      path.join(mkdirPrivate(path.join(stateHome(), "paged-restores-v1")), id),
      false,
    );
    if (create) {
      fs.mkdirSync(this.folder, { mode: 0o700 });
      writePrivate(path.join(this.folder, "key"), randomBytes(32));
      fs.mkdirSync(path.join(this.folder, "receipts"), { mode: 0o700 });
    }
    this.key = readPrivate(path.join(this.folder, "key"), 32);
    if (this.key.length !== 32)
      throw new Error("Invalid restore authentication key");
  }
  file(name) {
    if (name !== "head" && !/^[df]-[0-9]{1,7}$/.test(name))
      throw new Error("Invalid receipt name");
    return path.join(
      this.folder,
      name === "head" ? "head.json" : "receipts/" + name + ".json",
    );
  }
  save(name, value) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length > 262000) throw new Error("Restore state budget");
    const digest = this.store.logical(plain),
      raw = this.store.encode("restore-" + this.id + "-" + name, digest, plain),
      mac = createHmac("sha256", this.key)
        .update(this.binding + "\n" + name)
        .update(raw)
        .digest("hex");
    atomicPrivate(
      this.file(name),
      Buffer.from(
        JSON.stringify({
          binding: this.binding,
          digest,
          mac,
          payload: raw.toString("base64"),
        }),
      ),
    );
  }
  read(name) {
    const r = JSON.parse(readPrivate(this.file(name), 350000)),
      raw = Buffer.from(r.payload ?? "", "base64"),
      expected = createHmac("sha256", this.key)
        .update(this.binding + "\n" + name)
        .update(raw)
        .digest(),
      given = Buffer.from(r.mac ?? "", "hex");
    if (
      r.binding !== this.binding ||
      !/^[a-f0-9]{64}$/.test(r.digest ?? "") ||
      given.length !== 32 ||
      !timingSafeEqual(given, expected) ||
      raw.toString("base64") !== r.payload
    )
      throw new Error("Restore state authentication failed");
    const plain = this.store.decode(
      "restore-" + this.id + "-" + name,
      r.digest,
      raw,
    );
    if (this.store.logical(plain) !== r.digest)
      throw new Error("Restore state digest mismatch");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain));
  }
  exists(name) {
    return fs.existsSync(this.file(name));
  }
  lease(recover) {
    const lock = path.join(this.folder, ".lock");
    if (fs.existsSync(lock)) {
      const owner = JSON.parse(
        readPrivate(path.join(checked(lock), "owner.json"), 1024),
      );
      if (
        !recover ||
        owner.id !== this.id ||
        owner.host !== os.hostname() ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      )
        throw new Error("Exact dead restore lease recovery required");
      let dead = false;
      try {
        process.kill(owner.pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") dead = true;
        else throw e;
      }
      if (!dead) throw new Error("Restore lease still active");
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    }
    fs.mkdirSync(lock, { mode: 0o700 });
    writePrivate(
      path.join(lock, "owner.json"),
      JSON.stringify({ id: this.id, host: os.hostname(), pid: process.pid }),
    );
    return () => {
      const r = JSON.parse(
        readPrivate(path.join(checked(lock), "owner.json"), 1024),
      );
      if (r.id !== this.id || r.pid !== process.pid)
        throw new Error("Restore lease changed");
      fs.unlinkSync(path.join(lock, "owner.json"));
      fs.rmdirSync(lock);
    };
  }
  close() {
    this.key.fill(0);
  }
}
