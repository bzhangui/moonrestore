// Offline recipe + independently checked runtime. Never embeds a repository,
// password, recovery key, original source path or the user's old state directory.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  checked,
  readPrivate,
  writePrivate,
  mkdirPrivate,
  stateHome,
} from "./vault.mjs";
import { core, openHost, options } from "./maintenance.mjs";
import { credentials, checkpoint, activity } from "./activity.mjs";
import { verifyDistribution, sha256 } from "./distribution.mjs";
import { atomicPrivate } from "./journal.mjs";
const digest = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
function identity(repository) {
  const magic = readPrivate(
      path.join(checked(repository), "moonrestore"),
      128,
    ).toString(),
    encryption = path.join(repository, "encryption.json");
  return {
    magic,
    encryption_sha256: fs.existsSync(encryption)
      ? sha256(readPrivate(encryption, 8192))
      : null,
  };
}
export async function createRescueKit(
  repository,
  snapshot,
  bundle,
  expectedManifest,
  destination,
) {
  if (!digest(snapshot) || !digest(expectedManifest))
    throw new Error("Exact snapshot and trusted bundle hash required");
  const verified = verifyDistribution(bundle, expectedManifest);
  await core(["verify", repository, snapshot], {
    env: { MOONRESTORE_READ_ONLY: "1" },
  });
  const dir = checked(destination, false),
    rel = path.relative(checked(repository), dir);
  if (
    !rel ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  )
    throw new Error("Rescue kit must be separate from the repository");
  checked(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const name of [
    ...Object.keys(verified.manifest.files),
    "manifest.json",
  ]) {
    const to = path.join(dir, ...name.split("/"));
    mkdirPrivate(path.dirname(to));
    fs.copyFileSync(
      checked(path.join(bundle, ...name.split("/"))),
      to,
      fs.constants.COPYFILE_EXCL,
    );
    if (process.platform !== "win32")
      fs.chmodSync(
        to,
        fs.statSync(path.join(bundle, ...name.split("/"))).mode & 0o777,
      );
  }
  verifyDistribution(dir, expectedManifest);
  const recipe = Buffer.from(
    JSON.stringify({
      format: 1,
      kind: "moonrestore-offline-rescue",
      snapshot,
      repository: identity(repository),
      bundle_manifest_sha256: expectedManifest,
      created: new Date().toISOString(),
    }),
  );
  writePrivate(path.join(dir, "recovery.json"), recipe); // Commit record last.
  writePrivate(
    path.join(dir, "RESCUE.txt"),
    "MoonRestore offline rescue\nKeep this recipe hash in an independent trusted place. Keep recovery keys separate.\nUse: node bin/moonrestore.mjs rescue-check KIT RECIPE_HASH REPOSITORY\nThen: node bin/moonrestore.mjs rescue-restore KIT RECIPE_HASH REPOSITORY NEW_TARGET\nNo full-system image, cloud, physical-device or publisher-signature guarantee.\n",
  );
  return {
    ok: true,
    kind: "offline_rescue_kit",
    recipe_sha256: sha256(recipe),
    snapshot,
    key_included: false,
    repository_included: false,
    original_state_required: false,
    embedded_runtime: !!verified.manifest.files["runtime/node.exe"],
    runtime_requirement: verified.manifest.files["runtime/node.exe"]
      ? "Windows x64 embedded Node"
      : "compatible external Node >=22.16 and same-platform native helper",
  };
}
export function checkRescueKit(kit, expectedRecipe, repository) {
  if (!digest(expectedRecipe))
    throw new Error("Independently trusted recipe hash required");
  const bytes = readPrivate(path.join(checked(kit), "recovery.json"), 16384);
  if (sha256(bytes) !== expectedRecipe)
    throw new Error("Trusted rescue recipe hash mismatch");
  const r = JSON.parse(bytes),
    current = identity(repository);
  if (
    r.format !== 1 ||
    r.kind !== "moonrestore-offline-rescue" ||
    !digest(r.snapshot) ||
    !r.repository ||
    r.repository.magic !== current.magic ||
    r.repository.encryption_sha256 !== current.encryption_sha256 ||
    !digest(r.bundle_manifest_sha256)
  )
    throw new Error("Rescue repository identity/config mismatch");
  const v = verifyDistribution(kit, r.bundle_manifest_sha256);
  if (
    v.manifest.platform !== process.platform ||
    v.manifest.arch !== process.arch
  )
    throw new Error("Rescue runtime platform/architecture mismatch");
  return {
    ok: true,
    snapshot: r.snapshot,
    bundle_verified: true,
    content_verified: false,
    key_included: false,
    original_state_required: false,
  };
}
export async function restoreWithRescueKit(
  kit,
  expectedRecipe,
  repository,
  target,
) {
  const check = checkRescueKit(kit, expectedRecipe, repository),
    dest = checked(target, false);
  if (fs.existsSync(dest)) throw new Error("Rescue target must not exist");
  // Fresh state proves that no old jobs, indexes, DPAPI registration or journal is needed.
  const home = fs.mkdtempSync(
      path.join(
        mkdirPrivate(path.join(stateHome(), "rescue-sessions")),
        "session-",
      ),
    ),
    executable = fs.existsSync(path.join(kit, "runtime", "node.exe"))
      ? path.join(kit, "runtime", "node.exe")
      : process.execPath,
    environment = {
      ...process.env,
      ...credentials(repository),
      MOONRESTORE_HOME: home,
    };
  // Never allow inherited internal/fault-injection switches to change the verified command.
  for (const k of Object.keys(environment))
    if (
      k.startsWith("MOONRESTORE_") &&
      ![
        "MOONRESTORE_HOME",
        "MOONRESTORE_PASSWORD",
        "MOONRESTORE_KEY_FILE",
      ].includes(k)
    )
      delete environment[k];
  const result = await new Promise((resolve, reject) => {
    const signal = activity()?.signal;
    if (signal?.aborted) {
      reject(new Error("Rescue operation cancelled"));
      return;
    }
    const control = path.join(
      mkdirPrivate(path.join(home, "control")),
      "parent-control-" + randomUUID() + ".json",
    );
    writePrivate(
      control,
      JSON.stringify({ cancel: false, parent_pid: process.pid }),
    );
    const child = spawn(
      executable,
      [
        path.join(kit, "bin", "moonrestore.mjs"),
        "restore-resumable",
        repository,
        check.snapshot,
        dest,
      ],
      {
        cwd: kit,
        env: { ...environment, MOONRESTORE_PARENT_CONTROL: control },
        shell: false,
        windowsHide: true,
      },
    );
    let out = "",
      used = 0,
      interrupted = false,
      killTimer;
    const cancel = () => {
      if (interrupted) return;
      interrupted = true;
      try {
        atomicPrivate(
          control,
          Buffer.from(
            JSON.stringify({ cancel: true, parent_pid: process.pid }),
          ),
        );
      } catch {
        // If atomic replacement fails (e.g. disk full), remove only our exact
        // control file. Both coordinator and worker treat a missing file as cancel.
        try {
          fs.unlinkSync(checked(control));
        } catch {
          /* Worker also checks its coordinator PID. */
        }
      }
      killTimer = setTimeout(() => child.kill(), 15000);
    };
    const timer = setTimeout(cancel, 1800000);
    signal?.addEventListener("abort", cancel, { once: true });
    const clean = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      try {
        if (fs.existsSync(control)) fs.unlinkSync(checked(control));
      } catch {
        /* Private session is retained for diagnosis, never mask child exit. */
      }
    };
    child.stdout.on("data", (b) => {
      used += b.length;
      if (used > 1048576) cancel();
      else out += b;
    });
    child.stderr.on("data", (b) => {
      used += b.length;
      if (used > 1048576) cancel();
    });
    child.once("error", () => {
      clean();
      reject(new Error("Rescue runtime failed; private state retained"));
    });
    child.once("close", (code) => {
      clean();
      try {
        if (interrupted || code !== 0 || used > 1048576) throw new Error();
        const r = JSON.parse(out);
        if (r.ok !== true || r.state !== "completed") throw new Error();
        resolve(r);
      } catch {
        reject(
          new Error(
            "Rescue restore incomplete; inspect private session and leave source unchanged",
          ),
        );
      }
    });
  });
  checkpoint("offline_rescue_complete");
  return {
    ok: true,
    snapshot: check.snapshot,
    state: result.state,
    original_state_required: false,
    post_restore_readback: true,
    private_session_retained: true,
    cross_host_verified: false,
  };
}
export async function rescueKitCommand(args) {
  const [c, ...a] = args;
  if (!["rescue-kit", "rescue-check", "rescue-restore"].includes(c))
    return null;
  const { positionals: p, values: v } = options(a, ["bundle", "bundle-sha256"]);
  if (c === "rescue-kit" && p.length === 3 && Object.keys(v).length === 2)
    return createRescueKit(p[0], p[1], v.bundle, v["bundle-sha256"], p[2]);
  if (
    Object.keys(v).length === 0 &&
    p.length === (c === "rescue-check" ? 3 : 4)
  )
    return c === "rescue-check"
      ? checkRescueKit(...p)
      : restoreWithRescueKit(...p);
  throw new Error("Invalid rescue kit command");
}
