// Explicit, process-owned VSS lifecycle; no elevation, service changes or fallback.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { checked, mkdirPrivate, stateHome, writePrivate } from "./vault.mjs";
import { checkpoint } from "./activity.mjs";
import { removeOwned, options } from "./maintenance.mjs";
const brands = new WeakSet(),
  guid = (v) => typeof v === "string" && /^\{[0-9a-f-]{36}\}$/i.test(v);
const defaultHelper = fileURLToPath(
  new URL("../.local/vss/MoonRestoreVss.exe", import.meta.url),
);
export function isNativeVssProvider(value) {
  return brands.has(value);
}
export function vssHelperAvailable() {
  return process.platform === "win32" && fs.existsSync(defaultHelper);
}
function copyPoint(source, target, { maxBytes, maxEntries }) {
  let bytes = 0,
    entries = 0;
  const initial = fs.lstatSync(source);
  if (!initial.isDirectory() || initial.isSymbolicLink())
    throw new Error("Invalid immutable source subtree");
  const visit = (from, to, depth) => {
    if (depth > 64) throw new Error("VSS staging depth exceeded");
    fs.mkdirSync(to, { mode: 0o700 });
    const directory = fs.opendirSync(from);
    try {
      for (let item = directory.readSync(); item; item = directory.readSync()) {
        checkpoint("vss_staging");
        if (
          ++entries > maxEntries ||
          /[\\/:]/.test(item.name) ||
          [".", ".."].includes(item.name)
        )
          throw new Error("VSS staging entry budget");
        const a = path.join(from, item.name),
          b = path.join(to, item.name),
          s = fs.lstatSync(a);
        if (s.isSymbolicLink())
          throw new Error("VSS subtree contains reparse link");
        if (s.isDirectory()) visit(a, b, depth + 1);
        else if (s.isFile() && s.nlink === 1) {
          bytes += s.size;
          if (bytes > maxBytes)
            throw new Error("VSS private plaintext staging budget");
          const input = fs.openSync(
              a,
              fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
            ),
            output = fs.openSync(b, "wx", 0o600),
            buffer = Buffer.alloc(65536);
          let copied = 0;
          try {
            const opened = fs.fstatSync(input);
            if (
              opened.dev !== s.dev ||
              opened.ino !== s.ino ||
              opened.size !== s.size ||
              opened.nlink !== 1
            )
              throw new Error("VSS source identity changed");
            while (true) {
              checkpoint("vss_staging_read");
              const n = fs.readSync(input, buffer, 0, buffer.length, null);
              if (!n) break;
              copied += n;
              if (copied > s.size) throw new Error("VSS source grew");
              let at = 0;
              while (at < n) {
                const wrote = fs.writeSync(output, buffer, at, n - at);
                if (!wrote) throw new Error("VSS staging write failed");
                at += wrote;
              }
            }
            if (copied !== s.size) throw new Error("VSS staging truncated");
            fs.fsyncSync(output);
          } finally {
            fs.closeSync(input);
            fs.closeSync(output);
          }
          fs.utimesSync(b, s.atime, s.mtime);
        } else throw new Error("VSS special files or hardlinks unsupported");
      }
    } finally {
      directory.closeSync();
    }
  };
  visit(source, target, 0);
  return { bytes, entries };
}
export function requesterProcess(helper, source, onIntent) {
  const child = spawn(helper, [source], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "",
    used = 0,
    readyResolve,
    readyReject,
    closedResolve,
    readySeen = false,
    release,
    intent,
    invalid = false;
  const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    }),
    closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
  const timer = setTimeout(() => {
    child.stdin.end("abort\n");
  }, 19 * 60000);
  child.stdin.on("error", () => {});
  child.stderr.on("data", (b) => {
    used += b.length;
    if (used > 65536) child.stdin.end("abort\n");
  });
  child.stdout.on("data", (bytes) => {
    used += bytes.length;
    if (used > 65536) {
      child.stdin.end("abort\n");
      readyReject(new Error("VSS protocol output exceeded budget"));
      return;
    }
    buffer += bytes.toString("utf8");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const r = JSON.parse(line);
        if (r.phase === "intent") {
          if (intent || !guid(r.set))
            throw new Error("Invalid VSS set identity");
          intent = r.set;
          onIntent(r);
        } else if (r.phase === "ready") {
          if (
            readySeen ||
            r.set !== intent ||
            !guid(r.set) ||
            !guid(r.snapshot) ||
            !/^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$/i.test(
              r.device,
            ) ||
            !path.win32.isAbsolute(r.mount) ||
            !Number.isSafeInteger(r.writers) ||
            r.writers < 1
          )
            throw new Error("Invalid VSS ready response");
          readySeen = true;
          readyResolve(r);
        } else if (r.phase === "released") release = r;
        else throw new Error("Unknown VSS phase");
      } catch {
        invalid = true;
        child.stdin.end("abort\n");
        readyReject(new Error("Invalid VSS requester protocol"));
      }
    }
  });
  child.on("error", () =>
    readyReject(new Error("VSS requester could not start")),
  );
  child.on("close", (code) => {
    clearTimeout(timer);
    if (!readySeen)
      readyReject(
        new Error("VSS requester failed before an immutable point was ready"),
      );
    closedResolve({ code, release });
  });
  return {
    ready,
    async finish(completed) {
      if (!child.stdin.writableEnded)
        child.stdin.end(completed ? "complete\n" : "abort\n");
      const r = await closed;
      if (
        invalid ||
        !r.release?.removed ||
        (completed && (r.code !== 0 || r.release.completed !== true))
      )
        throw new Error("VSS completion or exact resource release unconfirmed");
      return r.release;
    },
  };
}
export class NativeVssProvider {
  constructor({
    allowNative = false,
    helper = defaultHelper,
    maxBytes = 2147483648,
    maxEntries = 100000,
  } = {}) {
    if (!allowNative || process.platform !== "win32")
      throw new Error("Explicit native Windows VSS permission required");
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 1099511627776 ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 1000000
    )
      throw new Error("VSS staging budget");
    this.helper = checked(helper);
    if (!fs.lstatSync(this.helper).isFile())
      throw new Error("VSS helper must be a trusted regular executable");
    const probe = spawnSync(this.helper, ["--protocol"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 4096,
    });
    if (
      probe.status !== 0 ||
      JSON.parse(probe.stdout).kind !== "moonrestore_vss_requester"
    )
      throw new Error("Wrong VSS requester");
    this.kind = "windows_vss";
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.leases = new WeakMap();
    brands.add(this);
  }
  async create(source) {
    source = checked(source);
    if (!/^[A-Za-z]:\\/.test(source) || !fs.lstatSync(source).isDirectory())
      throw new Error("VSS local source directory required");
    const parent = mkdirPrivate(path.join(stateHome(), "vss-leases")),
      owned = fs.mkdtempSync(path.join(parent, "lease-")),
      record = path.join(owned, "intent.json"),
      material = path.join(owned, "material");
    const session = requesterProcess(this.helper, source, (intent) =>
      writePrivate(
        record,
        JSON.stringify({
          format: 1,
          local_id: path.basename(owned),
          ...intent,
        }),
      ),
    );
    try {
      const r = await session.ready,
        relative = path.win32.relative(r.mount, source);
      writePrivate(path.join(owned, "ready.json"), JSON.stringify(r));
      if (relative.startsWith("..") || path.win32.isAbsolute(relative))
        throw new Error("VSS volume does not contain the source");
      copyPoint(r.device + "\\" + relative, material, this);
      const lease = {
        id: randomUUID(),
        path: material,
        writersReady: true,
        writer_count: r.writers,
      };
      this.leases.set(lease, { session, owned, parent });
      return lease;
    } catch (error) {
      try {
        await session.finish(false);
        removeOwned(owned, parent, "lease-");
      } catch {
        throw new AggregateError(
          [error, new Error("Owned VSS lease retained for inspection")],
          "VSS staging and cleanup unconfirmed",
        );
      }
      throw error;
    }
  }
  async release(lease, { completed = false } = {}) {
    const owned = this.leases.get(lease);
    if (!owned) throw new Error("Not an owned VSS lease");
    await owned.session.finish(completed);
    removeOwned(owned.owned, owned.parent, "lease-");
    this.leases.delete(lease);
  }
}
export async function nativeVssCommand(args) {
  if (args[0] !== "vss-backup") return null;
  const { positionals: p, values: v } = options(
    args.slice(1),
    ["allow-native-vss", "max-bytes"],
    ["allow-native-vss"],
  );
  if (p.length !== 2 || v["allow-native-vss"] !== true)
    throw new Error(
      "vss-backup REPO SOURCE --allow-native-vss requires an already authorized administrator session",
    );
  const { backupWithSnapshotProvider } = await import(
    "./snapshot-provider.mjs"
  );
  return backupWithSnapshotProvider(
    ...p,
    new NativeVssProvider({
      allowNative: true,
      maxBytes:
        v["max-bytes"] === undefined ? 2147483648 : Number(v["max-bytes"]),
    }),
  );
}
