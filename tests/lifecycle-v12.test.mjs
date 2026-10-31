import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, randomBytes, tree, call } from "./helpers.mjs";
import { PagedStore } from "../platform/paged-store.mjs";
import {
  backupPaged,
  restorePaged,
  verifyPaged,
} from "../platform/paged-operations.mjs";
import {
  copyPaged,
  rebuildPaged,
  repairPaged,
} from "../platform/paged-copy.mjs";
import {
  exportArchive,
  importArchive,
  archiveMembers,
} from "../platform/archive.mjs";
async function owned(fn) {
  const f = fixture(),
    old = {
      home: process.env.MOONRESTORE_HOME,
      password: process.env.MOONRESTORE_PASSWORD,
    };
  process.env.MOONRESTORE_HOME = path.join(f.base, "private");
  process.env.MOONRESTORE_PASSWORD = "controlled-source-password-v12";
  try {
    await fn(f);
  } finally {
    if (old.home === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old.home;
    if (old.password === undefined) delete process.env.MOONRESTORE_PASSWORD;
    else process.env.MOONRESTORE_PASSWORD = old.password;
    f.cleanup();
  }
}
test("format4/5 rebuild reencrypts logical packs/pages without filesystem metadata roundtrip", () =>
  owned(async (f) => {
    put(f.source, "中文/a.bin", randomBytes(300000));
    put(f.source, "empty", "");
    for (const format of [4, 5]) {
      const repo = path.join(f.base, "source-" + format);
      await PagedStore.create(repo, {
        encrypted: true,
        fidelity: format === 5,
      });
      const b = await backupPaged(repo, f.source, { label: "original" }),
        before = tree(repo);
      const capabilities = call(["repository-capabilities", repo]);
      assert.equal(capabilities.lossless_page_rekey, true);
      assert.equal(capabilities.archived_native_metadata, format === 5);
      assert.equal(capabilities.all_filesystem_metadata_preserved, false);
      const dst = path.join(f.base, "new-key-" + format),
        password = "controlled-new-password-v12";
      const result = await rebuildPaged(repo, dst, {
        destinationPassword: password,
      });
      assert.equal(result.format, format);
      assert.equal(result.new_master_key, true);
      assert.equal(result.plaintext_staging_used, false);
      assert.equal(result.old_copies_revoked, false);
      assert.deepEqual(tree(repo), before);
      const environment = {
        ...process.env,
        MOONRESTORE_PASSWORD: password,
        MOONRESTORE_KEY_FILE: "",
      };
      await assert.rejects(PagedStore.open(dst));
      await verifyPaged(dst, result.mapping[0].to, { environment });
      const a = await PagedStore.open(repo),
        d = await PagedStore.open(dst, { environment });
      try {
        const original = a.root(b.snapshot),
          changed = d.root(result.mapping[0].to);
        assert.equal(original.created, changed.created);
        assert.equal(original.last_page, changed.last_page);
        assert.deepEqual(original.fidelity, changed.fidelity);
        for (const last of [
          original.last_page,
          original.fidelity?.last_page,
        ].filter(Boolean))
          assert.deepEqual(a.read("page", last), d.read("page", last));
      } finally {
        a.close();
        d.close();
      }
      const recovered = path.join(f.base, "readback-" + format);
      await restorePaged(dst, result.mapping[0].to, recovered, {
        environment,
        permissions: true,
      });
      assert.deepEqual(tree(recovered), tree(f.source));
    }
  }));
test("format4/5 segmented archives preserve ciphertext metadata and restore into new repositories", () =>
  owned(async (f) => {
    put(f.source, "文档.bin", randomBytes(1200000));
    for (const format of [4, 5]) {
      const repo = path.join(f.base, "archive-source-" + format);
      await PagedStore.create(repo, {
        encrypted: true,
        fidelity: format === 5,
      });
      const b = await backupPaged(repo, f.source),
        before = tree(repo),
        archive = path.join(f.base, "archive-" + format),
        dest = path.join(f.base, "import-" + format);
      const receipt = await exportArchive(repo, archive);
      assert.equal(receipt.repository_format, format);
      assert.ok(
        [...archiveMembers(archive, receipt.checksum)].some((m) =>
          m.path.startsWith("packs/"),
        ),
      );
      await importArchive(archive, receipt.checksum, dest);
      await verifyPaged(dest, b.snapshot);
      assert.deepEqual(tree(repo), before);
      await assert.rejects(
        importArchive(
          archive,
          "0".repeat(64),
          path.join(f.base, "bad-" + format),
        ),
      );
      assert.equal(fs.existsSync(path.join(f.base, "bad-" + format)), false);
      const output = path.join(f.base, "unpacked-" + format);
      await restorePaged(dest, b.snapshot, output, { permissions: true });
      assert.deepEqual(tree(output), tree(f.source));
    }
  }));
test("two read-only donors with complementary damage repair both content and metadata without patching either", () =>
  owned(async (f) => {
    const repo = path.join(f.base, "broken-a"),
      donor = path.join(f.base, "broken-b");
    await PagedStore.create(repo, { encrypted: true, fidelity: true });
    put(f.source, "payload", randomBytes(900000));
    const b = await backupPaged(repo, f.source);
    await copyPaged(repo, donor);
    const a = await PagedStore.open(repo),
      d = await PagedStore.open(donor);
    let bad;
    try {
      const r = a.root(b.snapshot);
      fs.unlinkSync(a.file("snapshot", b.snapshot));
      fs.unlinkSync(d.file("page", r.last_page));
      bad = a.file("page", r.fidelity.last_page);
    } finally {
      a.close();
      d.close();
    }
    const priorA = tree(repo),
      priorB = tree(donor),
      dest = path.join(f.base, "repaired");
    const r = await repairPaged(repo, donor, b.snapshot, dest);
    assert.ok(r.donor_members > 0);
    assert.equal(r.archived_metadata_bytes_preserved, true);
    await verifyPaged(dest, b.snapshot);
    const cliRepair = call(
      [
        "paged-repair",
        repo,
        donor,
        b.snapshot,
        path.join(f.base, "cli-repaired"),
      ],
      { timeout: 60000 },
    );
    assert.equal(cliRepair.full_snapshot_audit, true);
    assert.deepEqual(tree(repo), priorA);
    assert.deepEqual(tree(donor), priorB);
    const output = path.join(f.base, "repaired-files");
    await restorePaged(dest, b.snapshot, output, { permissions: true });
    assert.deepEqual(tree(output), tree(f.source));
    fs.writeFileSync(bad, "damaged");
    const other = await PagedStore.open(donor);
    try {
      fs.writeFileSync(
        other.file("page", other.root(b.snapshot).fidelity.last_page),
        "damaged",
      );
    } finally {
      other.close();
    }
    await assert.rejects(
      repairPaged(
        repo,
        donor,
        b.snapshot,
        path.join(f.base, "must-not-publish"),
      ),
      /No healthy/,
    );
    assert.equal(fs.existsSync(path.join(f.base, "must-not-publish")), false);
  }));
