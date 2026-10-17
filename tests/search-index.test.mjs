import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture, put, backup, call, tree } from "./helpers.mjs";
import {
  buildSearchIndex,
  searchIndex,
  decodeIndexPayload,
} from "../platform/search-index.mjs";
import { withCredentials } from "../platform/activity.mjs";

test("bounded canonical Base64 decoding handles 8/16 MiB payloads without a regexp stack and rejects malformed encodings", () => {
  for (const size of [1048576, 8388608, 16777216, 16777280]) {
    const expected = Buffer.alloc(size, 0xa5),
      actual = decodeIndexPayload(expected.toString("base64"));
    assert.equal(actual.length, size);
    assert.equal(actual.compare(expected), 0);
  }
  for (const input of [null, {}, "@@@@", "AQ", "AQ==\n", "AR==", "AA===="])
    assert.throws(() => decodeIndexPayload(input), /Base64/);
  assert.throws(
    () => decodeIndexPayload(Buffer.alloc(16777281).toString("base64")),
    /Base64/,
  );
});

test("disposable index searches validated history and refuses stale or corrupted cache", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  try {
    put(f.source, "paper.txt", "first");
    backup(f);
    put(f.source, "paper.txt", "second");
    backup(f);
    const before = tree(f.repo),
      built = await buildSearchIndex(f.repo);
    assert.equal(built.snapshots, 2);
    const found = await searchIndex(f.repo, "paper");
    assert.equal(found.results.length, 2);
    assert.equal(found.integrity_verified, false);
    assert.deepEqual(tree(f.repo), before);
    put(f.source, "new.txt", "new");
    backup(f);
    await assert.rejects(() => searchIndex(f.repo, "paper"), /stale/);
    await buildSearchIndex(f.repo);
    const dir = path.join(f.base, "state/search-index"),
      file = path.join(dir, fs.readdirSync(dir)[0]);
    const record = JSON.parse(fs.readFileSync(file));
    record.payload = Buffer.from("corrupt").toString("base64");
    fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(() => searchIndex(f.repo, "paper"), /integrity/);
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
test("encrypted index does not persist filenames or contents and requires the repository key", async () => {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const repository = path.join(f.base, "encrypted"),
    password = "synthetic-only-index-password";
  try {
    call(["init-encrypted", repository], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    put(f.source, "private-document-name", "private-text");
    call(["backup", repository, f.source], {
      env: { MOONRESTORE_PASSWORD: password },
    });
    await withCredentials(
      () => ({ MOONRESTORE_PASSWORD: password }),
      async () => {
        assert.equal((await buildSearchIndex(repository)).encrypted, true);
        assert.equal(
          (await searchIndex(repository, "private-document")).results.length,
          1,
        );
      },
    );
    const dir = path.join(f.base, "state/search-index"),
      text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8");
    assert.ok(
      !text.includes("private-document") &&
        !text.includes("private-text") &&
        !text.includes(password),
    );
    await assert.rejects(() => searchIndex(repository, "private"));
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
});
