import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertCompilerVersion } from "../scripts/compiler-version.mjs";
test("compiler acceptance floor rejects old/unknown tools, accepts newer patch/minor/major versions", () => {
  for (const version of ["0.10.16", "0.10.18", "0.10.100", "0.11.0", "1.0.0"])
    assert.deepEqual(
      assertCompilerVersion("moon 0.1\nmoonc v" + version + "+hash (date)"),
      version.split(".").map(Number),
    );
  for (const output of [
    "moonc v0.10.15",
    "moonc v0.9.99",
    "moon 0.10.18",
    "",
    "moonc v0.10.x",
  ])
    assert.throws(() => assertCompilerVersion(output));
});

test("registry manifest package and compiled CLI report the same release version", () => {
  const version = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url)),
  ).version;
  assert.match(
    fs.readFileSync(new URL("../moon.mod", import.meta.url), "utf8"),
    new RegExp('version = "' + version.replaceAll(".", "\\.") + '"'),
  );
  const r = spawnSync(process.execPath, ["bin/moonrestore.mjs", "version"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "MoonRestore " + version);
});
