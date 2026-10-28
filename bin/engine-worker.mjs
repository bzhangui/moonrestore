#!/usr/bin/env node
import { withParentControl, activity } from "../platform/activity.mjs";
import { engineAction } from "../platform/paged-service.mjs";
import { StringDecoder } from "node:string_decoder";
let text = "";
const decoder = new StringDecoder("utf8");
try {
  for await (const b of process.stdin) {
    text += decoder.write(b);
    if (Buffer.byteLength(text) > 65536) throw new Error("Worker input budget");
  }
  text += decoder.end();
  const request = JSON.parse(text);
  if (
    !request ||
    Object.keys(request).some((k) => !["action", "payload"].includes(k))
  )
    throw new Error("Worker schema");
  const result = await withParentControl(async () => {
    const context = activity();
    let last = 0;
    if (context)
      context.progress = (value) => {
        const now = Date.now();
        if (now - last > 500) {
          last = now;
          process.stderr.write("MR_PROGRESS:" + JSON.stringify(value) + "\n");
        }
      };
    return engineAction(request.action, request.payload);
  });
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
} catch (error) {
  const message = String(error.message),
    code = error.code ?? "ENGINE_REJECTED";
  const reason = /ENOSPC/.test(code + message)
    ? "Storage full; free space or use a NEW destination; original recovery points retained"
    : /EACCES|EPERM|EROFS/.test(code + message)
      ? "Storage permission or read-only media; no automatic elevation"
      : /ENOENT|ENODEV|ENXIO/.test(code + message)
        ? "Required source, repository, key or device unavailable; check identity and mount"
        : /Source.*chang|source.*chang/i.test(message)
          ? "Source changed; close writers and create a new operation"
          : /cancel|budget|integrity|corrupt|hash|checksum|digest|identity|confirm|grace|protection|locked|lease|required|invalid|rejected/i.test(
                message,
              ) && !/[A-Za-z]:\\|\/(?:Users|home|tmp)\//.test(message)
            ? message.slice(0, 200)
            : "Engine rejected; inspect the private CLI diagnostics and exact repository state";
  console.log(JSON.stringify({ ok: false, error: reason, error_code: code }));
  process.exitCode = 1;
}
