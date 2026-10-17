import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, snapshot, tree } from "./helpers.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
test("HTTP recovery enforces confirmations, partial status and source read-only; scrub never hides damage", async () => {
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
    put(f.source, "good", "good-content");
    put(f.source, "bad", "bad-content");
    const b = backup(f);
    const id = snapshot(f, b.snapshot).entries.find((e) => e.path === "bad")
      .chunks[0].id;
    fs.writeFileSync(
      path.join(f.repo, "objects", id.slice(0, 2), id),
      "corrupt",
    );
    const before = tree(f.repo),
      target = path.join(f.base, "rescued"),
      body = { repository: f.repo, snapshot: b.snapshot, target };
    assert.equal(
      (await request("emergency-list", { repository: f.repo })).body.snapshots
        .length,
      1,
    );
    assert.equal(
      (await request("rescue-preview", { ...body, unknown: true })).status,
      400,
    );
    const preview = await request("rescue-preview", body);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.failed_files, 1);
    assert.equal(
      (
        await request("rescue-apply", {
          ...body,
          confirmation: preview.body.confirmation,
          acceptPartial: false,
        })
      ).status,
      400,
    );
    const result = await request("rescue-apply", {
      ...body,
      confirmation: preview.body.confirmation,
      acceptPartial: true,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.complete, false);
    assert.equal(result.body.post_restore_readback, true);
    assert.equal(
      fs.readFileSync(path.join(target, "good"), "utf8"),
      "good-content",
    );
    assert.equal(fs.existsSync(path.join(target, "bad")), false);
    assert.equal(
      (await request("recovery-health", { repository: f.repo })).body.ok,
      false,
    );
    assert.equal(
      (
        await request("scrub", {
          repository: f.repo,
          maxFiles: 10,
          maxBytes: "1000",
        })
      ).body.ok,
      false,
    );
    assert.equal(
      (await request("recovery-health", { repository: f.repo })).body
        .snapshots[0].state,
      "failed",
    );
    assert.equal(
      (
        await request("recovery-checklist", {
          repository: f.repo,
          output: path.join(f.base, "check.json"),
          confirmation: "wrong",
        })
      ).status,
      400,
    );
    assert.deepEqual(tree(f.repo), before);
    assert.equal((await fetch(app.origin + "/recovery.js")).status, 200);
  } finally {
    await app.close();
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
