// Bounded probe uses only its own random directory; never touches caller files.
import fs from "node:fs";
import path from "node:path";
import { checked } from "./vault.mjs";
import { publishDirectory } from "./adapter.mjs";
import { newFile, syncDirectory } from "./paged-store.mjs";
export function storageCapabilities(
  directory,
  { minimumFreeBytes = 1048576 } = {},
) {
  const parent = checked(directory);
  if (
    !fs.lstatSync(parent).isDirectory() ||
    !Number.isSafeInteger(minimumFreeBytes) ||
    minimumFreeBytes < 0
  )
    throw new Error("Capability parent/free-space budget invalid");
  const disk = fs.statfsSync(parent, { bigint: true });
  if (disk.bavail * disk.bsize < BigInt(minimumFreeBytes))
    throw new Error("Storage free-space preflight failed");
  const owned = fs.mkdtempSync(path.join(parent, ".moonrestore-capability-"));
  let hardlinks = false,
    exclusive = false,
    publish = false,
    fileSync = false,
    directorySync = false;
  try {
    const a = path.join(owned, "a"),
      b = path.join(owned, "b");
    newFile(a, Buffer.from("synthetic capability probe"));
    fileSync = true;
    try {
      const unexpected = fs.openSync(a, "wx");
      fs.closeSync(unexpected);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      exclusive = true;
    }
    try {
      fs.linkSync(a, b);
      const x = fs.lstatSync(a, { bigint: true }),
        y = fs.lstatSync(b, { bigint: true });
      hardlinks =
        x.dev === y.dev && x.ino === y.ino && x.nlink === 2n && y.nlink === 2n;
    } catch (error) {
      if (
        ![
          "EPERM",
          "EACCES",
          "ENOTSUP",
          "EOPNOTSUPP",
          "ENOSYS",
          "EXDEV",
        ].includes(error.code)
      )
        throw error;
    }
    if (fs.existsSync(b)) fs.unlinkSync(b);
    const from = path.join(owned, "from"),
      to = path.join(owned, "to");
    fs.mkdirSync(from);
    publishDirectory(from, to);
    fs.mkdirSync(from);
    try {
      publishDirectory(from, to);
    } catch {
      publish = fs.existsSync(from) && fs.existsSync(to);
    }
    if (process.platform !== "win32") {
      syncDirectory(owned);
      directorySync = true;
    }
    return {
      ok: hardlinks && exclusive && publish && fileSync,
      kind: "storage_capabilities",
      conditional_hardlink_create: hardlinks,
      exclusive_file_create: exclusive,
      exclusive_directory_publish: publish,
      file_sync_requested: fileSync,
      directory_sync_requested: directorySync,
      hardware_power_loss_verified: false,
      network_filesystem_verified: false,
      free_bytes: String(disk.bavail * disk.bsize),
      physical_independence_verified: false,
    };
  } finally {
    const exact = checked(owned);
    if (
      path.dirname(exact) !== parent ||
      !path.basename(exact).startsWith(".moonrestore-capability-")
    )
      throw new Error("Unsafe probe cleanup");
    for (const name of fs.readdirSync(exact)) {
      const file = checked(path.join(exact, name)),
        s = fs.lstatSync(file);
      if (s.isFile()) fs.unlinkSync(file);
      else if (s.isDirectory() && fs.readdirSync(file).length === 0)
        fs.rmdirSync(file);
      else throw new Error("Unknown probe member retained");
    }
    fs.rmdirSync(exact);
  }
}
