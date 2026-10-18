// Versioned capability contracts, not arbitrary executable plug-ins.
export const CONTRACT_VERSION = 1;
const definitions = {
  local: {
    immutable_write: true,
    conditional_create: true,
    versioned_read: false,
    filesystem: true,
  },
  s3: {
    immutable_write: true,
    conditional_create: true,
    versioned_read: true,
    filesystem: false,
  },
  files: { consistent_point: false, native_required: false },
  sqlite: { consistent_point: true, native_required: false },
  postgresql: { consistent_point: true, native_required: true },
  windows_vss: {
    consistent_point: false,
    native_required: true,
    implemented: false,
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
  return { ...result, negotiated: true, arbitrary_code_loaded: false };
}
export class OperationError extends Error {
  constructor(code, stage) {
    super(code + " at " + stage);
    this.code = code;
    this.stage = stage;
  }
}
