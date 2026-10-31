import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture, put, tree, sha } from "./helpers.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import { backupPaged } from "../platform/paged-operations.mjs";
test("unified HTTP restore supports native metadata, durable writer identity and isolated application validation", async () => {
  const f = fixture(),
    previous = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "home");
  const app = await startWorkbench({ port: 0 }),
    request = async (route, body) => {
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
    const repo = path.join(f.base, "paged"),
      target = path.join(f.base, "restored");
    await PagedStore.create(repo, { fidelity: true });
    put(f.source, "asset", "controlled");
    const b = await backupPaged(repo, f.source);
    const capabilities = await request("restore-capabilities", {
      repository: repo,
    });
    assert.equal(capabilities.body.archived_native_metadata, true);
    assert.equal(
      (
        await request("restore-writer-create", {
          repository: repo,
          snapshot: b.snapshot,
          target,
          confirmation: target,
          metadataMode: "native",
          permissions: false,
        })
      ).status,
      400,
    );
    const preview = await request("restore-preview", {
      repository: repo,
      snapshot: b.snapshot,
      target,
      metadataMode: "native",
      restoreModes: true,
    });
    assert.equal(preview.status, 200);
    assert.equal(fs.existsSync(target), false);
    const created = await request("restore-writer-create", {
      repository: repo,
      snapshot: b.snapshot,
      target,
      confirmation: target,
      metadataMode: "native",
      permissions: true,
    });
    assert.equal(created.status, 200);
    const payload = { repository: repo, id: created.body.operation };
    const restored = await request("restore-writer-resume", {
      ...payload,
      recover: false,
    });
    assert.equal(restored.body.complete, true);
    assert.equal(restored.body.metadata_profile_verified, true);
    assert.deepEqual(tree(target), tree(f.source));
    assert.equal(
      (await request("restore-writer-status", payload)).body.complete,
      true,
    );
    const application = await request("application-validate", {
      root: target,
      contract: {
        format: 1,
        files: [{ path: "asset", sha256: sha("controlled") }],
      },
    });
    assert.equal(application.body.declared_contract_verified, true);
    assert.equal(application.body.application_process_started, false);
    assert.equal(
      (
        await request("application-validate", {
          root: target,
          contract: { format: 1, script: "forbidden" },
        })
      ).status,
      400,
    );
    for (const route of [
      "restore-capabilities",
      "restore-writer-create",
      "restore-writer-resume",
      "restore-writer-status",
      "application-validate",
    ])
      assert.equal((await request(route, { unexpected: true })).status, 400);
    const html = await (await fetch(app.origin)).text();
    assert.ok(html.includes("恢复向导"));
    assert.ok(html.includes("wizard-consent"));
    assert.equal((await fetch(app.origin + "/restore-wizard.js")).status, 200);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = previous;
    f.cleanup();
  }
});
