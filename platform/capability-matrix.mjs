// Capability claims name implemented workflows, not certified storage guarantees.
import { repositoryKind } from "./repository-kind.mjs";
export function repositoryCapabilities(format) {
  if (!Number.isInteger(format) || format < 1 || format > 5)
    throw new Error("Unknown repository format");
  return {
    contract: 1,
    format,
    paged: format >= 4,
    backup: true,
    verify: true,
    new_target_restore: true,
    resumable_restore: true,
    two_donor_repair: true,
    segmented_transport_version: format >= 4 ? 2 : 1,
    lossless_page_rekey: format >= 4,
    archived_native_metadata: format === 5,
    native_restore:
      format === 5
        ? "matching_platform_permission_and_readback"
        : "basic_profile_only",
    automatic_in_place_upgrade: false,
    physical_power_loss_verified: false,
    cross_host_verified: false,
    all_filesystem_metadata_preserved: false,
  };
}
export function capabilityCommand(args) {
  if (args[0] !== "repository-capabilities") return null;
  if (args.length !== 2) throw new Error("Usage: repository-capabilities REPO");
  const kind = repositoryKind(args[1]);
  return {
    ok: true,
    ...repositoryCapabilities(kind.format),
    encrypted: kind.encrypted,
  };
}
