// Optional explicit notification integration. An adapter's acknowledgement is
// recorded separately from storage persistence and from a human reading it.
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdirPrivate, stateHome, readPrivate } from "./vault.mjs";
import { atomicPrivate } from "./journal.mjs";
import { monitorStatus } from "./monitor-receiver.mjs";
import { activity } from "./activity.mjs";
export async function deliverAlert(
  directory,
  endpoint,
  {
    confirmation,
    allowRemote = false,
    token = process.env.MOONRESTORE_ALERT_TOKEN,
  } = {},
) {
  const u = new URL(endpoint),
    loop = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (
    confirmation !== endpoint ||
    typeof allowRemote !== "boolean" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["http:", "https:"].includes(u.protocol) ||
    (!loop && (!allowRemote || u.protocol !== "https:")) ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    typeof token !== "string" ||
    token.length < 32 ||
    token.length > 2048 ||
    /[\x00-\x20\x7f]/.test(token)
  )
    throw new Error(
      "Explicit trusted alert adapter and environment token required",
    );
  const status = monitorStatus(directory),
    summary = {
      heartbeat_missing: status.heartbeat_missing,
      heartbeat_expired: status.heartbeat_expired,
      clock_backward: status.clock_backward,
      sender_ready: status.sender_ready,
    },
    fingerprint = createHash("sha256")
      .update(JSON.stringify(summary))
      .digest("hex"),
    root = mkdirPrivate(path.join(stateHome(), "alert-outbox-v1")),
    key = createHash("sha256")
      .update(path.resolve(directory) + "\n" + u.href)
      .digest("hex"),
    file = path.join(root, key + ".json"),
    lock = file + ".lock";
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    let r = fs.existsSync(file) ? JSON.parse(readPrivate(file, 16384)) : null;
    const now = Date.now();
    if (
      r &&
      (r.format !== 1 ||
        typeof r.pending !== "boolean" ||
        !Number.isSafeInteger(r.created) ||
        now < r.created)
    )
      throw new Error("Alert outbox state/clock invalid");
    if (
      r &&
      !r.pending &&
      r.fingerprint === fingerprint &&
      now - r.created < 3600000
    )
      return {
        ok: true,
        deduplicated: true,
        event_id: r.event.event_id,
        adapter_acknowledged: true,
        human_read_verified: false,
        real_channel_verified: false,
      };
    if (!r?.pending) {
      r = {
        format: 1,
        pending: true,
        created: now,
        fingerprint,
        event: {
          format: 1,
          event_id: randomUUID(),
          kind: "moonrestore_monitor_alert",
          observed_at: new Date(now).toISOString(),
          summary,
        },
      };
      atomicPrivate(file, Buffer.from(JSON.stringify(r)));
    }
    const signals = [AbortSignal.timeout(10000)];
    if (activity()?.signal) signals.push(activity().signal);
    const response = await fetch(u, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "Idempotency-Key": r.event.event_id,
      },
      body: JSON.stringify(r.event),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
    let n = 0;
    const parts = [];
    for await (const b of response.body ?? []) {
      n += b.length;
      if (n > 16384) throw new Error("Alert receipt size budget");
      parts.push(b);
    }
    const ack = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
    );
    if (
      response.status !== 200 ||
      ack.event_id !== r.event.event_id ||
      ack.persisted !== true ||
      ack.delivered !== true ||
      typeof ack.receipt_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(ack.receipt_id)
    )
      throw new Error(
        "Final adapter delivery receipt required; event remains pending",
      );
    r.pending = false;
    r.receipt = {
      id: ack.receipt_id,
      acknowledged_at: new Date().toISOString(),
    };
    atomicPrivate(file, Buffer.from(JSON.stringify(r)));
    return {
      ok: true,
      event_id: r.event.event_id,
      adapter_acknowledged: true,
      adapter_claimed_delivery: true,
      human_read_verified: false,
      real_channel_verified: false,
      credentials_saved: false,
    };
  } finally {
    fs.rmdirSync(lock);
  }
}
