// Temporary, owned synthetic dataset for actual browser QA. No personal files.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { core, removeOwned } from "../platform/maintenance.mjs";
import { mkdirPrivate, writePrivate } from "../platform/vault.mjs";
import { startWorkbench } from "../platform/workbench.mjs";
const parent = mkdirPrivate(
    fileURLToPath(new URL("../.local/", import.meta.url)),
  ),
  root = fs.mkdtempSync(path.join(parent, "ui-pilot-"));
process.env.MOONRESTORE_HOME = path.join(root, "state");
const source = path.join(root, "source"),
  repository = path.join(root, "vault");
fs.mkdirSync(source);
fs.writeFileSync(path.join(source, "paper.txt"), "Controlled first revision.");
await core(["init", repository]);
await core(["backup", repository, source, "--label", "受控初稿"]);
fs.writeFileSync(path.join(source, "paper.txt"), "Controlled second revision.");
fs.writeFileSync(path.join(source, "data.csv"), "a,b\n1,2\n");
const app = await startWorkbench({ port: 8790 });
writePrivate(
  path.join(root, "session.json"),
  JSON.stringify({
    url: app.url,
    origin: app.origin,
    source,
    repository,
    restore: path.join(root, "restored"),
    home: process.env.MOONRESTORE_HOME,
  }),
);
console.log(
  JSON.stringify({
    controlled_browser_pilot: true,
    session_file: path.join(root, "session.json"),
    origin: app.origin,
  }),
);
let stopped = false;
const stop = async () => {
  if (stopped) return;
  stopped = true;
  await app.close();
  removeOwned(root, parent, "ui-pilot-");
  process.stdin.pause();
  console.log(
    "Controlled browser fixture stopped; only its owned data was removed.",
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
// Test runners can stop their own fixture gracefully without killing unrelated servers.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.trim() === "stop") void stop();
});
