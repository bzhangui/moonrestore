import { $, api, action, show, message } from "./app.js";
let preview = null;
const element = (tag, text) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
};
const request = () => ({
  repository: $("rescue-repository").value.trim(),
  snapshot: $("rescue-snapshot").value.trim(),
  target: $("rescue-target").value.trim(),
  ...($("rescue-key").value.trim()
    ? { recoveryKeyFile: $("rescue-key").value.trim() }
    : {}),
});
const gate = () => {
  const running = $("main").getAttribute("aria-busy") === "true";
  $("rescue-confirm").disabled =
    running || !preview || !$("accept-partial").checked;
  $("rebuild-run").disabled = running || !$("rebuild-accept").checked;
};
const invalidate = () => {
  preview = null;
  $("rescue-summary").textContent = "参数已改变，请重新预览。";
  gate();
};
$("rescue-form").addEventListener("input", (event) => {
  if (event.target.id === "accept-partial") gate();
  else invalidate();
});
$("rebuild-accept").onchange = gate;
for (const id of [
  "rebuild-donor",
  "rebuild-target",
  "rebuild-password",
  "rescue-repository",
  "rescue-snapshot",
]) {
  $(id).addEventListener("input", () => {
    $("rebuild-accept").checked = false;
    gate();
  });
}
document.addEventListener("moonrestore-idle", gate);
$("emergency-list").onclick = () =>
  action(async () => {
    const p = request();
    delete p.target;
    delete p.snapshot;
    const result = await api("emergency-list", p),
      target = $("emergency-snapshots");
    target.replaceChildren();
    invalidate();
    for (const s of result.snapshots
      .slice()
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, 100)) {
      const b = element(
        "button",
        s.created + " · " + s.label + " · " + s.id.slice(0, 12),
      );
      b.type = "button";
      b.className = "secondary";
      b.onclick = () => {
        $("rescue-snapshot").value = s.id;
        invalidate();
        message("已选择只读版本。核对目标后预览。");
      };
      target.append(b);
    }
    if (!result.snapshots.length)
      target.append(element("p", "仓库没有快照，不能作为有效恢复来源。"));
    if (result.snapshots.length > 100)
      target.append(
        element("p", "显示最新 100 项；可从准备清单输入完整快照 ID。"),
      );
  });
$("rescue-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    preview = await api("rescue-preview", request());
    $("rescue-summary").textContent =
      "本次范围：" +
      preview.verified_files +
      " 个文件通过校验，" +
      preview.failed_files +
      " 个文件无法验证。" +
      (preview.failed_files
        ? "确认后仅恢复健康文件，结果会标记为部分恢复。"
        : "确认后写入新目录，并独立读回。");
    show(preview);
  });
};
$("rescue-confirm").onclick = () =>
  action(async () => {
    if (!preview || !$("accept-partial").checked)
      throw new Error("请先预览并明确接受救援范围。");
    const confirmation = preview.confirmation;
    preview = null;
    const result = await api("rescue-apply", {
      ...request(),
      confirmation,
      acceptPartial: true,
    });
    show(result);
    $("rescue-summary").textContent = result.complete
      ? "本次范围已恢复，磁盘读回通过。"
      : "部分恢复已发布：健康文件读回通过；" +
        result.failed_files +
        " 个文件未恢复，原仓库保留。";
  });
async function renderHealth() {
  const result = await api("recovery-health", {
      repository: request().repository,
    }),
    container = $("health-evidence");
  container.replaceChildren();
  container.classList.toggle("empty", !result.snapshots.length);
  if (!result.snapshots.length) {
    container.append(element("p", "空仓库不是有效备份；尚无恢复证据。"));
    return;
  }
  const labels = {
    unknown: "未检查",
    stale: "证据已过期",
    failed: "检查失败",
    verified_in_window: "窗口内完整检查",
  };
  const list = element("div");
  list.className = "health-list";
  for (const s of result.snapshots.slice(0, 100)) {
    const row = element("article");
    row.className = "health-row";
    row.dataset.state = s.state;
    row.append(
      element("strong", s.snapshot.slice(0, 16)),
      element("span", labels[s.state] || "未知"),
      element(
        "small",
        s.last_cycle
          ? "完成：" +
              new Date(s.last_cycle.finished).toLocaleString() +
              " · 校验 " +
              s.last_cycle.checked +
              " 个文件"
          : "暂无完整周期证据",
      ),
    );
    list.append(row);
  }
  container.append(
    element(
      "p",
      result.ok
        ? "当前记录都在证据窗口内；这不是未来可恢复保证。"
        : "存在未检查、过期或失败记录，不能标记全部通过。",
    ),
    list,
  );
  if (result.snapshots.length > 100)
    container.append(
      element("p", "这里只显示 100 条；完整记录见下方操作结果。"),
    );
  return result;
}
$("health-status").onclick = () =>
  action(async () => show(await renderHealth()));
$("scrub-run").onclick = () =>
  action(async () => {
    const result = await api("scrub", {
      repository: request().repository,
      maxFiles: Number($("scrub-files").value),
      maxBytes: $("scrub-bytes").value.trim(),
    });
    await renderHealth();
    show(result);
  });
$("checklist-export").onclick = () =>
  action(async () => {
    const output = $("checklist-output").value.trim();
    if (!output) throw new Error("请输入仓库之外的全新私有清单路径。");
    show(
      await api("recovery-checklist", {
        repository: request().repository,
        output,
        confirmation: output,
      }),
    );
  });
$("rebuild-run").onclick = () =>
  action(async () => {
    if (!$("rebuild-accept").checked) throw new Error("请确认全新重建目标。");
    const p = request(),
      destination = $("rebuild-target").value.trim(),
      destinationPassword = $("rebuild-password").value;
    $("rebuild-password").value = "";
    if (
      !p.repository ||
      !p.snapshot ||
      !destination ||
      !$("rebuild-donor").value.trim()
    )
      throw new Error("请填写来源、快照、健康副本和新仓库路径。");
    show(
      await api("rebuild-copy", {
        repository: p.repository,
        snapshot: p.snapshot,
        donor: $("rebuild-donor").value.trim(),
        destination,
        confirmation: destination,
        ...(destinationPassword ? { destinationPassword } : {}),
      }),
    );
  });
gate();
