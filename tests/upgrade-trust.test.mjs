import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, snapshot, forge } from "./helpers.mjs";
import {
  createSigningKey,
  signArtifact,
  verifyArtifact,
} from "../platform/attestation.mjs";
import {
  protectionPreview,
  applyProtection,
  protectionStatus,
  assertPurgeProtection,
} from "../platform/recovery-policy.mjs";
import { previewPrune, applyPrune } from "../platform/retention.mjs";
test("Ed25519 pins trust externally, authenticates exact bytes and rejects forks, gaps and rollback", () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_SIGNING_PASSWORD;
  process.env.MOONRESTORE_SIGNING_PASSWORD = "synthetic-signing-password-only";
  try {
    const keys = path.join(f.base, "keys"),
      second = path.join(f.base, "second"),
      file = path.join(f.base, "manifest"),
      priv = path.join(keys, "private.pem"),
      pub = path.join(keys, "public.pem"),
      s1 = path.join(f.base, "s1.json"),
      s2 = path.join(f.base, "s2.json"),
      anchor = path.join(f.base, "anchor.json");
    createSigningKey(keys);
    createSigningKey(second);
    assert.ok(fs.readFileSync(priv, "utf8").includes("ENCRYPTED PRIVATE KEY"));
    assert.throws(() => createSigningKey(keys));
    fs.writeFileSync(file, "first");
    const first = signArtifact(file, priv, s1, { subject: "snapshot" });
    assert.equal(
      verifyArtifact(file, s1, pub).rollback_protected_by_local_anchor,
      false,
    );
    assert.throws(() =>
      verifyArtifact(file, s1, path.join(second, "public.pem")),
    );
    assert.throws(() =>
      verifyArtifact(file, s1, pub, { anchor, trust: "0".repeat(64) }),
    );
    assert.equal(
      verifyArtifact(file, s1, pub, { anchor, trust: first.attestation_hash })
        .rollback_protected_by_local_anchor,
      true,
    );
    fs.writeFileSync(file, "second");
    signArtifact(file, priv, s2, {
      subject: "snapshot",
      sequence: 2,
      previous: first.attestation_hash,
    });
    assert.equal(verifyArtifact(file, s2, pub, { anchor }).sequence, 2);
    assert.equal(verifyArtifact(file, s2, pub, { anchor }).sequence, 2); // Idempotent replay.
    fs.writeFileSync(file, "first");
    assert.throws(() => verifyArtifact(file, s1, pub, { anchor }), /Rollback/);
    fs.writeFileSync(file, "second");
    const fork = path.join(f.base, "fork.json");
    fs.writeFileSync(file, "validly signed fork");
    signArtifact(file, priv, fork, {
      subject: "snapshot",
      sequence: 2,
      previous: first.attestation_hash,
    });
    assert.throws(
      () => verifyArtifact(file, fork, pub, { anchor }),
      /Rollback/,
    );
    const envelope = JSON.parse(fs.readFileSync(fork));
    envelope.signature = "A".repeat(88);
    fs.writeFileSync(fork, JSON.stringify(envelope));
    assert.throws(() => verifyArtifact(file, fork, pub, { anchor }));
    fs.writeFileSync(file, "second");
    const gap = path.join(f.base, "gap.json");
    signArtifact(file, priv, gap, {
      subject: "snapshot",
      sequence: 4,
      previous: first.attestation_hash,
    });
    assert.throws(() => verifyArtifact(file, gap, pub, { anchor }), /Rollback/);
    fs.appendFileSync(file, "tamper");
    assert.throws(() => verifyArtifact(file, s2, pub));
    delete process.env.MOONRESTORE_SIGNING_PASSWORD;
    assert.throws(() =>
      signArtifact(file, priv, path.join(f.base, "no-password"), {
        subject: "package",
      }),
    );
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_SIGNING_PASSWORD;
    else process.env.MOONRESTORE_SIGNING_PASSWORD = old;
    f.cleanup();
  }
});
test("persistent pins and age windows change prune confirmations and block legacy/young purge", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    put(f.source, "a", "retained");
    const b = backup(f),
      original = snapshot(f, b.snapshot);
    // All changes below are confined to this owned synthetic repository.
    fs.unlinkSync(path.join(f.repo, "snapshots", b.snapshot + ".json"));
    const first = forge(f, {
      ...original,
      created: new Date(Date.now() - 80 * 86400000).toISOString(),
    });
    const last = forge(f, {
      ...original,
      created: new Date(Date.now() - 40 * 86400000).toISOString(),
      label: "last",
    });
    const settings = { keepLast: 1, daily: 0, weekly: 0, monthly: 0 },
      initial = await previewPrune(f.repo, settings),
      c = { minimumDays: 30, pins: [first] },
      p = protectionPreview(f.repo, c);
    await assert.rejects(() => applyProtection(f.repo, c, "wrong"));
    assert.equal(
      (await applyProtection(f.repo, c, p.confirmation)).pins_content_verified,
      true,
    );
    assert.equal(protectionStatus(f.repo).pins[0], first);
    assert.deepEqual((await previewPrune(f.repo, settings)).plan.remove, []);
    await assert.rejects(
      () => applyPrune(f.repo, settings, initial.confirmation),
      /confirmation/,
    );
    assert.throws(
      () =>
        assertPurgeProtection(f.repo, {
          created: new Date(Date.now() - 60 * 86400000).toISOString(),
        }),
      /policy/,
    );
    assert.throws(
      () =>
        assertPurgeProtection(f.repo, {
          snapshots: [last],
          created: new Date().toISOString(),
        }),
      /policy/,
    );
    assert.throws(
      () =>
        assertPurgeProtection(f.repo, {
          snapshots: [first],
          created: new Date(Date.now() - 60 * 86400000).toISOString(),
        }),
      /policy/,
    );
    assert.throws(() => protectionStatus(f.repo, Date.now() - 60000), /clock/);
    const invalid = { minimumDays: 30, pins: ["0".repeat(64)] },
      bad = protectionPreview(f.repo, invalid);
    await assert.rejects(() =>
      applyProtection(f.repo, invalid, bad.confirmation),
    );
    assert.equal(protectionStatus(f.repo).pins[0], first); // Failed update preserves old protection.
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
