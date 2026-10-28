// Can run on a separately administered host. Local tests do not prove independence.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
} from "./vault.mjs";
import { newFile, syncDirectory } from "./paged-store.mjs";
import { options } from "./maintenance.mjs";
import { publicReadiness, recoveryReadiness } from "./readiness.mjs";
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tokenValue(token) {
  if (
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 2048 ||
    /[\x00-\x20\x7f]/.test(token)
  )
    throw new Error(
      "Monitor token must be 32..2048 non-space bytes, supplied by environment only",
    );
  return token;
}
function save(file, value) {
  checked(path.dirname(file));
  const tmp = file + "." + randomUUID() + ".tmp";
  writePrivate(tmp, JSON.stringify(value));
  if (fs.existsSync(file)) readPrivate(file, 65536);
  fs.renameSync(tmp, file);
  syncDirectory(path.dirname(file));
}
export function initMonitor(
  directory,
  { source, maxAgeSeconds = 3600, now = Date.now() } = {},
) {
  if (
    !uuid(source) ||
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 5 ||
    maxAgeSeconds > 604800 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw new Error(
      "Monitor source UUID and expiry 5..604800 seconds required",
    );
  const root = checked(directory, false);
  fs.mkdirSync(root, { mode: 0o700 });
  newFile(
    path.join(root, "monitor.json"),
    Buffer.from(
      JSON.stringify({
        format: 1,
        source,
        max_age_seconds: maxAgeSeconds,
        registered: now,
      }),
    ),
  );
  return {
    ok: true,
    source,
    receiver_initialized: true,
    credentials_saved: false,
  };
}
function load(directory) {
  const root = checked(directory),
    r = JSON.parse(readPrivate(path.join(root, "monitor.json"), 2048));
  if (
    r.format !== 1 ||
    !uuid(r.source) ||
    !Number.isSafeInteger(r.registered) ||
    !Number.isInteger(r.max_age_seconds) ||
    r.max_age_seconds < 5 ||
    r.max_age_seconds > 604800
  )
    throw new Error("Invalid monitor configuration");
  return { root, config: r };
}
const boolKeys = ["ready", "inventory_valid", "production_rto_guaranteed"];
const countKeys = [
  "total_plans",
  "ready_plans",
  "missing_plans",
  "incomplete_plans",
  "rpo_exceeded",
  "rto_exceeded",
  "independent_copies_verified",
];
function report(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          ...boolKeys,
          ...countKeys,
          "format",
          "kind",
          "report_id",
          "observed_at",
        ].includes(k),
    )
  )
    throw new Error("Only aggregate readiness fields accepted");
  for (const k of boolKeys)
    if (typeof value[k] !== "boolean")
      throw new Error("Boolean readiness required");
  for (const k of countKeys)
    if (!Number.isInteger(value[k]) || value[k] < 0 || value[k] > 1000000)
      throw new Error("Readiness count budget");
  if (
    value.format !== 1 ||
    value.kind !== "moonrestore_readiness_heartbeat" ||
    !uuid(value.report_id) ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    value.ready_plans > value.total_plans ||
    value.production_rto_guaranteed !== false
  )
    throw new Error("Invalid aggregate report");
  if (
    value.ready &&
    (value.total_plans === 0 ||
      value.ready_plans !== value.total_plans ||
      !value.inventory_valid ||
      [
        "missing_plans",
        "incomplete_plans",
        "rpo_exceeded",
        "rto_exceeded",
      ].some((k) => value[k] !== 0))
  )
    throw new Error("Inconsistent or empty ready report");
  return value;
}
export function monitorStatus(directory, { now = Date.now() } = {}) {
  const { root, config } = load(directory),
    file = path.join(root, "receipt.json"),
    receipt = fs.existsSync(file) ? JSON.parse(readPrivate(file, 16384)) : null;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    (receipt &&
      (!Number.isSafeInteger(receipt.received) ||
        receipt.source !== config.source ||
        !Number.isSafeInteger(receipt.sequence) ||
        receipt.sequence < 1))
  )
    throw new Error("Invalid monitor receipt or clock");
  const last = receipt?.received ?? config.registered,
    clockBackward = now < last,
    age = clockBackward ? null : Math.floor((now - last) / 1000),
    missing = !receipt,
    stale = clockBackward || age > config.max_age_seconds;
  return {
    ok: !missing && !stale && receipt.report.ready === true,
    kind: "independent_receiver_status",
    heartbeat_missing: missing,
    heartbeat_expired: stale,
    clock_backward: clockBackward,
    age_seconds: age,
    sender_ready: receipt?.report.ready ?? null,
    notification_delivery_confirmed: false,
    host_independence_verified: false,
  };
}
export function startMonitor(
  directory,
  {
    token = process.env.MOONRESTORE_MONITOR_TOKEN,
    host = "127.0.0.1",
    port = 8791,
    tls,
    allowRemote = false,
    now = () => Date.now(),
  } = {},
) {
  tokenValue(token);
  if (
    !net.isIP(host) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    (!["127.0.0.1", "::1"].includes(host) && (!allowRemote || !tls))
  )
    throw new Error(
      "Non-loopback receiver requires explicit TLS and permission",
    );
  const { root, config } = load(directory),
    lock = path.join(root, ".receiver-lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  newFile(
    path.join(lock, "owner.json"),
    Buffer.from(JSON.stringify({ pid: process.pid, started: Date.now() })),
  );
  let requests = 0,
    window = now();
  const auth = Buffer.from(token);
  const handler = async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
    };
    try {
      const clock = now();
      if (clock - window >= 60000) {
        window = clock;
        requests = 0;
      }
      if (++requests > 120) {
        reply(429, { ok: false });
        req.resume();
        return;
      }
      const supplied = Buffer.from(
        String(req.headers.authorization || "").replace(/^Bearer /, ""),
      );
      if (supplied.length !== auth.length || !timingSafeEqual(auth, supplied)) {
        reply(401, { ok: false });
        req.resume();
        return;
      }
      if (req.url === "/status" && req.method === "GET") {
        reply(200, monitorStatus(root, { now: clock }));
        return;
      }
      if (
        req.url !== "/heartbeat" ||
        req.method !== "POST" ||
        !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")
      ) {
        reply(404, { ok: false });
        req.resume();
        return;
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) {
          reply(413, { ok: false });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      }
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (
        Object.keys(value).some(
          (k) => !["source", "sequence", "report"].includes(k),
        ) ||
        value.source !== config.source ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1
      )
        throw new Error("Invalid source or sequence");
      report(value.report);
      const file = path.join(root, "receipt.json"),
        previous = fs.existsSync(file)
          ? JSON.parse(readPrivate(file, 16384))
          : null,
        payload = digest(Buffer.from(JSON.stringify(value)));
      if (
        previous &&
        (clock < previous.received ||
          value.sequence < previous.sequence ||
          (value.sequence === previous.sequence &&
            payload !== previous.payload))
      ) {
        reply(409, { ok: false });
        return;
      }
      if (clock < config.registered) {
        reply(409, { ok: false });
        return;
      }
      const duplicate = previous?.sequence === value.sequence;
      if (!duplicate)
        save(file, { format: 1, ...value, payload, received: clock });
      reply(200, {
        ok: true,
        persisted: true,
        idempotent: duplicate,
        expiry_refreshed: !duplicate,
        notification_delivery_confirmed: false,
      });
    } catch {
      if (!res.headersSent) reply(400, { ok: false });
      else res.end();
    }
  };
  let server;
  try {
    server = tls
      ? https.createServer(
          {
            key: readPrivate(tls.key, 65536),
            cert: readPrivate(tls.cert, 65536),
            minVersion: "TLSv1.2",
          },
          handler,
        )
      : http.createServer(handler);
  } catch (error) {
    fs.unlinkSync(path.join(lock, "owner.json"));
    fs.rmdirSync(lock);
    throw error;
  }
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  server.once("close", () => {
    auth.fill(0);
    fs.unlinkSync(checked(path.join(lock, "owner.json")));
    fs.rmdirSync(lock);
  });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(port, host, () => resolve(server));
  });
}
export async function sendMonitor(
  endpoint,
  source,
  readiness,
  { token = process.env.MOONRESTORE_MONITOR_TOKEN, allowRemote = false } = {},
) {
  tokenValue(token);
  if (!uuid(source)) throw new Error("Monitor source UUID required");
  const url = new URL(endpoint),
    loop = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/heartbeat" ||
    !["http:", "https:"].includes(url.protocol) ||
    (!loop && (!allowRemote || url.protocol !== "https:")) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new Error("Trusted monitor heartbeat URL required");
  const parent = mkdirPrivate(path.join(stateHome(), "monitor-senders")),
    key = digest(Buffer.from(url.href + "\n" + source)),
    file = path.join(parent, key + ".json"),
    lock = file + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const old = fs.existsSync(file)
      ? JSON.parse(readPrivate(file, 16384))
      : null;
    if (
      old &&
      (!Number.isSafeInteger(old.sequence) ||
        old.sequence < 1 ||
        old.sequence >= Number.MAX_SAFE_INTEGER)
    )
      throw new Error("Sender sequence exhausted or invalid");
    // Persist intent before network; a lost response can retry the same sequence.
    const current = old?.pending
      ? old
      : {
          sequence: (old?.sequence ?? 0) + 1,
          pending: true,
          report: report(readiness),
        };
    save(file, current);
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        source,
        sequence: current.sequence,
        report: current.report,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (Number(response.headers.get("content-length")) > 4096) {
      await response.body?.cancel();
      throw new Error("Monitor response budget");
    }
    const reader = response.body?.getReader();
    let used = 0,
      parts = [];
    if (reader)
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        used += r.value.length;
        if (used > 4096) {
          await reader.cancel();
          throw new Error("Monitor response budget");
        }
        parts.push(r.value);
      }
    const receipt = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!response.ok || receipt.persisted !== true)
      throw new Error("Receiver did not confirm persistence");
    save(file, { ...current, pending: false });
    return {
      ok: true,
      receiver_persistence_confirmed: true,
      notification_delivery_confirmed: false,
      host_independence_verified: false,
    };
  } finally {
    fs.rmdirSync(lock);
  }
}
export async function monitorCommand(args) {
  const [command, ...rest] = args;
  if (
    ![
      "monitor-init",
      "monitor-status",
      "monitor-serve",
      "monitor-send",
    ].includes(command)
  )
    return null;
  const { positionals: p, values: v } = options(
      rest,
      [
        "source",
        "max-age",
        "host",
        "port",
        "allow-remote",
        "tls-key",
        "tls-cert",
      ],
      ["allow-remote"],
    ),
    only = (...keys) => Object.keys(v).every((k) => keys.includes(k));
  if (command === "monitor-init" && p.length === 1 && only("source", "max-age"))
    return initMonitor(p[0], {
      source: v.source,
      maxAgeSeconds: v["max-age"] === undefined ? 3600 : Number(v["max-age"]),
    });
  if (command === "monitor-status" && p.length === 1 && only())
    return monitorStatus(p[0]);
  if (
    command === "monitor-send" &&
    p.length === 1 &&
    only("source", "allow-remote")
  )
    return sendMonitor(
      p[0],
      v.source,
      publicReadiness(await recoveryReadiness()),
      { allowRemote: !!v["allow-remote"] },
    );
  if (
    command === "monitor-serve" &&
    p.length === 1 &&
    only("host", "port", "allow-remote", "tls-key", "tls-cert")
  ) {
    if (!!v["tls-key"] !== !!v["tls-cert"])
      throw new Error("Both TLS paths required");
    const server = await startMonitor(p[0], {
      host: v.host,
      port: v.port === undefined ? 8791 : Number(v.port),
      allowRemote: !!v["allow-remote"],
      tls: v["tls-key"]
        ? { key: v["tls-key"], cert: v["tls-cert"] }
        : undefined,
    });
    console.log(
      JSON.stringify({
        ok: true,
        monitor_listening: true,
        port: server.address().port,
        notification_delivery_confirmed: false,
      }),
    );
    return new Promise((resolve) => {
      const stop = () =>
        server.close(() => resolve({ ok: true, receiver_stopped: true }));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
  throw new Error("Invalid monitor command");
}
