// Allowlist-only diagnostics: never export job/source/repository paths, IDs,
// filenames, environment, original error messages, credentials or report bodies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stateHome, checked, writePrivate } from "./vault.mjs";
import { options } from "./maintenance.mjs";
import { providerCatalog } from "./contracts.mjs";
export function supportSummary() {
  const count = (directory, directories = false) => {
    const root = path.join(stateHome(), directory);
    if (!fs.existsSync(root)) return 0;
    const it = fs.opendirSync(checked(root));
    let count = 0,
      seen = 0;
    try {
      for (let e = it.readSync(); e; e = it.readSync()) {
        if (++seen > 10000) return "budget_exceeded";
        if (
          directories
            ? e.isDirectory() && /^[a-f0-9-]{36}$/.test(e.name)
            : e.isFile() && e.name.endsWith(".json")
        )
          count++;
      }
    } finally {
      it.closeSync();
    }
    // Count only; no member names leave this function.
    return count;
  };
  const version = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url))),
  ).version;
  return {
    format: 1,
    kind: "moonrestore_support_summary",
    version,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    counts: {
      plans: count("plans-v1"),
      schedules: count("plan-schedules-v1"),
      operations: count("operations", true),
    },
    capabilities: providerCatalog(),
    boundaries: {
      live_segmented_manifest: false,
      native_vss: false,
      pitr: false,
      publisher_code_signed: false,
      physical_power_loss_validated: false,
      real_cloud_validated: false,
    },
    secrets_included: false,
    paths_included: false,
    raw_errors_included: false,
  };
}
export function supportCommand(args) {
  if (args[0] !== "support-report") return null;
  const { positionals: p, values: v } = options(args.slice(1), ["output"]);
  if (p.length || Object.keys(v).some((k) => k !== "output"))
    throw new Error("Usage: support-report [--output NEW_PRIVATE_JSON]");
  const r = supportSummary();
  if (v.output)
    writePrivate(checked(v.output, false), JSON.stringify(r, null, 2));
  return r;
}
