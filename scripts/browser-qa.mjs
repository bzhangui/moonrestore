// Optional real Chromium/Edge UI QA, using a separately installed Playwright.
// Run ui-pilot.mjs first; this script only accepts that owned synthetic fixture.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.MOONRESTORE_PLAYWRIGHT || "playwright");
const project = fileURLToPath(new URL("../", import.meta.url)),
  fixtureFile = path.resolve(process.argv[2] || "");
if (
  path.basename(fixtureFile) !== "session.json" ||
  !path
    .dirname(fixtureFile)
    .startsWith(path.join(project, ".local", "ui-pilot-"))
)
  throw new Error("Only the owned synthetic UI fixture is supported");
const fixture = JSON.parse(fs.readFileSync(fixtureFile));
if (
  fixture.origin !== "http://127.0.0.1:8790" ||
  !fixture.source.startsWith(path.dirname(fixtureFile) + path.sep)
)
  throw new Error("Invalid UI fixture");
const executable =
  process.env.MOONRESTORE_BROWSER ||
  (process.platform === "win32"
    ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    : undefined);
const browser = await chromium.launch({
  headless: true,
  ...(executable ? { executablePath: executable } : {}),
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage(),
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const resultDir = path.join(project, ".local", "ui-evidence");
fs.mkdirSync(resultDir, { recursive: true });
const done = () =>
  page.waitForFunction(
    () => !document.getElementById("refresh").disabled,
    {},
    { timeout: 60000 },
  );
const result = async () =>
  JSON.parse(await page.locator("#result").innerText());
try {
  await page.goto(fixture.url);
  await page
    .locator("#connection")
    .filter({ hasText: "本机会话已连接" })
    .waitFor();
  assert.equal(new URL(page.url()).hash, "");
  await page.locator("#job-form [name=id]").fill("gui-papers");
  await page.locator("#job-form [name=source]").fill(fixture.source);
  await page.locator("#job-form [name=repository]").fill(fixture.repository);
  await page.getByRole("button", { name: "预检查容量", exact: true }).click();
  await done();
  assert.equal((await result()).kind, "capacity");
  assert.equal((await result()).ok, true);
  await page.getByRole("button", { name: "保存备份任务", exact: true }).click();
  await done();
  await page.locator("#jobs").filter({ hasText: "gui-papers" }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "立即备份", exact: true }).click();
  await done();
  assert.equal((await result()).ok, true);
  assert.ok((await result()).drill);
  await page.getByRole("button", { name: "打开版本", exact: true }).click();
  await done();
  await page.locator(".snapshot").filter({ hasText: "受控初稿" }).click();
  await done();
  await page
    .locator("#catalog")
    .getByRole("button", { name: "paper.txt", exact: true })
    .click();
  await page.locator("#restore-form [name=target]").fill(fixture.restore);
  await page.getByRole("button", { name: "预览恢复范围", exact: true }).click();
  await done();
  assert.equal(await page.locator("#restore-confirm").isEnabled(), true);
  await page
    .locator("#restore-form [name=target]")
    .fill(fixture.restore + "-changed");
  assert.equal(await page.locator("#restore-confirm").isDisabled(), true);
  await page.locator("#restore-form [name=target]").fill(fixture.restore);
  await page.getByRole("button", { name: "预览恢复范围", exact: true }).click();
  await done();
  await page.locator("#restore-confirm").click();
  await done();
  assert.equal(
    fs.readFileSync(path.join(fixture.restore, "paper.txt"), "utf8"),
    "Controlled first revision.",
  );
  await page.getByRole("button", { name: "校验整个仓库", exact: true }).click();
  await done();
  assert.equal((await result()).ok, true);
  await page.getByRole("button", { name: "演练所选版本", exact: true }).click();
  await done();
  assert.equal((await result()).post_restore_readback, true);
  await page.getByRole("button", { name: "预览保留策略", exact: true }).click();
  await done();
  assert.equal((await result()).preview, true);
  // 0.3: exercise the actual DOM, not just matching HTTP endpoints.
  const job = () =>
    page.locator("#jobs .job").filter({ hasText: "gui-papers" });
  await job().getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("#job-form details summary").click();
  await page.locator("#job-form [name=maxRuntimeMinutes]").fill("45");
  page.once("dialog", (d) => d.accept());
  await page.locator("#save-job").click();
  await done();
  await job().getByRole("button", { name: "暂停任务", exact: true }).click();
  await done();
  assert.ok((await job().innerText()).includes("已暂停"));
  await job().getByRole("button", { name: "恢复任务", exact: true }).click();
  await done();
  await page.locator("#history-query").fill("");
  await page.locator("#history-filter").click();
  await done();
  await page.locator(".snapshot").first().click();
  await done();
  const choices = page.locator("#catalog input[type=checkbox]");
  assert.equal(await choices.count(), 2);
  await choices.nth(0).check();
  await choices.nth(1).check();
  const batch = fixture.restore + "-batch";
  await page.locator("#restore-form [name=target]").fill(batch);
  await page.getByRole("button", { name: "预览恢复范围", exact: true }).click();
  await done();
  assert.ok(
    (await page.locator("#restore-plan").innerText()).includes("2 个文件"),
  );
  await page.locator("#restore-modes").check();
  assert.equal(await page.locator("#restore-confirm").isDisabled(), true);
  await page.getByRole("button", { name: "预览恢复范围", exact: true }).click();
  await done();
  await page.locator("#restore-confirm").click();
  await done();
  assert.equal(
    fs.readFileSync(path.join(batch, "paper.txt"), "utf8"),
    "Controlled second revision.",
  );
  assert.equal(
    fs.readFileSync(path.join(batch, "data.csv"), "utf8"),
    "a,b\n1,2\n",
  );
  await page
    .locator("#catalog tr")
    .filter({ hasText: "paper.txt" })
    .getByRole("button", { name: "文本预览", exact: true })
    .click();
  await done();
  assert.equal(
    await page.locator("#text-preview").innerText(),
    "Controlled second revision.",
  );
  await page.getByText("比较历史版本", { exact: true }).click();
  await page.locator("#compare-before").selectOption({ index: 1 });
  await page.locator("#compare").click();
  await done();
  assert.equal((await result()).ok, true);
  await page.getByText("在所有历史版本中查找文件", { exact: true }).click();
  await page.locator("#search-name").fill("paper");
  await page.locator("#history-search button[type=submit]").click();
  await done();
  assert.ok(
    await page
      .locator("#search-results")
      .getByText("paper.txt", { exact: false })
      .count(),
  );
  if (await page.locator("#search-more").isVisible()) {
    await page.locator("#search-more").click();
    await done();
  }
  await page
    .locator("#search-results")
    .getByRole("button", { name: "打开此版本", exact: true })
    .first()
    .click();
  await done();
  // Secrets are synthetic, never saved in screenshots or reports.
  const encrypted = path.join(path.dirname(fixtureFile), "gui-encrypted"),
    key = path.join(path.dirname(fixtureFile), "gui-recovery.key");
  await page.locator("#secure-repository").fill(encrypted);
  await page.locator("#secure-password").fill("synthetic-browser-password");
  page.once("dialog", (d) => d.accept());
  await page.locator("#init-encrypted").click();
  await done();
  assert.equal((await result()).ok, true);
  assert.equal(await page.locator("#secure-password").inputValue(), "");
  await page.locator("#security summary").click();
  await page.locator("#export-key-path").fill(key);
  page.once("dialog", (d) => d.accept());
  await page.locator("#export-key").click();
  await done();
  assert.ok(fs.existsSync(key));
  await page.locator("#new-password").fill("synthetic-browser-next-password");
  page.once("dialog", (d) => d.accept());
  await page.locator("#change-password").click();
  await done();
  assert.equal((await result()).repository_master_key_rotated, false);
  await page.locator("#forget-keys").click();
  await done();
  await page
    .locator("#secure-password")
    .fill("synthetic-browser-next-password");
  await page.locator("#unlock").click();
  await done();
  assert.equal((await result()).persisted_password, false);
  await page.locator("#job-form [name=id]").fill("gui-encrypted");
  await page.locator("#job-form [name=source]").fill(fixture.source);
  await page.locator("#job-form [name=repository]").fill(encrypted);
  await page.locator("#save-job").click();
  await done();
  const encryptedJob = page
    .locator("#jobs .job")
    .filter({ hasText: "gui-encrypted" });
  page.once("dialog", (d) => d.accept());
  await encryptedJob
    .getByRole("button", { name: "立即备份", exact: true })
    .click();
  await done();
  assert.equal((await result()).ok, true);
  await encryptedJob
    .getByRole("button", { name: "打开版本", exact: true })
    .click();
  await done();
  await page.locator("#history-query").fill("");
  await page.locator("#history-filter").click();
  await done();
  await page.locator(".snapshot").first().click();
  await done();
  await page.locator("#secure-key").fill(key);
  await page.locator("#key-drill").click();
  await done();
  assert.equal((await result()).post_restore_readback, true);
  await page.locator("#secure-key").fill("");
  await page.locator("#export-key-path").fill("");
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await page.screenshot({
    path: path.join(resultDir, "desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(resultDir, "mobile.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const report = {
    ok: true,
    actual_browser: "installed Chromium/Edge via Playwright",
    synthetic_fixture: true,
    real_user_pilot: false,
    checks: [
      "capacity",
      "save job",
      "confirmed backup",
      "versions",
      "file selection",
      "restore preview",
      "stale preview disabled",
      "actual historical restore",
      "full audit",
      "restore drill",
      "retention preview",
      "job edit pause resume",
      "multiple file restore with option-bound confirmation",
      "verified text preview and version comparison",
      "all-history file search and version opening",
      "encrypted init export password rewrap unlock and key-only drill",
      "no credential localStorage",
      "mobile no horizontal overflow",
      "no page errors",
    ],
    screenshot_files: ["desktop.png", "mobile.png"],
  };
  fs.writeFileSync(
    path.join(resultDir, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
