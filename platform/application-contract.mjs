// Declarative, read-only restored-application checks. No scripts, arbitrary SQL,
// external application launch, or live database modifications are permitted.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { checked, readPrivate } from "./vault.mjs";
import { storageCore } from "./paged-store.mjs";
import { verifySqliteRecovery } from "./sqlite-recovery.mjs";
import { checkpoint } from "./activity.mjs";
const plain = (v, fields) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
    Reflect.ownKeys(v).some((k) => !fields.includes(k))
  )
    throw new Error("Invalid application contract fields");
};
export async function validateApplication(
  root,
  contract,
  { timeoutMs = 30000 } = {},
) {
  plain(contract, ["format", "files", "json", "sqlite"]);
  if (
    contract.format !== 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 1800000 ||
    Buffer.byteLength(JSON.stringify(contract)) > 65536
  )
    throw new Error("Application contract budget");
  for (const group of ["files", "json", "sqlite"])
    if (
      contract[group] !== undefined &&
      (!Array.isArray(contract[group]) ||
        contract[group].length > (group === "sqlite" ? 8 : 128))
    )
      throw new Error("Application check count budget");
  if (
    !(
      contract.files?.length ||
      contract.json?.length ||
      contract.sqlite?.length
    )
  )
    throw new Error("At least one application check required");
  root = checked(root);
  const rootIdentity = fs.lstatSync(root, { bigint: true }),
    core = await storageCore(),
    start = performance.now();
  let verifiedBytes = 0;
  const identities = new Map(),
    fingerprint = (s) =>
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
        .map((k) => String(s[k]))
        .join(":");
  if (!rootIdentity.isDirectory())
    throw new Error("Recovered application root required");
  const resolve = (relative) => {
    if (typeof relative !== "string")
      throw new Error("Relative artifact path required");
    core("path", { session: relative });
    const file = checked(path.join(root, ...relative.split("/")));
    if (!file.startsWith(root + path.sep) || !fs.lstatSync(file).isFile())
      throw new Error("Artifact is not a contained regular file");
    const identity = fingerprint(fs.lstatSync(file, { bigint: true }));
    if (identities.has(file) && identities.get(file) !== identity)
      throw new Error("Application artifact changed between checks");
    identities.set(file, identity);
    return file;
  };
  const budget = () => {
    checkpoint("application_contract");
    if (performance.now() - start > timeoutMs)
      throw new Error("Application validation deadline");
  };
  for (const rule of contract.files ?? []) {
    plain(rule, ["path", "sha256", "bytes"]);
    if (
      !/^[a-f0-9]{64}$/.test(rule.sha256) ||
      (rule.bytes !== undefined && !/^(0|[1-9][0-9]{0,11})$/.test(rule.bytes))
    )
      throw new Error("Exact file hash/size required");
    budget();
    const file = resolve(rule.path),
      before = fs.lstatSync(file, { bigint: true });
    if (
      before.size > 67108864n ||
      (verifiedBytes += Number(before.size)) > 134217728 ||
      (rule.bytes !== undefined && rule.bytes !== String(before.size))
    )
      throw new Error("Application artifact byte budget or declared size");
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== before.dev || opened.ino !== before.ino)
        throw new Error("Artifact identity changed");
      const sha = createHash("sha256"),
        buffer = Buffer.alloc(1048576);
      let offset = 0,
        n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, offset))) {
        budget();
        offset += n;
        if (offset > Number(before.size)) throw new Error("Artifact grew");
        sha.update(buffer.subarray(0, n));
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (
        offset !== Number(before.size) ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        sha.digest("hex") !== rule.sha256
      )
        throw new Error("Application artifact integrity mismatch");
    } finally {
      fs.closeSync(fd);
    }
  }
  for (const rule of contract.json ?? []) {
    plain(rule, ["path", "equals"]);
    plain(rule.equals, Object.keys(rule.equals ?? {}));
    if (
      !Object.keys(rule.equals).length ||
      Object.keys(rule.equals).length > 64
    )
      throw new Error("JSON assertion budget");
    budget();
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readPrivate(resolve(rule.path), 1048576),
      ),
    );
    for (const [key, expected] of Object.entries(rule.equals)) {
      if (
        (expected !== null &&
          !["string", "number", "boolean"].includes(typeof expected)) ||
        (typeof expected === "number" && !Number.isSafeInteger(expected)) ||
        !value ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key) ||
        value[key] !== expected
      )
        throw new Error("Declared JSON application assertion failed");
    }
  }
  const sqlite = [];
  for (const rule of contract.sqlite ?? []) {
    plain(rule, ["path", "checks"]);
    budget();
    sqlite.push(
      await verifySqliteRecovery(
        resolve(rule.path),
        rule.checks ?? { format: 1, tables: [] },
        {
          referenceRoot: root,
          timeoutMs: Math.max(
            100,
            Math.floor(timeoutMs - (performance.now() - start)),
          ),
        },
      ),
    );
  }
  budget();
  for (const [file, identity] of identities)
    if (fingerprint(fs.lstatSync(checked(file), { bigint: true })) !== identity)
      throw new Error("Application artifact changed before final validation");
  const after = fs.lstatSync(checked(root), { bigint: true });
  if (
    after.dev !== rootIdentity.dev ||
    after.ino !== rootIdentity.ino ||
    after.mtimeNs !== rootIdentity.mtimeNs
  )
    throw new Error("Recovered application tree changed");
  return {
    ok: true,
    kind: "application_recovery_contract",
    contract_checksum: createHash("sha256")
      .update(JSON.stringify(contract))
      .digest("hex"),
    file_checks: contract.files?.length ?? 0,
    json_checks: contract.json?.length ?? 0,
    sqlite_checks: sqlite.length,
    reference_checks: sqlite.reduce((n, x) => n + x.reference_checks, 0),
    file_bytes_verified: String(verifiedBytes),
    elapsed_ms: Math.ceil(performance.now() - start),
    declared_contract_verified: true,
    arbitrary_code_executed: false,
    application_process_started: false,
    capture_consistency_proven: false,
    physical_power_loss_verified: false,
  };
}
export async function applicationContractCommand(args) {
  if (args[0] !== "application-validate") return null;
  if (args.length !== 3)
    throw new Error(
      "Usage: application-validate RESTORED_ROOT PRIVATE_CONTRACT_JSON",
    );
  return validateApplication(args[1], JSON.parse(readPrivate(args[2], 65536)));
}
