// Private child of the Windows tray launcher; never write the session URL to disk.
import { startWorkbench } from "../platform/workbench.mjs";
const app = await startWorkbench({ port: 0, autoRun: true });
console.log(JSON.stringify({ url: app.url, pid: process.pid }));
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  await app.close();
  process.stdin.pause();
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  if (data.trim() === "stop") void stop();
});
process.stdin.once("end", stop);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
