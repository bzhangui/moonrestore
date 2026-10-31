import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture, sha, tree } from "./helpers.mjs";
import {
  copyVerifiedBundle,
  previewBundleTransition,
} from "../platform/bundle-transition.mjs";
function bundle(root, version) {
  fs.mkdirSync(root);
  const names = [
      "bin/moonrestore.mjs",
      "_build/js/release/build/cmd/main/main.js",
      "LICENSE",
      "NOTICE",
    ],
    files = {};
  for (const p of names) {
    const file = path.join(root, p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "synthetic-" + p);
    files[p] = sha("synthetic-" + p);
  }
  const raw = JSON.stringify({
    format: 1,
    version,
    files,
    supported_repository_formats: [1, 2, 3, 4, 5],
  });
  fs.writeFileSync(path.join(root, "manifest.json"), raw);
  return sha(raw);
}
test("side-by-side install copies only verified allowlist and never changes old version, private state or activation", () => {
  const f = fixture();
  try {
    const current = path.join(f.base, "old"),
      next = path.join(f.base, "next"),
      a = bundle(current, "0.11.0"),
      b = bundle(next, "0.12.0"),
      before = tree(current);
    fs.writeFileSync(path.join(next, "private-unlisted"), "must not copy");
    const transition = previewBundleTransition(current, next, a, b);
    assert.equal(transition.automatic_activation, false);
    assert.equal(transition.automatic_state_downgrade, false);
    const installed = path.join(f.base, "installed"),
      r = copyVerifiedBundle(next, installed, b);
    assert.equal(r.application_started, false);
    assert.equal(r.state_or_keys_copied, false);
    assert.equal(
      fs.existsSync(path.join(installed, "private-unlisted")),
      false,
    );
    assert.deepEqual(tree(current), before);
    assert.throws(() => copyVerifiedBundle(next, installed, b), /NEW/);
    assert.throws(
      () =>
        copyVerifiedBundle(next, path.join(f.base, "wrong"), "0".repeat(64)),
      /hash/,
    );
    fs.writeFileSync(path.join(next, "LICENSE"), "corrupt");
    assert.throws(
      () => copyVerifiedBundle(next, path.join(f.base, "corrupt"), b),
      /checksum/,
    );
    assert.equal(fs.existsSync(path.join(f.base, "corrupt")), false);
  } finally {
    f.cleanup();
  }
});
