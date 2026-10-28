// Fake protocol transport only; never imports or invokes Windows VSS.
import { randomUUID } from "node:crypto";
const set = "{" + randomUUID() + "}",
  mode = process.env.MOONRESTORE_TEST_VSS_PROTOCOL;
console.log(JSON.stringify({ phase: "intent", set }));
console.log(
  JSON.stringify({
    phase: "ready",
    set: mode === "wrong-set" ? "{" + randomUUID() + "}" : set,
    snapshot: "{" + randomUUID() + "}",
    device: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy999999",
    mount: "C:\\",
    writers: mode === "no-writers" ? 0 : 1,
  }),
);
process.stdin.once("data", (bytes) => {
  const completed = bytes.toString().trim() === "complete";
  console.log(
    JSON.stringify({
      phase: "released",
      completed,
      removed: mode !== "cleanup-unknown",
      ok: completed,
    }),
  );
  process.exitCode = completed ? 0 : 1;
});
