import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  fixture,
  put,
  backup,
  call,
  tree,
  sha,
  randomBytes,
} from "./helpers.mjs";
import {
  exportArchive,
  importArchive,
  archiveMembers,
} from "../platform/archive.mjs";
test("segmented archive round-trips zero, random, unicode, empty and multi-page snapshots into audited new repository", async () => {
  const f = fixture();
  try {
    put(f.source, "零/empty", "");
    put(f.source, "zeros", Buffer.alloc(1400000));
    put(f.source, "random", randomBytes(3000000));
    for (let n = 0; n < 70; n++)
      put(f.source, "many/" + n, randomBytes(10000, n + 80));
    const b = backup(f),
      before = tree(f.repo),
      archive = path.join(f.base, "archive"),
      dest = path.join(f.base, "import"),
      r = await exportArchive(f.repo, archive);
    assert.ok(r.pages > 1);
    assert.ok(r.stored_bytes < r.raw_bytes);
    await importArchive(archive, r.checksum, dest);
    call(["verify", dest, b.snapshot]);
    call(["restore", dest, b.snapshot, path.join(f.base, "restore")]);
    assert.deepEqual(tree(f.source), tree(path.join(f.base, "restore")));
    assert.deepEqual(tree(f.repo), before);
    await assert.rejects(() => importArchive(archive, r.checksum, dest));
  } finally {
    f.cleanup();
  }
});
test("archive root, page, segment damage and path traversal never publish a target", async () => {
  const f = fixture();
  try {
    put(f.source, "a", "data");
    backup(f);
    const archive = path.join(f.base, "archive"),
      r = await exportArchive(f.repo, archive),
      rootFile = path.join(archive, "archive.json"),
      root = JSON.parse(fs.readFileSync(rootFile)),
      ref = root.pages[0],
      pageFile = path.join(archive, "pages", ref.id),
      original = fs.readFileSync(pageFile);
    await assert.rejects(() =>
      importArchive(archive, "0".repeat(64), path.join(f.base, "bad-root")),
    );
    fs.writeFileSync(pageFile, "[]");
    await assert.rejects(() =>
      importArchive(archive, r.checksum, path.join(f.base, "bad-page")),
    );
    fs.writeFileSync(pageFile, original);
    const part = JSON.parse(original)[0].parts[0],
      segment = path.join(archive, "segments", part.id);
    fs.writeFileSync(segment, "bad");
    await assert.rejects(() =>
      importArchive(archive, r.checksum, path.join(f.base, "bad-segment")),
    );
    assert.equal(fs.existsSync(path.join(f.base, "bad-segment")), false);
    const page = JSON.parse(original);
    page[0].path = "../escape";
    const forged = Buffer.from(JSON.stringify(page)),
      pid = sha(forged);
    fs.writeFileSync(path.join(archive, "pages", pid), forged);
    root.pages[0] = { ...ref, id: pid, bytes: forged.length };
    const bytes = Buffer.from(JSON.stringify(root));
    fs.writeFileSync(rootFile, bytes);
    assert.throws(() => [...archiveMembers(archive, sha(bytes))], /schema/);
  } finally {
    f.cleanup();
  }
});

test("pinned malicious archive rejects cross-page duplicate members and decompression bombs", async () => {
  const f = fixture();
  try {
    const archive = path.join(f.base, "malicious");
    fs.mkdirSync(archive);
    fs.mkdirSync(path.join(archive, "segments"));
    fs.mkdirSync(path.join(archive, "pages"));
    const bomb = deflateRawSync(Buffer.alloc(1048577)),
      part = {
        id: sha(bomb),
        plain: "0".repeat(64),
        codec: "deflate",
        bytes: 1048576,
        stored: bomb.length,
      },
      page = Buffer.from(
        JSON.stringify([
          { path: "moonrestore", bytes: part.bytes, parts: [part] },
        ]),
      ),
      ref = { id: sha(page), bytes: page.length, count: 1 };
    fs.writeFileSync(path.join(archive, "segments", part.id), bomb);
    fs.writeFileSync(path.join(archive, "pages", ref.id), page);
    let root = Buffer.from(
      JSON.stringify({
        format: 1,
        kind: "moonrestore_segmented_transport",
        encrypted: false,
        pages: [ref, ref],
        members: 2,
      }),
    );
    fs.writeFileSync(path.join(archive, "archive.json"), root);
    assert.throws(() => [...archiveMembers(archive, sha(root))], /duplicate/);
    root = Buffer.from(
      JSON.stringify({
        format: 1,
        kind: "moonrestore_segmented_transport",
        encrypted: false,
        pages: [ref],
        members: 1,
      }),
    );
    fs.writeFileSync(path.join(archive, "archive.json"), root);
    const target = path.join(f.base, "no-publication");
    await assert.rejects(
      () => importArchive(archive, sha(root), target),
      /larger|limit|length|buffer/i,
    );
    assert.equal(fs.existsSync(target), false);
  } finally {
    f.cleanup();
  }
});
