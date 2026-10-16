import { spawnSync } from "node:child_process";
import { moon, moonEnv } from "./build.mjs";
const r = spawnSync(moon, ["package", "--list", "--frozen"], {
  encoding: "utf8",
  env: moonEnv,
  shell: false,
  maxBuffer: 8 * 1024 * 1024,
});
if (r.status !== 0) throw new Error("Mooncakes package listing failed");
// moon currently emits the listing on stderr; do not mistake empty stdout for
// an empty package. Check both streams and filter actual archive member lines.
const names = (r.stdout + "\n" + r.stderr)
  .split(/\r?\n/)
  .filter((name) =>
    /^(?:LICENSE|NOTICE|README\.md|moon\.mod|package\.json|[^\s]+[\\/][^\s]+|[^\s]+\.(?:md|mjs|cmd))$/.test(
      name,
    ),
  );
if (
  names.some((name) =>
    /申报书|(?:^|[\\/])(?:\.local|\.env[^\\/]*|node_modules|\.git|_build|coverage)(?:[\\/]|$)|\.dpapi$|recovery-key.*\.json$/i.test(
      name,
    ),
  )
)
  throw new Error("Private file found in registry package");
if (
  !names.some((name) => name.includes("LICENSE")) ||
  !names.some((name) => name.includes("NOTICE"))
)
  throw new Error("License/NOTICE missing");
console.log(
  JSON.stringify({ package_privacy_check: true, listed_entries: names.length }),
);
