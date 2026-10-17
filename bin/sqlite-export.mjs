// Private worker: no SQL supplied by callers, no extension loading or shell.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { checked } from "../platform/vault.mjs";
try {
  const { DatabaseSync, backup } = await import("node:sqlite");
  if (typeof backup !== "function") throw new Error("Node >=22.16 required");
  const source = checked(process.argv[2]),
    destination = checked(process.argv[3], false);
  if (fs.existsSync(destination)) throw new Error("Destination must be new");
  const input = new DatabaseSync(source, {
    readOnly: true,
    allowExtension: false,
    timeout: 2000,
  });
  try {
    input.exec("PRAGMA trusted_schema=OFF");
    await backup(input, destination, {
      rate: 32,
      progress: ({ totalPages, remainingPages }) => {
        process.stderr.write(
          "MR_SQLITE:" +
            JSON.stringify({
              phase: "sqlite_online_export",
              total_pages: totalPages,
              remaining_pages: remainingPages,
            }) +
            "\n",
        );
      },
    });
  } finally {
    input.close();
  }
  const output = new DatabaseSync(destination, {
    readOnly: true,
    allowExtension: false,
  });
  try {
    output.exec("PRAGMA trusted_schema=OFF");
    const checks = output.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || Object.values(checks[0])[0] !== "ok")
      throw new Error("Export integrity check failed");
  } finally {
    output.close();
  }
  const fd = fs.openSync(destination, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.alloc(65536);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  console.log(
    JSON.stringify({
      ok: true,
      kind: "sqlite_online_export",
      sqlite_integrity_checked: true,
      bytes: String(fs.statSync(destination).size),
      hash: digest.digest("hex"),
    }),
  );
} catch {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        "SQLite online export rejected; Node >=22.16 and a valid accessible database are required",
    }),
  );
  process.exitCode = 1;
}
