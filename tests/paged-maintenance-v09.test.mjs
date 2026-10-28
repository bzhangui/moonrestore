import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fixture, put } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { backupPaged } from "../platform/paged-operations.mjs";
import { scrub, recoveryHealth } from "../platform/recovery.mjs";
import { initMonitor } from "../platform/monitor-receiver.mjs";
import { deliverAlert } from "../platform/alert-delivery.mjs";
async function setup(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    await work(f);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("paged scrub completes through bounded file batches, retains oldest check and detects corrupt data in a new cycle", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    for (let i = 0; i < 3; i++) put(f.source, i + ".txt", "payload-" + i);
    const b = await backupPaged(repo, f.source);
    assert.equal((await recoveryHealth(repo)).ok, false);
    let r;
    for (let i = 0; i < 3; i++) {
      r = await scrub(repo, {
        snapshot: b.snapshot,
        maxFiles: 1,
        maxBytes: "1000",
      });
      assert.equal(r.checked_files, 1);
      if (i < 2) assert.equal(r.ok, false);
    }
    assert.equal(r.ok, true);
    assert.equal(r.all_bytes_just_read, false);
    assert.equal((await recoveryHealth(repo)).ok, true);
    const fresh = await backupPaged(repo, f.source),
      pack = path.join(
        repo,
        "packs",
        fs.readdirSync(path.join(repo, "packs"))[0],
      );
    fs.writeFileSync(pack, "corrupt");
    const bad = await scrub(repo, { snapshot: fresh.snapshot, maxFiles: 10 });
    assert.equal(bad.ok, false);
    assert.ok(bad.snapshots[0].errors > 0);
  }));
test("an oversize scrub file is explicitly pending rather than silently skipped as verified", () =>
  setup(async (f) => {
    const repo = path.join(f.base, "paged");
    await PagedStore.create(repo);
    put(f.source, "large", Buffer.alloc(1024));
    const b = await backupPaged(repo, f.source),
      r = await scrub(repo, { snapshot: b.snapshot, maxBytes: "32" });
    assert.equal(r.file_exceeds_budget, true);
    assert.equal(r.ok, false);
    assert.equal(r.snapshots[0].complete, false);
  }));
test("alert adapter must return final delivery receipt; failed response retries same event and never claims human reading", () =>
  setup(async (f) => {
    const monitor = path.join(f.base, "monitor");
    initMonitor(monitor, { source: "11111111-1111-4111-8111-111111111111" });
    let complete = false;
    const events = [];
    const app = http.createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      const r = JSON.parse(body);
      events.push(r);
      assert.equal(req.headers["idempotency-key"], r.event_id);
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          event_id: r.event_id,
          persisted: true,
          delivered: complete,
          receipt_id: "synthetic-delivery-1",
        }),
      );
    });
    await new Promise((r) => app.listen(0, "127.0.0.1", r));
    const endpoint = "http://127.0.0.1:" + app.address().port + "/alert",
      opts = {
        confirmation: endpoint,
        token: "synthetic-alert-token-".repeat(3),
      };
    try {
      await assert.rejects(
        deliverAlert(monitor, endpoint, opts),
        /Final adapter/,
      );
      complete = true;
      const r = await deliverAlert(monitor, endpoint, opts);
      assert.equal(r.adapter_acknowledged, true);
      assert.equal(r.human_read_verified, false);
      assert.equal(r.real_channel_verified, false);
      assert.equal(events[0].event_id, events[1].event_id);
      assert.equal(JSON.stringify(events).includes(f.base), false);
      assert.equal(
        (await deliverAlert(monitor, endpoint, opts)).deduplicated,
        true,
      );
      assert.equal(events.length, 2);
      await assert.rejects(
        deliverAlert(monitor, "http://example.invalid/alert", {
          ...opts,
          confirmation: "http://example.invalid/alert",
        }),
      );
    } finally {
      app.closeAllConnections();
      await new Promise((r) => app.close(r));
    }
  }));
