// Application orchestration: invokes the MoonBit CLI for all snapshot decisions.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Host } from "./adapter.mjs";
import {
  checked,
  readPrivate,
  writePrivate,
  mkdirPrivate,
  stateHome,
  rememberKey,
} from "./vault.mjs";
import { activity, checkpoint, credentials } from "./activity.mjs";

export const cli = fileURLToPath(
  new URL("../bin/moonrestore.mjs", import.meta.url),
);
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid snapshot ID");
  return value;
};
const integer = (value, min, max) => {
  if (
    !/^(0|[1-9][0-9]*)$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error("Integer out of bounds");
  return Number(value);
};
export function options(args, allowed, flags = []) {
  const values = {},
    positionals = [];
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const key = a.slice(2);
    if (
      !allowed.includes(key) ||
      (key in values && key !== "exclude" && key !== "protect")
    )
      throw new Error("Unknown/duplicate option");
    if (flags.includes(key)) values[key] = true;
    else {
      if (n + 1 === args.length || args[n + 1].startsWith("--"))
        throw new Error("Option requires a value");
      const v = args[++n];
      if (key === "exclude" || key === "protect") (values[key] ??= []).push(v);
      else values[key] = v;
    }
  }
  return { values, positionals };
}
export function core(
  args,
  { env = {}, allowFailure = false, timeout, signal } = {},
) {
  const context = activity();
  signal ??= context?.signal;
  timeout ??= context?.budgetMs ?? 1800000;
  checkpoint(args[0]);
  if (signal?.aborted) return Promise.reject(new Error("Operation cancelled"));
  return new Promise((resolve, reject) => {
    const directory = mkdirPrivate(path.join(stateHome(), "control")),
      control = path.join(directory, randomUUID() + ".json");
    writePrivate(control, "{}");
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        ...credentials(args[1]),
        ...env,
        MOONRESTORE_INTERNAL: "1",
        MOONRESTORE_PROGRESS: "1",
        MOONRESTORE_CONTROL: control,
      },
      shell: false,
      windowsHide: true,
    });
    let out = "",
      err = "",
      diagnostic = "",
      size = 0,
      finished = false,
      killTimer,
      interrupted = false,
      lastActivity = Date.now();
    const cancel = () => {
      if (finished || interrupted) return;
      interrupted = true;
      try {
        fs.writeFileSync(control, '{"cancel":true}');
      } catch {
        child.kill();
        return;
      }
      killTimer = setTimeout(() => child.kill(), 10000);
    };
    const timer = setTimeout(cancel, timeout),
      idle = setInterval(() => {
        if (Date.now() - lastActivity > 180000) cancel();
      }, 10000);
    signal?.addEventListener("abort", cancel, { once: true });
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearInterval(idle);
      signal?.removeEventListener("abort", cancel);
      try {
        fs.unlinkSync(control);
      } catch {}
      error ? reject(error) : resolve(result);
    };
    child.stdout.on("data", (data) => {
      size += data.length;
      if (size > 40 * 1024 * 1024) {
        child.kill();
        done(new Error("Core output budget exceeded"));
      } else out += data;
    });
    child.stderr.on("data", (data) => {
      lastActivity = Date.now();
      err += data;
      let newline;
      while ((newline = err.indexOf("\n")) >= 0) {
        const line = err.slice(0, newline);
        err = err.slice(newline + 1);
        if (line.startsWith("MR_PROGRESS:")) {
          try {
            context?.progress?.(JSON.parse(line.slice(12)));
          } catch {}
        } else if (diagnostic.length < 8192) diagnostic += line;
      }
      if (err.length > 262144) err = "";
    });
    child.on("error", (e) => done(e));
    child.on("close", (code) => {
      try {
        if (interrupted)
          throw new Error("Core operation cancelled or exceeded its budget");
        if (code !== 0 && !out.trim()) {
          const reason = /Source.*chang|Source.*grew/i.test(diagnostic)
            ? "源文件正在变化，请关闭写入程序后重试。"
            : /unlock|password|key unavailable/i.test(diagnostic)
              ? "仓库未解锁或密钥不可用。"
              : /locked|lock owner/i.test(diagnostic)
                ? "仓库被占用；确认原进程结束后再恢复锁。"
                : /ENOSPC|space/i.test(diagnostic)
                  ? "可用空间不足。"
                  : /EACCES|EPERM|permission/i.test(diagnostic)
                    ? "文件权限不足或文件被占用。"
                    : /corrupt|mismatch|SHA-256/i.test(diagnostic)
                      ? "完整性检查未通过，请保留原资料并检查副本。"
                      : "核心操作拒绝执行，请检查路径、仓库状态和本机 CLI 诊断。";
          throw new Error(reason);
        }
        const result = JSON.parse(out.trim());
        if (code !== 0 && !allowFailure)
          throw new Error(
            "Core operation rejected; inspect a private audit report",
          );
        done(null, result);
      } catch (e) {
        done(
          new Error(code === null ? "Core operation interrupted" : e.message),
        );
      }
    });
    if (signal?.aborted) cancel();
  });
}
export function openHost(repository, extra = {}) {
  const host = new Host({
    environment: { ...process.env, ...credentials(repository) },
    ...extra,
  });
  try {
    host.operation("open", { path: repository });
    return host;
  } catch (e) {
    host.clean();
    throw e;
  }
}
export function fingerprint(repository) {
  const root = checked(repository),
    dir = checked(path.join(root, "snapshots"));
  const names = fs.readdirSync(dir).sort();
  if (names.length > 100000) throw new Error("Snapshot budget exceeded");
  const state = createHash("sha256");
  state.update(readPrivate(path.join(root, "moonrestore"), 128));
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name))
      throw new Error("Unexpected snapshot");
    state.update(name);
    state.update(readPrivate(path.join(dir, name), 33554496));
  }
  return state.digest("hex");
}
function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
export function saveReport(
  report,
  { directory = path.join(stateHome(), "reports"), details = false } = {},
) {
  mkdirPrivate(directory);
  const copy = structuredClone(report);
  if (!details)
    for (const s of copy.audit?.snapshots ?? [])
      for (const issue of s.issues ?? []) delete issue.path;
  copy.redacted = !details;
  const base = path.join(
    directory,
    `report-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
  );
  const json = JSON.stringify(copy, null, 2);
  writePrivate(base + ".json", json);
  writePrivate(
    base + ".html",
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>MoonRestore 校验记录</title><style>body{font:16px/1.7 system-ui;max-width:960px;margin:48px auto;padding:0 24px;color:#17212b;background:#f5f7fa}h1{font-size:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;background:white;border:1px solid #d7dee7;border-radius:12px}</style><h1>MoonRestore ${copy.ok ? "本次检查通过" : "本次检查未通过"}</h1><p>这是指定时间与范围的受控检查，不保证未来恢复，也不替代异地备份。</p><pre>${escape(json)}</pre></html>`,
  );
  return { json: base + ".json", html: base + ".html" };
}
export async function health(
  repository,
  selection = "all",
  { directory, details = false, env = {} } = {},
) {
  if (selection !== "all") id(selection);
  const started = new Date().toISOString();
  let audit;
  try {
    audit = await core(["audit", repository, selection], {
      env,
      allowFailure: true,
    });
  } catch {
    audit = {
      ok: false,
      scope: "not_completed",
      snapshots: [],
      error: "repository_unavailable_or_core_rejected",
    };
  }
  const report = {
    format: 1,
    tool: "MoonRestore",
    version: "0.3.0",
    kind: "integrity",
    started,
    finished: new Date().toISOString(),
    ok: audit.ok === true,
    audit,
    real_user_pilot: false,
  };
  return { ...report, files: saveReport(report, { directory, details }) };
}
export function removeOwned(directory, parent, prefix) {
  const full = path.resolve(directory),
    base = checked(parent);
  if (
    path.dirname(full) !== base ||
    !path.basename(full).startsWith(prefix) ||
    fs.lstatSync(full).isSymbolicLink()
  )
    throw new Error("Refusing unsafe cleanup");
  checked(full);
  fs.rmSync(full, { recursive: true, force: false });
}
export async function drill(
  repository,
  snapshot,
  {
    parent = fs.realpathSync(os.tmpdir()),
    prefix = "",
    directory,
    env = {},
  } = {},
) {
  id(snapshot);
  parent = checked(parent);
  const owned = fs.mkdtempSync(path.join(parent, "moonrestore-drill-"));
  const target = path.join(owned, "restored");
  const report = {
    format: 1,
    version: "0.3.0",
    kind: "restore_drill",
    snapshot,
    started: new Date().toISOString(),
    scope: prefix ? "selected_subtree" : "full_snapshot",
    ok: false,
    real_user_pilot: false,
  };
  try {
    const catalog = await core(["catalog", repository, snapshot], { env });
    const selected = catalog.entries.filter(
      (e) =>
        !prefix ||
        e.path === prefix ||
        e.path.startsWith(prefix + "/") ||
        (e.kind === "dir" && prefix.startsWith(e.path + "/")),
    );
    const required = selected.reduce((n, e) => n + BigInt(e.size), 0n),
      s = fs.statfsSync(parent, { bigint: true });
    if (required > s.bavail * s.bsize)
      throw new Error("Insufficient drill space");
    await core(
      [
        "restore",
        repository,
        snapshot,
        target,
        ...(prefix ? ["--prefix", prefix] : []),
      ],
      { env },
    );
    let files = 0,
      bytes = 0n;
    for (const entry of selected)
      if (entry.kind === "file") {
        const file = checked(path.join(target, ...entry.path.split("/"))),
          st = fs.lstatSync(file);
        if (
          !st.isFile() ||
          st.nlink !== 1 ||
          BigInt(st.size) !== BigInt(entry.size)
        )
          throw new Error("Restored file metadata mismatch");
        const digest = createHash("sha256"),
          fd = fs.openSync(file, "r"),
          buffer = Buffer.alloc(65536);
        let count;
        try {
          while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
            digest.update(buffer.subarray(0, count));
        } finally {
          fs.closeSync(fd);
        }
        if (digest.digest("hex") !== entry.hash)
          throw new Error("Post-restore disk hash mismatch");
        files++;
        bytes += BigInt(entry.size);
      }
    report.ok = true;
    report.restored_files = files;
    report.rechecked_bytes = String(bytes);
    report.post_restore_readback = true;
  } catch {
    report.error = "restore_or_readback_failed";
  } finally {
    report.finished = new Date().toISOString();
    try {
      removeOwned(owned, parent, "moonrestore-drill-");
      report.temporary_cleanup = true;
    } catch {
      report.temporary_cleanup = false;
      report.ok = false;
      report.error = "temporary_cleanup_failed";
    }
  }
  return { ...report, files: saveReport(report, { directory }) };
}
export async function capacity(
  repository,
  source,
  { reserve = "268435456", restore, excludes = [] } = {},
) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(String(reserve)))
    throw new Error("Invalid reserve");
  const plan = restore
    ? null
    : await core([
        "plan",
        repository,
        source,
        ...excludes.flatMap((x) => ["--exclude", x]),
      ]);
  const required = restore
    ? BigInt(
        (await core(["catalog", repository, id(restore)])).entries.reduce(
          (n, e) => n + BigInt(e.size),
          0n,
        ),
      )
    : BigInt(plan.logical_bytes);
  const location = checked(restore ? source : repository),
    stats = fs.statfsSync(location, { bigint: true }),
    free = stats.bavail * stats.bsize,
    reserved = BigInt(reserve);
  const estimatedObjects = restore
    ? 0n
    : required / 8192n + BigInt(plan.entries) + 1n;
  const encrypted = readPrivate(
    path.join(checked(repository), "moonrestore"),
    128,
  )
    .toString()
    .includes("encrypted");
  const conservative =
    required +
    33554496n +
    estimatedObjects * (stats.bsize + (encrypted ? 64n : 0n));
  const assessment = await core([
    "capacity-state",
    String(conservative),
    String(free),
    String(reserved),
  ]);
  return {
    ok: assessment.state === 0,
    kind: "capacity",
    required_logical_bytes: String(required),
    conservative_required_bytes: String(conservative),
    available_bytes: String(free),
    reserve_bytes: String(reserved),
    prediction: "conservative_default_chunks_estimate_not_a_reservation",
    warning:
      free < conservative
        ? "insufficient_space"
        : free < conservative + reserved
          ? "below_reserve"
          : null,
    plan,
  };
}
export async function validatedInventory(repository, env = {}) {
  const before = fingerprint(repository),
    audit = await core(["audit", repository, "all"], {
      env,
      allowFailure: true,
    });
  if (!audit.ok) throw new Error("Full audit must pass before maintenance");
  const listed = await core(["list", repository], { env });
  const snapshots = [];
  let metadataBytes = 0;
  for (const s of listed.snapshots) {
    const model = await core(["catalog", repository, s.id], { env });
    metadataBytes += Buffer.byteLength(JSON.stringify(model));
    if (metadataBytes > 67108864)
      throw new Error(
        "Maintenance manifest budget exceeded (64 MiB); split the dataset",
      );
    snapshots.push({ id: s.id, model });
  }
  if (before !== fingerprint(repository))
    throw new Error("Repository changed during planning");
  return { before, snapshots };
}
export async function replicate(
  repository,
  destination,
  { encrypted = false } = {},
) {
  const source = checked(repository),
    dest = path.resolve(destination);
  const canonical = (v) => (process.platform === "win32" ? v.toLowerCase() : v);
  if (
    canonical(source) === canonical(dest) ||
    canonical(dest).startsWith(canonical(source) + path.sep) ||
    canonical(source).startsWith(canonical(dest) + path.sep)
  )
    throw new Error("Overlapping repositories");
  const inventory = await validatedInventory(source),
    large = inventory.snapshots.some((s) => s.model.format === 3),
    destinationCredentials = credentials(dest),
    environment = {
      ...process.env,
      ...destinationCredentials,
      MOONRESTORE_PASSWORD:
        process.env.MOONRESTORE_DEST_PASSWORD ||
        destinationCredentials.MOONRESTORE_PASSWORD ||
        "",
      MOONRESTORE_KEY_FILE:
        process.env.MOONRESTORE_DEST_KEY_FILE ||
        destinationCredentials.MOONRESTORE_KEY_FILE ||
        "",
      MOONRESTORE_INIT_ENCRYPTED: encrypted ? "1" : "0",
      MOONRESTORE_INIT_LARGE: large ? "1" : "0",
    };
  if (!fs.existsSync(dest)) {
    const init = new Host({ environment });
    try {
      init.operation("init", { path: dest });
    } finally {
      init.clean();
    }
  }
  const from = openHost(source);
  let to,
    objects = 0,
    snapshots = 0;
  try {
    to = openHost(dest, { environment });
    if (large && to.profile !== 3)
      throw new Error(
        "Format 3 snapshots require a new/compatible large-profile destination",
      );
    from.lock();
    to.lock();
    if (fingerprint(source) !== inventory.before)
      throw new Error("Source changed after audit");
    const present = new Set(to.operation("list", null)),
      verifiedObjects = new Map();
    for (const snap of inventory.snapshots) {
      for (const entry of snap.model.entries)
        for (const part of entry.chunks) {
          checkpoint("replicate", {
            copied_objects: objects,
            copied_snapshots: snapshots,
          });
          if (verifiedObjects.has(part.id)) {
            if (verifiedObjects.get(part.id) !== part.size)
              throw new Error("Conflicting copy chunk sizes");
            continue;
          }
          const bytes = from.readStored("object", part.id);
          if (bytes.length !== part.size || hash(bytes) !== part.id)
            throw new Error("Copy integrity mismatch");
          const result = to.store(part.id, bytes);
          if (
            !result.created &&
            (to.bytes.length !== bytes.length || hash(to.bytes) !== part.id)
          )
            throw new Error("Destination object corrupted");
          if (result.created) objects++;
          verifiedObjects.set(part.id, part.size);
          await new Promise((resolve) => setImmediate(resolve));
        }
      const bytes = from.readStored("manifest", snap.id);
      if (hash(bytes) !== snap.id) throw new Error("Manifest mismatch");
      if (present.has(snap.id)) {
        if (!to.readStored("manifest", snap.id).equals(bytes))
          throw new Error("Destination snapshot mismatch");
      } else {
        to.operation("commit", { id: snap.id }, bytes);
        snapshots++;
      }
    }
  } finally {
    from.clean();
    to?.clean();
  }
  const checkedCopy = await core(["audit", dest, "all"], {
    env: environment,
    allowFailure: true,
  });
  return {
    ok: checkedCopy.ok,
    kind: "replica",
    copied_objects: objects,
    copied_snapshots: snapshots,
    destination_audited: true,
    deletions_propagated: false,
    independent_physical_device_verified: false,
  };
}
export function repositoryIdentity(repository) {
  const root = checked(repository),
    file = path.join(root, "repository-id");
  if (!fs.existsSync(file)) {
    const host = openHost(root);
    try {
      host.lock();
      if (!fs.existsSync(file)) writePrivate(file, randomUUID());
    } finally {
      host.clean();
    }
  }
  const value = readPrivate(file, 64).toString();
  if (!/^[a-f0-9-]{36}$/.test(value))
    throw new Error("Invalid repository identity");
  return value;
}
export async function advanced(args) {
  const command = args[0],
    rest = args.slice(1);
  if (
    ![
      "report",
      "drill",
      "capacity",
      "replicate",
      "key-export",
      "key-store",
      "init-encrypted",
      "init-large",
    ].includes(command)
  )
    return null;
  const { values: v, positionals: p } = options(
    rest,
    [
      "output",
      "details",
      "parent",
      "prefix",
      "reserve-bytes",
      "restore",
      "encrypted",
    ],
    ["details", "encrypted"],
  );
  if (command === "init-encrypted") {
    if (p.length !== 1 || Object.keys(v).length)
      throw new Error("Usage: init-encrypted NEW-repository");
    return core(["init", p[0]], {
      env: { MOONRESTORE_INIT_ENCRYPTED: "1", MOONRESTORE_INIT_LARGE: "0" },
    });
  }
  if (command === "init-large") {
    if (p.length !== 1 || Object.keys(v).some((k) => k !== "encrypted"))
      throw new Error("Usage: init-large NEW-repository [--encrypted]");
    return core(["init", p[0]], {
      env: {
        MOONRESTORE_INIT_LARGE: "1",
        MOONRESTORE_INIT_ENCRYPTED: v.encrypted ? "1" : "0",
      },
    });
  }
  if (command === "report") {
    if (
      p.length < 1 ||
      p.length > 2 ||
      Object.keys(v).some((k) => !["output", "details"].includes(k))
    )
      throw new Error(
        "Usage: report repository [id|all] [--output directory] [--details]",
      );
    return health(p[0], p[1] || "all", {
      directory: v.output,
      details: v.details,
    });
  }
  if (command === "drill") {
    if (
      p.length !== 2 ||
      Object.keys(v).some((k) => !["output", "parent", "prefix"].includes(k))
    )
      throw new Error(
        "Usage: drill repository id [--parent directory] [--prefix relative]",
      );
    return drill(p[0], p[1], {
      directory: v.output,
      parent: v.parent,
      prefix: v.prefix,
    });
  }
  if (command === "capacity") {
    if (
      p.length !== 2 ||
      Object.keys(v).some((k) => !["reserve-bytes", "restore"].includes(k))
    )
      throw new Error("Usage: capacity repository source [--reserve-bytes N]");
    return capacity(p[0], p[1], {
      reserve: v["reserve-bytes"],
      restore: v.restore,
    });
  }
  if (command === "replicate") {
    if (p.length !== 2 || Object.keys(v).some((k) => k !== "encrypted"))
      throw new Error(
        "Usage: replicate repository NEW-or-existing-destination [--encrypted]",
      );
    return replicate(p[0], p[1], { encrypted: v.encrypted });
  }
  if (command === "key-export" || command === "key-store") {
    if (
      p.length !== 1 ||
      Object.keys(v).some((k) => command !== "key-export" || k !== "output") ||
      (command === "key-export" && !v.output)
    )
      throw new Error(
        "Usage: key-export repository --output NEW-private-file | key-store repository",
      );
    const host = openHost(p[0]);
    try {
      if (!host.key) throw new Error("Repository is not encrypted");
      if (command === "key-store")
        return {
          ok: true,
          stored_for_current_windows_user: true,
          file: rememberKey(host.vault, host.key),
        };
      const output = path.resolve(v.output),
        canonical = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
      if (canonical(output).startsWith(canonical(host.repo) + path.sep))
        throw new Error("Recovery key must be stored outside its repository");
      let ancestor = path.dirname(output);
      while (path.dirname(ancestor) !== ancestor) {
        if (
          fs.existsSync(path.join(ancestor, ".git")) &&
          !canonical(output).startsWith(
            canonical(path.join(ancestor, ".local")) + path.sep,
          )
        )
          throw new Error(
            "Recovery key cannot be exported into a source checkout outside .local",
          );
        ancestor = path.dirname(ancestor);
      }
      writePrivate(
        output,
        JSON.stringify({
          format: 1,
          repository: host.vault.id,
          key: host.key.toString("hex"),
        }),
      );
      return {
        ok: true,
        recovery_key_file: path.resolve(v.output),
        sensitive: true,
        keep_separate_from_repository: true,
      };
    } finally {
      host.clean();
    }
  }
}
