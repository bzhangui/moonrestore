// Separate-process append-only transport. OS-account and TLS administration remain external.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { checked, readPrivate, writePrivate } from "./vault.mjs";
import { syncDirectory } from "./paged-store.mjs";
import { pushPaged, restorePagedRemote } from "./paged-remote.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const scope = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const token = (v) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(v))
    throw new Error(
      "Receiver token must be 32..256 URL-safe characters, supplied privately",
    );
  return v;
};
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MAX = 8388704;
export function initObjectReceiver(
  directory,
  namespace,
  { maxBytes = 1073741824, maxObjects = 100000 } = {},
) {
  if (
    !scope(namespace) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 2199023255552 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 524288
  )
    throw new Error("Invalid receiver scope/quota");
  const root = checked(directory, false);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(path.join(root, "objects"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "pending"), { mode: 0o700 });
  writePrivate(
    path.join(root, "receiver.json"),
    JSON.stringify({
      format: 1,
      id: randomUUID(),
      namespace,
      maxBytes,
      maxObjects,
    }),
  );
  syncDirectory(root);
  return { ok: true, initialized: true, namespace, credentials_saved: false };
}
function frame(key, bytes) {
  const header = Buffer.from(
      JSON.stringify({
        format: 1,
        key,
        checksum: sha(bytes),
        size: bytes.length,
      }),
    ),
    n = Buffer.alloc(4);
  n.writeUInt32BE(header.length);
  return Buffer.concat([n, header, bytes]);
}
function unframe(file, key) {
  const raw = readPrivate(file, MAX + 512);
  if (raw.length < 4) throw new Error("Corrupt receiver object");
  const n = raw.readUInt32BE();
  if (n < 1 || n > 508 || n + 4 > raw.length)
    throw new Error("Corrupt receiver frame");
  const h = JSON.parse(raw.subarray(4, 4 + n).toString("utf8")),
    bytes = raw.subarray(4 + n);
  if (
    h.format !== 1 ||
    h.key !== key ||
    !digest(h.checksum) ||
    h.size !== bytes.length ||
    bytes.length > MAX ||
    sha(bytes) !== h.checksum
  )
    throw new Error("Corrupt receiver object");
  return {
    bytes,
    checksum: h.checksum,
    size: String(bytes.length),
    version: "sha256:" + h.checksum,
  };
}
export async function startObjectReceiver({
  directory,
  writerToken,
  adminToken,
  host = "127.0.0.1",
  port = 0,
  tls,
  recover = false,
} = {}) {
  token(writerToken);
  token(adminToken);
  if (equal(writerToken, adminToken))
    throw new Error("Distinct writer/admin tokens required");
  if (
    !["127.0.0.1", "::1", "0.0.0.0"].includes(host) ||
    (host === "0.0.0.0" && !tls) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("Explicit host/port; non-loopback requires TLS");
  const root = checked(directory),
    c = JSON.parse(readPrivate(path.join(root, "receiver.json"), 2048));
  if (
    c.format !== 1 ||
    !scope(c.namespace) ||
    typeof c.id !== "string" ||
    !Number.isSafeInteger(c.maxBytes) ||
    c.maxBytes < 1024 ||
    c.maxBytes > 2199023255552 ||
    !Number.isInteger(c.maxObjects) ||
    c.maxObjects < 1 ||
    c.maxObjects > 524288
  )
    throw new Error("Invalid receiver configuration");
  const objects = checked(path.join(root, "objects")),
    pending = checked(path.join(root, "pending")),
    lock = path.join(root, "receiver.lock");
  if (fs.existsSync(lock) && recover) {
    const owner = JSON.parse(readPrivate(path.join(lock, "owner.json"), 512));
    if (
      owner.id !== c.id ||
      owner.host !== os.hostname() ||
      !Number.isInteger(owner.pid) ||
      owner.pid < 1
    )
      throw new Error("Unknown receiver lock");
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive) throw new Error("Receiver still active");
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
  }
  fs.mkdirSync(lock, { mode: 0o700 });
  writePrivate(
    path.join(lock, "owner.json"),
    JSON.stringify({ id: c.id, host: os.hostname(), pid: process.pid }),
  );
  let count = 0,
    used = 0,
    active = 0,
    closed = false,
    server;
  const unlock = () => {
    if (closed) return;
    closed = true;
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
    syncDirectory(root);
  };
  try {
    for (const name of fs.readdirSync(objects)) {
      if (!digest(name)) throw new Error("Unknown receiver object path");
      const file = checked(path.join(objects, name)),
        s = fs.lstatSync(file);
      if (!s.isFile() || s.nlink !== 1 || s.size > MAX + 512)
        throw new Error("Invalid receiver object");
      used += s.size;
      if (++count > c.maxObjects || used > c.maxBytes)
        throw new Error("Receiver quota exceeded on restart");
    }
    // Uncommitted bytes count against quota too; crash debris is never silently deleted.
    for (const name of fs.readdirSync(pending)) {
      if (!/^[a-f0-9-]{36}\.tmp$/.test(name))
        throw new Error("Unknown receiver pending file");
      const s = fs.lstatSync(checked(path.join(pending, name)));
      if (!s.isFile() || s.nlink !== 1 || s.size > MAX + 512)
        throw new Error("Invalid pending object");
      used += s.size;
      if (used > c.maxBytes)
        throw new Error("Pending quota exceeded; operator inspection required");
    }
    const handler = async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.on("error", () => {});
      const credential = req.headers.authorization,
        writer = equal(credential, "Bearer " + writerToken),
        admin = equal(credential, "Bearer " + adminToken);
      const fail = (status, message) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: message }));
        req.resume();
      };
      if (!writer && !admin) return fail(401, "Unauthorized");
      if (req.method === "GET" && req.url === "/v1/status") {
        if (!admin) return fail(403, "Admin read role required");
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            ok: true,
            objects: count,
            bytes: used,
            append_only_protocol: true,
            delete_supported: false,
            physical_independence_verified: false,
            server_retention_reported: false,
          }),
        );
      }
      const match = req.url?.match(/^\/v1\/objects\/([a-f0-9]{64})$/);
      if (!match || req.headers["x-moonrestore-namespace"] !== c.namespace)
        return fail(400, "Invalid object scope");
      if (!["GET", "PUT"].includes(req.method))
        return fail(405, "Read/append only; deletion unavailable");
      if (req.method === "PUT" && !writer)
        return fail(403, "Writer role required");
      if (active >= 4) return fail(429, "Receiver concurrency budget");
      active++;
      try {
        const key = match[1],
          file = path.join(objects, key);
        if (req.method === "PUT") {
          const length = Number(req.headers["content-length"]);
          if (
            req.headers["if-none-match"] !== "*" ||
            !digest(req.headers["x-moonrestore-sha256"]) ||
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > MAX
          )
            return fail(400, "Bounded immutable write required");
          const chunks = [];
          let size = 0;
          for await (const b of req) {
            if ((size += b.length) > length) throw new Error("Body budget");
            chunks.push(b);
          }
          const bytes = Buffer.concat(chunks);
          if (
            size !== length ||
            sha(bytes) !== req.headers["x-moonrestore-sha256"]
          )
            return fail(400, "Checksum/size mismatch");
          if (fs.existsSync(file)) {
            const current = unframe(file, key);
            if (
              current.checksum !== sha(bytes) ||
              current.bytes.length !== size
            )
              return fail(409, "Immutable conflict");
          } else {
            const raw = frame(key, bytes);
            if (count >= c.maxObjects || used + raw.length > c.maxBytes)
              return fail(507, "Receiver quota");
            const temp = path.join(pending, randomUUID() + ".tmp");
            // Reserve before any uncertain write/publication. Errors may overcount,
            // never undercount, until a verified restart inventories physical files.
            count++;
            used += raw.length;
            writePrivate(temp, raw);
            try {
              unframe(temp, key);
              fs.linkSync(temp, file);
              syncDirectory(objects);
            } finally {
              fs.unlinkSync(temp);
              syncDirectory(pending);
            }
          }
        }
        const item = unframe(file, key);
        res.setHeader("x-moonrestore-version", item.version);
        res.setHeader("x-moonrestore-sha256", item.checksum);
        await new Promise((resolve) => {
          res.once("close", resolve);
          if (req.method === "GET") {
            res.setHeader("Content-Length", item.size);
            res.end(item.bytes, resolve);
          } else {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                checksum: item.checksum,
                size: item.size,
                version: item.version,
                server_retention_reported: false,
              }),
              resolve,
            );
          }
        });
      } catch (e) {
        if (!res.headersSent)
          fail(
            e.code === "ENOENT" ? 404 : 409,
            "Object unavailable or integrity check failed",
          );
        else res.destroy();
      } finally {
        active--;
      }
    };
    server = tls
      ? https.createServer(tls, handler)
      : http.createServer(handler);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.timeout = 15000;
    server.maxConnections = 16;
    server.maxHeadersCount = 32;
    server.maxRequestsPerSocket = 100;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
    return {
      server,
      port: server.address().port,
      namespace: c.namespace,
      close: async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        unlock();
      },
    };
  } catch (e) {
    server?.close();
    unlock();
    throw e;
  }
}
export class ReceiverBackend {
  constructor({ endpoint, namespace, credential }) {
    const u = new URL(endpoint);
    if (
      !scope(namespace) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
      )
    )
      throw new Error("HTTPS receiver or loopback endpoint required");
    token(credential);
    this.endpoint = u.origin;
    this.namespace = namespace;
    this.credential = credential;
  }
  async request(key, bytes, expected = {}) {
    if (
      typeof key !== "string" ||
      key.length > 1024 ||
      !key.startsWith(this.namespace + "/") ||
      /[\x00-\x20\\]/.test(key) ||
      key.split("/").some((v) => !v || v === "." || v === "..")
    )
      throw new Error("Receiver key outside namespace");
    if (
      bytes &&
      (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX)
    )
      throw new Error("Receiver object byte budget");
    if (
      expected.version !== undefined &&
      (!digest(expected.checksum) ||
        expected.version !== "sha256:" + expected.checksum)
    )
      throw new Error("Pinned receiver version/checksum required");
    const headers = {
      Authorization: "Bearer " + this.credential,
      "x-moonrestore-namespace": this.namespace,
    };
    if (bytes)
      Object.assign(headers, {
        "If-None-Match": "*",
        "x-moonrestore-sha256": sha(bytes),
        "Content-Length": String(bytes.length),
      });
    const response = await fetch(this.endpoint + "/v1/objects/" + sha(key), {
      method: bytes ? "PUT" : "GET",
      headers,
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Receiver request rejected (" + response.status + ")");
    }
    const chunks = [];
    let size = 0;
    for await (const b of response.body) {
      if ((size += b.length) > (bytes ? 2048 : MAX)) {
        await response.body.cancel().catch(() => {});
        throw new Error("Receiver response byte budget");
      }
      chunks.push(b);
    }
    const data = Buffer.concat(chunks);
    if (bytes) {
      const r = JSON.parse(data);
      if (
        r.checksum !== sha(bytes) ||
        r.size !== String(bytes.length) ||
        r.version !== "sha256:" + r.checksum ||
        r.server_retention_reported !== false
      )
        throw new Error("Receiver write acknowledgement mismatch");
      return r;
    }
    const checksum = sha(data),
      version = response.headers.get("x-moonrestore-version");
    if (
      response.headers.get("x-moonrestore-sha256") !== checksum ||
      version !== "sha256:" + checksum ||
      (expected.checksum && expected.checksum !== checksum) ||
      (expected.version && expected.version !== version)
    )
      throw new Error("Receiver read verification failed");
    return { bytes: data, checksum, version, headers: response.headers };
  }
  putImmutable(key, bytes) {
    return this.request(key, bytes);
  }
  get(key, expected) {
    return this.request(key, undefined, expected);
  }
}
export async function receiverCommand(args) {
  const [command, ...p] = args;
  if (command === "receiver-init" && p.length === 2)
    return initObjectReceiver(p[0], p[1]);
  if (command === "receiver-serve" && p.length >= 1 && p.length <= 3) {
    const port = p[1] === undefined ? 8792 : Number(p[1]);
    if (p[2] !== undefined && p[2] !== "--recover")
      throw new Error("Unknown receiver serve option");
    const running = await startObjectReceiver({
      directory: p[0],
      port,
      writerToken: process.env.MOONRESTORE_RECEIVER_WRITER_TOKEN,
      adminToken: process.env.MOONRESTORE_RECEIVER_ADMIN_TOKEN,
      recover: p[2] === "--recover",
    });
    console.log(
      JSON.stringify({
        ok: true,
        port: running.port,
        namespace: running.namespace,
        loopback_only: true,
        delete_supported: false,
      }),
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await running.close();
    return { ok: true, stopped: true };
  }
  if (command === "receiver-push" && p.length === 4) {
    const backend = new ReceiverBackend({
      endpoint: p[2],
      namespace: p[3],
      credential: process.env.MOONRESTORE_RECEIVER_WRITER_TOKEN,
    });
    return {
      ...(await pushPaged(p[0], p[1], backend, { prefix: p[3] })),
      kind: "receiver_snapshot_copy",
      physical_host_independence_verified: false,
    };
  }
  if (command === "receiver-restore" && p.length === 5) {
    const [endpoint, namespace, key, checksum, destination] = p,
      backend = new ReceiverBackend({
        endpoint,
        namespace,
        credential: process.env.MOONRESTORE_RECEIVER_WRITER_TOKEN,
      });
    if (!digest(checksum)) throw new Error("Pinned receipt checksum required");
    const read = await backend.get(key, {
      checksum,
      version: "sha256:" + checksum,
    });
    return {
      ...(await restorePagedRemote(
        backend,
        JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(read.bytes)),
        destination,
      )),
      kind: "receiver_snapshot_restore",
    };
  }
  if (command?.startsWith("receiver-"))
    throw new Error("Invalid receiver command/arguments");
  return null;
}
