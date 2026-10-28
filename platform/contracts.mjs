// Versioned capability contracts, not arbitrary executable plug-ins.
export const CONTRACT_VERSION = 1;
const definitions = {
  local: {
    immutable_write: true,
    conditional_create: true,
    versioned_read: false,
    filesystem: true,
    same_account_deletion_resistant: false,
  },
  s3: {
    immutable_write: true,
    conditional_create: true,
    versioned_read: true,
    filesystem: false,
    real_provider_verified: false,
  },
  files: { consistent_point: false, native_required: false },
  sqlite: { consistent_point: true, native_required: false },
  postgresql: { consistent_point: true, native_required: true },
  windows_vss: {
    consistent_point: false,
    native_required: true,
    implemented: true,
    real_environment_verified: false,
    runtime_activation_required: true,
  },
  paged_local: {
    immutable_write: true,
    conditional_create: true,
    filesystem: true,
    implemented: true,
    automatic_legacy_migration: false,
  },
  postgresql_physical: {
    implemented: true,
    native_required: true,
    pitr_requires_isolated_server: true,
    production_validated: false,
  },
  monitor_receiver: {
    implemented: true,
    independent_host_deployed: false,
    notification_delivery_confirmed: false,
  },
};
export function providerCapabilities(name) {
  if (!Object.hasOwn(definitions, name)) throw new Error("Unknown provider");
  return { contract: CONTRACT_VERSION, provider: name, ...definitions[name] };
}
export function requireCapabilities(name, required) {
  const d = providerCapabilities(name);
  if (
    !Array.isArray(required) ||
    required.some((k) => typeof k !== "string" || d[k] !== true)
  )
    throw new Error("Provider capability unavailable");
  return d;
}
export function providerCatalog() {
  return Object.keys(definitions).map(providerCapabilities);
}
export function negotiateProvider(request) {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (k) => !["provider", "contract", "required"].includes(k),
    ) ||
    request.contract !== CONTRACT_VERSION ||
    !Array.isArray(request.required) ||
    request.required.length > 16
  )
    throw new Error("Unsupported provider contract/fields");
  const result = requireCapabilities(request.provider, request.required);
  if (result.implemented === false)
    throw new Error("Provider is not implemented");
  if (result.runtime_activation_required)
    throw new Error(
      "Provider is implemented but requires explicit native runtime authorization",
    );
  return { ...result, negotiated: true, arbitrary_code_loaded: false };
}
export class OperationError extends Error {
  constructor(code, stage) {
    super(code + " at " + stage);
    this.code = code;
    this.stage = stage;
  }
}
