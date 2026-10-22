import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  checked,
  mkdirPrivate,
  readPrivate,
  writePrivate,
  stateHome,
} from "./vault.mjs";
import { hash, options } from "./maintenance.mjs";
import { publishDirectory, safeRelative } from "./adapter.mjs";
const allowed = new Set([
  "jobs.json",
  "plans-v1",
  "plan-schedules-v1",
  "cleanup-guards",
  "retention-protection-v1",
]);
export function stateLocation() {
  const active = stateHome(),
    desktop =
      process.platform === "win32" && process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "MoonRestoreState")
        : null;
  return {
    ok: true,
    active,
    desktop,
    explicit: !!process.env.MOONRESTORE_HOME,
    unified: desktop ? active.toLowerCase() === desktop.toLowerCase() : null,
    automatic_migration: false,
    credentials_copied: false,
  };
}
export function stateMigrationPreview(source, destination) {
  const from = checked(source),
    to = checked(destination, false);
  if (!fs.statSync(from).isDirectory() || fs.existsSync(to))
    throw new Error("Existing state source and new target required");
  const relative = path.relative(from, to);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    throw new Error("State target must be outside source");
  checked(path.dirname(to));
  const members = [],
    excluded = [];
  let bytes = 0;
  const walk = (folder, prefix) => {
    for (const entry of fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? prefix + "/" + entry.name : entry.name,
        full = path.join(folder, entry.name);
      safeRelative(rel);
      if (entry.isSymbolicLink())
        throw new Error("State links are unsupported");
      if (/\.lock(?:$|\.)|\.tmp$|owner\.json$/i.test(entry.name))
        throw new Error(
          "Active or interrupted state; recover leases before migration",
        );
      if (!prefix && !allowed.has(entry.name)) {
        excluded.push(entry.name);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile() || !rel.endsWith(".json"))
        throw new Error("Unexpected configuration member");
      const data = readPrivate(full, 1048576),
        record = JSON.parse(data);
      const inspect = (v) => {
        if (!v || typeof v !== "object") return;
        for (const [key, value] of Object.entries(v)) {
          if (
            typeof value === "string" &&
            /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
          ) {
            let u;
            try {
              u = new URL(value);
            } catch {
              throw new Error("Credential/invalid URL in configuration");
            }
            if (
              u.username ||
              u.password ||
              u.hash ||
              [...u.searchParams.keys()].some((k) =>
                /password|token|secret|credential|key|signature|auth/i.test(k),
              )
            )
              throw new Error("Credential-bearing URL state is not migrated");
          }
          if (
            /password|token|secret|credential|recovery.?key|key.?file/i.test(
              key,
            ) &&
            !(
              ["accessKeyEnv", "secretKeyEnv", "sessionTokenEnv"].includes(
                key,
              ) &&
              typeof value === "string" &&
              /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
            )
          )
            throw new Error("Credential-bearing state is not migrated");
          if (key === "activeOperation" && value)
            throw new Error("Unfinished operation cannot migrate");
          inspect(value);
        }
      };
      inspect(record);
      bytes += data.length;
      if (members.length >= 10000 || bytes > 67108864)
        throw new Error("State migration budget");
      members.push({ path: rel, bytes: data.length, sha256: hash(data) });
    }
  };
  walk(from, "");
  if (!members.length) throw new Error("No supported configuration to migrate");
  const payload = { format: 1, source: from, destination: to, members };
  return {
    ok: true,
    ...payload,
    confirmation: hash(JSON.stringify(payload)),
    excluded,
    credentials_copied: false,
    requires_unlock_again: true,
    source_unchanged: true,
  };
}
export function migrateState(source, destination, confirmation) {
  const plan = stateMigrationPreview(source, destination);
  if (confirmation !== plan.confirmation)
    throw new Error("State migration preview changed or confirmation missing");
  const staging = path.join(
    path.dirname(plan.destination),
    ".moonrestore-state-" + randomUUID(),
  );
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const member of plan.members) {
      const data = readPrivate(
        checked(path.join(plan.source, member.path)),
        1048576,
      );
      if (hash(data) !== member.sha256)
        throw new Error("Configuration changed during migration");
      const target = path.join(staging, member.path);
      mkdirPrivate(path.dirname(target));
      writePrivate(target, data);
    }
    if (
      stateMigrationPreview(source, destination).confirmation !== confirmation
    )
      throw new Error("State source changed before commit");
    publishDirectory(staging, plan.destination);
    return {
      ok: true,
      destination: plan.destination,
      files: plan.members.length,
      credentials_copied: false,
      requires_unlock_again: true,
      source_unchanged: true,
      active_state_changed: false,
    };
  } finally {
    if (fs.existsSync(staging)) {
      const exact = path.resolve(staging);
      if (
        path.dirname(exact) !== path.dirname(plan.destination) ||
        !path.basename(exact).startsWith(".moonrestore-state-")
      )
        throw new Error("Unsafe state staging cleanup");
      fs.rmSync(exact, { recursive: true, force: true });
    }
  }
}
export function stateCommand(args) {
  const [c, ...rest] = args;
  if (!["state-status", "state-migrate-preview", "state-migrate"].includes(c))
    return null;
  const { positionals: p, values: v } = options(rest, ["confirm"]);
  if (c === "state-status" && !p.length && !Object.keys(v).length)
    return stateLocation();
  if (c === "state-migrate-preview" && p.length === 2 && !Object.keys(v).length)
    return stateMigrationPreview(...p);
  if (c === "state-migrate" && p.length === 2 && Object.keys(v).length === 1)
    return migrateState(...p, v.confirm);
  throw new Error("Invalid state command");
}
