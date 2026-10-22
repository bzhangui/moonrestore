import { $, api, action, show } from "./app.js";
const value = (id) => $(id).value.trim();
let migration;
document.addEventListener("moonrestore-idle", () => {
  $("state-migrate-apply").disabled = !migration;
});
const invalidate = () => {
  migration = null;
  $("state-migrate-apply").disabled = true;
  $("state-migrate-result").textContent = "配置或确认已改变，请重新预览。";
};
for (const id of [
  "state-migrate-source",
  "state-migrate-target",
  "state-migrate-accept",
])
  $(id).addEventListener("input", invalidate);
$("state-migrate-preview").onclick = () =>
  action(async () => {
    invalidate();
    if (!$("state-migrate-accept").checked)
      throw new Error("请先停止旧状态的使用并确认范围。");
    const source = value("state-migrate-source"),
      destination = value("state-migrate-target");
    const p = await api("state-migrate-preview", { source, destination });
    // Capture the exact paths, not whatever happens to be in the form later.
    if (
      source !== value("state-migrate-source") ||
      destination !== value("state-migrate-target") ||
      !$("state-migrate-accept").checked
    )
      return;
    migration = { source, destination, confirmation: p.confirmation };
    show(p);
    $("state-migrate-apply").disabled = false;
    $("state-migrate-result").textContent =
      "可复制 " +
      p.members.length +
      " 个配置文件；密钥不复制，当前进程不切换。";
  });
$("state-migrate-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!migration || !$("state-migrate-accept").checked)
      throw new Error("请重新预览并确认。");
    const request = migration;
    invalidate();
    show(await api("state-migrate", request));
    $("state-migrate-result").textContent =
      "已复制配置；请另行使用新 --home 启动并重新解锁。旧目录未删除。";
  });
};
const kit = () => ({
  kit: value("kit-recover-kit"),
  recipeSha256: value("kit-recover-sha"),
  repository: value("kit-recover-repository"),
});
$("kit-recover-check").onclick = () =>
  action(async () => {
    show(await api("rescue-kit-check", kit()));
  });
$("kit-recover-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("kit-recover-consent").checked || !value("kit-recover-destination"))
      throw new Error("请确认配方来源及全新恢复目录。");
    const destination = value("kit-recover-destination");
    show(
      await api("rescue-kit-restore", {
        ...kit(),
        destination,
        confirmation: destination,
      }),
    );
  });
};
$("sqlite-recover-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("sqlite-recover-accept").checked)
      throw new Error("请确认隔离恢复范围。");
    const destination = value("sqlite-recover-target");
    show(
      await api("sqlite-recover", {
        repository: value("sqlite-recover-repo"),
        snapshot: value("sqlite-recover-id"),
        destination,
        confirmation: destination,
        checks: JSON.parse(value("sqlite-recover-checks")),
      }),
    );
  });
};
$("remote-audit-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("remote-audit-consent").checked)
      throw new Error("必须明确同意只读网络请求。");
    show(
      await api("remote-audit", {
        endpoint: value("remote-audit-endpoint"),
        bucket: value("remote-audit-bucket"),
        receiptKey: value("remote-audit-key"),
        checksum: value("remote-audit-sha"),
        version: value("remote-audit-version"),
        offset: Number(value("remote-audit-offset")),
        batch: Number(value("remote-audit-batch")),
        retentionDays: Number(value("remote-audit-days")),
        allowRemote: true,
      }),
    );
  });
};
