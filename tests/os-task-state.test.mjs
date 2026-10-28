import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fixture } from "./helpers.mjs";
import { taskPreview, TaskController } from "../platform/os-schedule.mjs";

function controlled(work) {
  const f = fixture(),
    old = process.env.MOONRESTORE_HOME;
  process.env.MOONRESTORE_HOME = path.join(f.base, "state");
  const mode = {
    present: false,
    timeoutRegister: false,
    unknown: false,
    running: false,
    foreign: false,
    enabled: true,
    writes: 0,
  };
  let registered;
  const rpc = (action, r) => {
    if (action === "query") {
      if (mode.unknown) throw new Error("controlled RPC timeout");
      if (!mode.present) return { state: "absent" };
      return {
        state: "present",
        ...registered,
        actions: 1,
        triggers: 1,
        sid: "owned-user",
        current_sid: "owned-user",
        enabled: mode.enabled,
        running: mode.running,
        arguments: mode.foreign ? "foreign-action" : registered.arguments,
      };
    }
    mode.writes++;
    if (action === "register") {
      registered = r;
      mode.present = true;
      if (mode.timeoutRegister) throw new Error("returned after timeout");
    }
    if (action === "disable") mode.enabled = false;
    if (action === "remove") mode.present = false;
    return { completed: true };
  };
  try {
    work({
      controller: new TaskController({ rpc, controlledSimulation: true }),
      preview: taskPreview("controlled-only", 1440, "plan"),
      mode,
      rpc,
    });
  } finally {
    if (old === undefined) delete process.env.MOONRESTORE_HOME;
    else process.env.MOONRESTORE_HOME = old;
    f.cleanup();
  }
}
test("task registration is read-back confirmed and exact retry is idempotent", () =>
  controlled(({ controller, preview, mode }) => {
    assert.equal(controller.install(preview, preview.task).registered, true);
    assert.equal(mode.writes, 1);
    assert.equal(controller.install(preview, preview.task).idempotent, true);
    assert.equal(mode.writes, 1);
    assert.equal(controller.status(preview.task).state, "owned");
  }));
test("registration timeout with actual creation is reconciled, never blindly duplicated", () =>
  controlled(({ controller, preview, mode }) => {
    mode.timeoutRegister = true;
    assert.equal(controller.install(preview, preview.task).registered, true);
    assert.equal(mode.writes, 1);
  }));
test("unresponsive preflight never mutates scheduler or creates an intent", () =>
  controlled(({ controller, preview, mode }) => {
    mode.unknown = true;
    assert.throws(
      () => controller.install(preview, preview.task),
      /unconfirmed/,
    );
    assert.equal(mode.writes, 0);
    assert.equal(fs.existsSync(controller.file(preview.task)), false);
  }));
test("foreign task identity cannot be disabled or deleted even with the right name", () =>
  controlled(({ controller, preview, mode }) => {
    controller.install(preview, preview.task);
    mode.foreign = true;
    assert.equal(controller.status(preview.task).state, "conflict");
    assert.throws(
      () => controller.change(preview.task, preview.task, "remove"),
      /Owned/,
    );
    assert.equal(mode.writes, 1);
  }));
test("running tasks refuse removal; disable and absent removal are idempotent", () =>
  controlled(({ controller, preview, mode }) => {
    controller.install(preview, preview.task);
    mode.running = true;
    assert.throws(
      () => controller.change(preview.task, preview.task, "remove"),
      /non-running/,
    );
    assert.equal(
      controller.change(preview.task, preview.task, "disable").enabled,
      false,
    );
    mode.running = false;
    assert.equal(
      controller.change(preview.task, preview.task, "remove").registered,
      false,
    );
    const writes = mode.writes;
    assert.equal(
      controller.change(preview.task, preview.task, "remove").registered,
      false,
    );
    assert.equal(mode.writes, writes);
  }));
test("modified preview, wrong confirmation and arbitrary RPC injection fail closed", () =>
  controlled(({ controller, preview, rpc }) => {
    assert.throws(() => new TaskController({ rpc }), /controlled simulation/);
    assert.throws(
      () =>
        controller.install(
          { ...preview, xml: preview.xml.replace("IgnoreNew", "Parallel") },
          preview.task,
        ),
      /changed/,
    );
    assert.throws(() => controller.install(preview, "wrong"), /Confirm/);
    assert.throws(
      () =>
        controller.install(
          { ...preview, start_boundary: new Date().toUTCString() },
          preview.task,
        ),
      /Expired/,
    );
    assert.throws(() => controller.file("../escape"), /exact task/);
  }));
test("changing an existing task interval is not falsely reported as idempotent success", () =>
  controlled(({ controller, preview, mode }) => {
    controller.install(preview, preview.task);
    const changed = taskPreview(preview.id, 30, "plan");
    assert.throws(() => controller.install(changed, changed.task), /conflict/);
    assert.equal(mode.writes, 1);
  }));
