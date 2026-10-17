import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup } from "./helpers.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
test("authenticated durable HTTP plans, status and confirmed resumable restore validate fields and assets", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const app = await startWorkbench({ port: 0 });
  const request = async (route, body) => {
    const r = await fetch(app.origin + "/api/" + route, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + app.token,
        Origin: app.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    put(f.source, "a", "synthetic");
    const b = backup(f),
      target = path.join(f.base, "restore");
    assert.equal((await fetch(app.origin + "/durable.js")).status, 200);
    assert.equal(
      (
        await request("plan-save", {
          name: "HTTP受控",
          type: "files",
          repository: f.repo,
          source: f.source,
          password: "never-store",
        })
      ).status,
      400,
    );
    const saved = await request("plan-save", {
      name: "HTTP受控",
      type: "files",
      repository: f.repo,
      source: f.source,
    });
    assert.equal(saved.status, 200);
    assert.equal((await request("plans", {})).body.plans.length, 1);
    assert.equal(
      (
        await request("restore-resumable", {
          repository: f.repo,
          snapshot: b.snapshot,
          target,
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    const restored = await request("restore-resumable", {
      repository: f.repo,
      snapshot: b.snapshot,
      target,
      confirmation: target,
    });
    assert.equal(restored.body.ok, true);
    assert.equal(
      (
        await request("operation-status", {
          repository: f.repo,
          id: restored.body.operation,
        })
      ).body.state,
      "completed",
    );
    assert.equal(
      (
        await request("operation-resume", {
          repository: f.repo,
          id: restored.body.operation,
          recover: "true",
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
