// Read-only public-tree preflight. Pattern checks are a guardrail, not a full
// secret detector; human review is still required before publishing.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
function listed(args) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error("Git public-tree listing failed");
  return r.stdout.split("\0").filter(Boolean);
}
const names = [
  ...new Set([
    ...listed(["ls-files", "-z"]),
    ...listed(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]),
];
const forbidden =
  /(?:^|\/)(?:\.local|\.env[^/]*|node_modules|_build|credentials\.json|coverage)(?:\/|$)|申报书|\.dpapi$|recovery-key.*\.json$/i;
const secrets =
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/;
let markdown = 0,
  links = 0;
for (const name of names) {
  if (forbidden.test(name)) throw new Error("Private filename in public tree");
  const full = path.join(root, name);
  if (!fs.existsSync(full)) continue; // A tracked deletion is checked by Git, not read as an existing file.
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
    throw new Error("Unexpected public member");
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  if (secrets.test(text))
    throw new Error("Concrete access-token pattern in public source");
  if (!name.endsWith(".md")) continue;
  markdown++;
  for (const match of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    let target = match[1].replace(/^<|>$/g, "");
    if (target.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target))
      continue;
    target = decodeURIComponent(target.split("#")[0]);
    if (!target) continue;
    const resolved = path.resolve(path.dirname(full), target),
      relative = path.relative(root, resolved).replaceAll(path.sep, "/");
    if (
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      forbidden.test(relative) ||
      !fs.existsSync(resolved)
    )
      throw new Error("Missing or private local Markdown link in " + name);
    links++;
  }
}
for (const file of ["README.md", "LICENSE", "NOTICE"])
  if (!names.includes(file) || !fs.existsSync(path.join(root, file)))
    throw new Error("Required open-source metadata missing");
console.log(
  JSON.stringify({
    public_tree_preflight: true,
    listed: names.length,
    markdown_files: markdown,
    local_links: links,
    private_names_excluded: true,
    known_token_patterns_absent: true,
    not_a_complete_secret_audit: true,
  }),
);
