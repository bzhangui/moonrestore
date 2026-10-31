// Requires explicit user authorization. No prefix enumeration or broad cleanup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { core, removeOwned } from "../platform/maintenance.mjs";
import { saveJob } from "../platform/jobs.mjs";
import { TaskController, taskPreview } from "../platform/os-schedule.mjs";
const resume = process.argv[2] === "--resume-fixture";
if (
  process.platform !== "win32" ||
  !(
    (process.argv.length === 3 &&
      process.argv[2] === "--confirmed-synthetic") ||
    (resume && process.argv.length === 4)
  )
)
  throw new Error("Authorized Windows synthetic drill only");
const parent = fs.realpathSync(os.tmpdir()),
  base = resume
    ? fs.realpathSync(process.argv[3])
    : fs.mkdtempSync(path.join(parent, "moonrestore-schedule-v12-")),
  previous = process.env.MOONRESTORE_HOME;
if (
  path.dirname(base) !== parent ||
  !/^moonrestore-schedule-v12-[A-Za-z0-9]+$/.test(path.basename(base))
)
  throw new Error("Exact owned synthetic fixture required");
process.env.MOONRESTORE_HOME = path.join(base, "home");
const c = new TaskController(),
  report = {
    kind: "controlled_windows_schedule_drill",
    controlled_simulation: false,
    real_user_data: false,
    administrator_requested: false,
    existing_tasks_changed: false,
    registration_confirmed: false,
    execution_verified: false,
    cleanup_confirmed: false,
  };
let preview,
  retain = false;
try {
  const source = path.join(base, "source"),
    repository = path.join(base, "repo");
  if (!resume) {
    fs.mkdirSync(source);
    fs.writeFileSync(
      path.join(source, "synthetic.txt"),
      "controlled schedule v12",
    );
    await core(["init", repository]);
    await saveJob({
      id: "synthetic-v12",
      source,
      repository,
      intervalMinutes: 1440,
      drillEvery: 1,
      reserveBytes: "0",
      automatic: false,
      notify: false,
    });
  } else {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(process.env.MOONRESTORE_HOME, "jobs.json"),
        "utf8",
      ),
    );
    if (
      config.jobs.length !== 1 ||
      config.jobs[0].source !== source ||
      config.jobs[0].repository !== repository ||
      config.jobs[0].id !== "synthetic-v12" ||
      fs.readFileSync(path.join(source, "synthetic.txt"), "utf8") !==
        "controlled schedule v12"
    )
      throw new Error("Synthetic fixture identity mismatch");
  }
  preview = taskPreview("synthetic-v12", 1440, "job");
  c.install(preview, preview.task);
  report.registration_confirmed = true;
  retain = true;
  const prior = JSON.parse(
    fs.readFileSync(
      path.join(process.env.MOONRESTORE_HOME, "jobs.json"),
      "utf8",
    ),
  );
  if (!(prior.jobs[0].lastRun?.ok && prior.jobs[0].successfulRuns > 0))
    c.run(preview.task, preview.task);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const jobs = JSON.parse(
      fs.readFileSync(
        path.join(process.env.MOONRESTORE_HOME, "jobs.json"),
        "utf8",
      ),
    );
    if (jobs.jobs[0].lastRun?.ok && jobs.jobs[0].successfulRuns > 0) {
      report.execution_verified = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} catch (error) {
  report.error = String(error.message)
    .replace(/[A-Za-z]:\\[^\s]*/g, "[private-path]")
    .slice(0, 200);
} finally {
  if (preview && fs.existsSync(c.file(preview.task))) {
    retain = true;
    try {
      let s = c.status(preview.task);
      const deadline = Date.now() + 15000;
      while (s.state === "owned" && s.running && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        s = c.status(preview.task);
      }
      if (s.state === "owned" && !s.running) {
        c.change(preview.task, preview.task, "disable");
        c.change(preview.task, preview.task, "remove");
        report.cleanup_confirmed = c.status(preview.task).state === "absent";
        retain = !report.cleanup_confirmed;
      } else if (s.state === "absent") {
        report.cleanup_confirmed = true;
        retain = false;
      }
    } catch {
      report.cleanup_confirmed = false;
    }
  } else report.cleanup_confirmed = true;
  if (previous === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = previous;
  if (!retain) removeOwned(base, parent, "moonrestore-schedule-v12-");
  report.fixture_retained = retain;
  report.logout_or_reboot_verified = false;
  report.ok =
    report.registration_confirmed &&
    report.execution_verified &&
    report.cleanup_confirmed;
  console.log(JSON.stringify(report, null, 2));
}
