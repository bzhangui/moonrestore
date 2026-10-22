// Actual browser, synthetic data, random loopback port; no OS registration,
// external network, credentials, existing service or personal files involved.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startWorkbench } from "../platform/workbench.mjs";
import { core, removeOwned, saveReport } from "../platform/maintenance.mjs";
import { mkdirPrivate } from "../platform/vault.mjs";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.MOONRESTORE_PLAYWRIGHT || "playwright");
const parent = mkdirPrivate(
    fileURLToPath(new URL("../.local/", import.meta.url)),
  ),
  root = fs.mkdtempSync(path.join(parent, "readiness-ui-")),
  old = process.env.MOONRESTORE_HOME;
process.env.MOONRESTORE_HOME = path.join(root, "state");
let app, browser;
try {
  const repository = path.join(root, "repository"),
    database = path.join(root, "source.sqlite"),
    db = new DatabaseSync(database);
  try {
    db.exec(
      "CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'synthetic');",
    );
  } finally {
    db.close();
  }
  await core(["init", repository]);
  app = await startWorkbench({ port: 0 });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MOONRESTORE_BROWSER
      ? { executablePath: process.env.MOONRESTORE_BROWSER }
      : process.platform === "win32"
        ? {
            executablePath:
              "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          }
        : {}),
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const idle = () =>
    page.waitForFunction(
      () =>
        document.getElementById("main").getAttribute("aria-busy") === "false",
      {},
      { timeout: 90000 },
    );
  await page.goto(app.url);
  await page
    .locator("#connection")
    .filter({ hasText: "本机会话已连接" })
    .waitFor();
  await idle();
  assert.equal(new URL(page.url()).hash, "");
  await page
    .locator("#durable-plan-form")
    .evaluate((n) => (n.parentElement.open = true));
  await page.locator("#durable-type").selectOption("postgresql");
  assert.equal(
    await page.locator("#durable-postgres-fields").isVisible(),
    true,
  );
  assert.equal(
    await page.locator("#durable-source").getAttribute("required"),
    null,
  );
  await page.locator("#durable-type").selectOption("sqlite");
  assert.equal(
    await page.locator("#durable-postgres-fields").isVisible(),
    false,
  );
  await page.locator("#durable-name").fill("受控SQLite恢复目标");
  await page.locator("#durable-repository").fill(repository);
  await page.locator("#durable-source").fill(database);
  await page.locator("#durable-rto").fill("1");
  await page.locator("#durable-remote").check();
  assert.equal(await page.locator("#durable-remote-fields").isVisible(), true);
  assert.equal(
    await page.locator("#durable-remote-consent").isChecked(),
    false,
  );
  await page.locator("#durable-remote").uncheck();
  await page.locator("#durable-plan-form button[type=submit]").click();
  await idle();
  await page
    .locator("#durable-plans")
    .filter({ hasText: "受控SQLite恢复目标" })
    .waitFor();
  await page.locator("#readiness-refresh").click();
  await idle();
  assert.match(await page.locator("#readiness-list").innerText(), /待处理/);
  await page
    .locator("#durable-plans")
    .getByRole("button", { name: "运行并验证", exact: true })
    .click();
  await idle();
  await page.locator("#readiness-refresh").click();
  await idle();
  assert.match(await page.locator("#readiness-list").innerText(), /均满足/);
  assert.equal(await page.locator("[data-os-confirm]").isDisabled(), true);
  await page
    .getByRole("checkbox", {
      name: "允许计划自动执行：受控SQLite恢复目标",
      exact: true,
    })
    .check();
  await page
    .locator("#durable-plans")
    .getByRole("button", { name: "确认调度设置", exact: true })
    .click();
  await idle();
  await page
    .locator("#durable-plans")
    .getByRole("button", { name: "预览 Windows 独立调度任务", exact: true })
    .click();
  await idle();
  assert.equal(await page.locator("[data-os-confirm]").isEnabled(), true); // Never click registration.
  await page.locator("#state-location").click();
  await idle();
  assert.match(
    await page.locator("#state-current").innerText(),
    /当前私有目录/,
  );
  await page
    .locator("#state-migrate-form")
    .evaluate((n) => (n.parentElement.open = true));
  await page
    .locator("#state-migrate-source")
    .fill(process.env.MOONRESTORE_HOME);
  await page
    .locator("#state-migrate-target")
    .fill(path.join(root, "new-state"));
  await page.locator("#state-migrate-accept").check();
  await page.locator("#state-migrate-preview").click();
  await idle();
  assert.equal(await page.locator("#state-migrate-apply").isEnabled(), true);
  await page
    .locator("#state-migrate-target")
    .fill(path.join(root, "changed-state"));
  assert.equal(await page.locator("#state-migrate-apply").isDisabled(), true);
  await page.locator("#state-migrate-preview").click();
  await idle();
  await page.locator("#state-migrate-apply").click();
  await idle();
  assert.equal(
    fs.existsSync(path.join(root, "changed-state", "plans-v1")),
    true,
  );
  assert.equal(await page.locator("#state-migrate-apply").isDisabled(), true);
  const plans = JSON.parse(
    fs.readFileSync(
      path.join(
        process.env.MOONRESTORE_HOME,
        "plans-v1",
        fs
          .readdirSync(path.join(process.env.MOONRESTORE_HOME, "plans-v1"))
          .find((n) => n.endsWith(".json")),
      ),
    ),
  );
  await page
    .locator("#sqlite-recover-form")
    .evaluate((n) => (n.parentElement.open = true));
  const target = path.join(root, "verified-sqlite");
  await page.locator("#sqlite-recover-repo").fill(repository);
  await page.locator("#sqlite-recover-id").fill(plans.evidence.backup.snapshot);
  await page.locator("#sqlite-recover-target").fill(target);
  await page.locator("#sqlite-recover-checks").fill(
    JSON.stringify({
      format: 1,
      tables: [{ name: "sample", columns: ["id", "value"], minimumRows: 1 }],
    }),
  );
  await page.locator("#sqlite-recover-accept").check();
  await page.locator("#sqlite-recover-form button[type=submit]").click();
  await idle();
  assert.equal(
    JSON.parse(await page.locator("#result").innerText())
      .sqlite_integrity_checked,
    true,
  );
  assert.equal(fs.existsSync(path.join(target, "database.sqlite")), true);
  for (const id of [
    "rescue-kit-form",
    "kit-recover-form",
    "remote-audit-form",
  ]) {
    await page.locator("#" + id).evaluate((n) => (n.parentElement.open = true));
  }
  assert.equal(await page.locator("#rescue-kit-accept").isChecked(), false);
  assert.equal(await page.locator("#kit-recover-consent").isChecked(), false);
  assert.equal(await page.locator("#remote-audit-consent").isChecked(), false);
  const evidence = mkdirPrivate(path.join(parent, "ui-evidence"));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.locator(".readiness-panel").screenshot({
      path: path.join(evidence, "readiness-0.7-" + width + ".png"),
    });
    await page.locator("#state-migrate-form").screenshot({
      path: path.join(evidence, "migration-0.7-" + width + ".png"),
    });
  }
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  const report = {
    ok: true,
    version: "0.7.0",
    kind: "readiness_actual_browser",
    synthetic_data: true,
    real_user_pilot: false,
    os_registered: false,
    checks: [
      "SQLite plan and recovered database",
      "readiness transition",
      "PostgreSQL and S3 configuration visibility",
      "OS preview without registration",
      "state preview invalidation and copy",
      "rescue/network default opt-out",
      "1440/390px layout",
      "no page errors or localStorage",
    ],
  };
  process.env.MOONRESTORE_HOME = path.join(parent, "qa-evidence");
  console.log(
    JSON.stringify({ ...report, files: saveReport(report) }, null, 2),
  );
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (old === undefined) delete process.env.MOONRESTORE_HOME;
  else process.env.MOONRESTORE_HOME = old;
  removeOwned(root, parent, "readiness-ui-");
}
