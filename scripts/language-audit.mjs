// Raw tracked/source byte counts are evidence, not an official scoring formula.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const files = new Set();
for (const args of [
  ["ls-files", "-z"],
  ["ls-files", "--others", "--exclude-standard", "-z"],
]) {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error("Git source inventory failed");
  for (const name of r.stdout.split("\0").filter(Boolean)) files.add(name);
}
const languages = {
  ".mbt": "MoonBit",
  ".mjs": "JavaScript",
  ".js": "JavaScript",
  ".c": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".ps1": "PowerShell",
  ".html": "HTML",
  ".css": "CSS",
};
const scopes = { all_tracked_source: {}, runtime_without_tests: {} };
for (const file of [...files].sort()) {
  const language = languages[path.extname(file)];
  if (!language || !fs.existsSync(file)) continue;
  const bytes = fs.statSync(file).size;
  for (const [scope, counts] of Object.entries(scopes)) {
    if (
      scope === "runtime_without_tests" &&
      (!/^(core|app|cmd|platform|bin|ui)\//.test(file) ||
        /(?:_wbtest|_test)\.mbt$/.test(file))
    )
      continue;
    counts[language] ??= { files: 0, bytes: 0 };
    counts[language].files++;
    counts[language].bytes += bytes;
  }
}
console.log(
  JSON.stringify(
    {
      scopes,
      linguist_overrides_used: false,
      official_threshold_claimed: false,
      acceptance_primary_language_certified: false,
    },
    null,
    2,
  ),
);
