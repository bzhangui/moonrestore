import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers.mjs";
import {
  initMonitor,
  monitorStatus,
  startMonitor,
  sendMonitor,
} from "../platform/monitor-receiver.mjs";
const token = "synthetic-controlled-monitor-token-000000000",
  source = randomUUID();
const report = () => ({
  format: 1,
  kind: "moonrestore_readiness_heartbeat",
  report_id: randomUUID(),
  observed_at: new Date().toISOString(),
  ready: true,
  inventory_valid: true,
  production_rto_guaranteed: false,
  total_plans: 1,
  ready_plans: 1,
  missing_plans: 0,
  incomplete_plans: 0,
  rpo_exceeded: 0,
  rto_exceeded: 0,
  independent_copies_verified: 0,
});

test("a lost persistence receipt retries one sequence without extending receiver liveness", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  let now = Date.now();
  const root = path.join(f.base, "receiver");
  initMonitor(root, { source, now });
  const server = await startMonitor(root, { token, port: 0, now: () => now });
  let drop = true;
  const proxy = http.createServer(async (req, res) => {
    const bytes = [];
    for await (const b of req) bytes.push(b);
    const response = await fetch(
      "http://127.0.0.1:" + server.address().port + "/heartbeat",
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: Buffer.concat(bytes),
      },
    );
    const body = await response.text();
    if (drop) {
      drop = false;
      res.destroy();
    } else {
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(body);
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + proxy.address().port + "/heartbeat";
  try {
    await assert.rejects(sendMonitor(endpoint, source, report(), { token }));
    const first = JSON.parse(fs.readFileSync(path.join(root, "receipt.json")));
    assert.equal(first.sequence, 1);
    now += 1000;
    assert.equal(
      (await sendMonitor(endpoint, source, report(), { token }))
        .receiver_persistence_confirmed,
      true,
    );
    const second = JSON.parse(fs.readFileSync(path.join(root, "receipt.json")));
    assert.equal(second.sequence, 1);
    assert.equal(second.received, first.received);
  } finally {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("receiver persists before receipt, rejects replay, reports absence/expiry/clock anomalies without business paths", async () => {
  const f = fixture(),
    root = path.join(f.base, "receiver");
  let now = 100000;
  initMonitor(root, { source, maxAgeSeconds: 5, now });
  const server = await startMonitor(root, { token, port: 0, now: () => now }),
    endpoint = "http://127.0.0.1:" + server.address().port;
  const post = (value, t = token) =>
    fetch(endpoint + "/heartbeat", {
      method: "POST",
      headers: {
        authorization: "Bearer " + t,
        "content-type": "application/json",
      },
      body: JSON.stringify(value),
    });
  try {
    assert.equal(monitorStatus(root, { now }).heartbeat_missing, true);
    const body = { source, sequence: 1, report: report() };
    assert.equal((await post(body, "wrong-token")).status, 401);
    const receipt = await (await post(body)).json();
    assert.equal(receipt.persisted, true);
    assert.equal(monitorStatus(root, { now }).ok, true);
    now += 6000;
    assert.equal((await (await post(body)).json()).expiry_refreshed, false);
    assert.equal(monitorStatus(root, { now }).heartbeat_expired, true);
    assert.equal((await post({ ...body, report: report() })).status, 409);
    assert.equal((await post({ ...body, sequence: 0 })).status, 400);
    now = 99999;
    assert.equal(monitorStatus(root, { now }).clock_backward, true);
    assert.equal((await post({ ...body, sequence: 2 })).status, 409);
    assert.equal(
      (
        await post({
          ...body,
          report: { ...body.report, private_path: "not-allowed" },
        })
      ).status,
      400,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "receipt.json"), "utf8").includes(token),
      false,
    );
    assert.equal(
      (
        await post({
          ...body,
          report: { ...body.report, total_plans: 0, ready_plans: 0 },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(endpoint + "/status", {
          headers: { authorization: "Bearer " + token },
        })
      ).status,
      200,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    f.cleanup();
  }
});
test("persistent sender survives receiver restart, sequences heartbeats and requires authenticated HTTPS off-host", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const root = path.join(f.base, "receiver");
  initMonitor(root, { source });
  let server;
  try {
    server = await startMonitor(root, { token, port: 0 });
    const endpoint = "http://127.0.0.1:" + server.address().port + "/heartbeat";
    assert.equal(
      (await sendMonitor(endpoint, source, report(), { token }))
        .receiver_persistence_confirmed,
      true,
    );
    await sendMonitor(endpoint, source, report(), { token });
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "receipt.json"))).sequence,
      2,
    );
    await new Promise((resolve) => server.close(resolve));
    server = await startMonitor(root, { token, port: 0 });
    assert.equal(monitorStatus(root).ok, true);
    await assert.rejects(
      sendMonitor("http://example.invalid/heartbeat", source, report(), {
        token,
      }),
      /Trusted/,
    );
    assert.throws(
      () => startMonitor(root, { token: "short", port: 0 }),
      /token/,
    );
    assert.throws(
      () => startMonitor(root, { token, host: "0.0.0.0", port: 0 }),
      /TLS/,
    );
  } finally {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
