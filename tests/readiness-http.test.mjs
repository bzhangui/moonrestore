import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture } from "./helpers.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
test("readiness/state/remote/SQLite/rescue HTTP routes preserve authentication, explicit consent and confirmation gates", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const app = await startWorkbench({ port: 0 });
  const request = async (route, body = {}, headers = {}) => {
    const r = await fetch(app.origin + "/api/" + route, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + app.token,
        Origin: app.origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.equal((await fetch(app.origin + "/readiness.js")).status, 200);
    assert.equal(
      (await request("readiness", {}, { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (await request("readiness", {}, { Origin: "https://example.invalid" }))
        .status,
      403,
    );
    const r = await request("readiness");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.local_observer_only, true);
    assert.equal(
      (await request("state-status")).body.active,
      process.env.MOONRESTORE_HOME,
    );
    assert.equal(
      (
        await request("remote-audit", {
          endpoint: "http://127.0.0.1:1",
          allowRemote: false,
        })
      ).status,
      400,
    );
    const target = path.join(f.base, "new-target");
    assert.equal(
      (
        await request("sqlite-recover", {
          repository: f.repo,
          snapshot: "a".repeat(64),
          destination: target,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("rescue-kit-create", {
          destination: target,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("rescue-kit-restore", {
          destination: target,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("rescue-kit-check", {
          kit: f.source,
          recipeSha256: "wrong",
          repository: f.repo,
        })
      ).status,
      400,
    );
    const source = path.join(f.base, "old-state");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "jobs.json"), "[]");
    const preview = await request("state-migrate-preview", {
      source,
      destination: target,
    });
    assert.equal(preview.body.credentials_copied, false);
    assert.equal(
      (
        await request("state-migrate", {
          source,
          destination: target,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(
      (
        await request("state-migrate", {
          source,
          destination: target,
          confirmation: preview.body.confirmation,
        })
      ).body.source_unchanged,
      true,
    );
    assert.equal(
      (await request("plan-os-install", { id: "bad", confirmation: "bad" }))
        .status,
      400,
    ); // No OS registration attempted.
  } finally {
    await app.close();
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
