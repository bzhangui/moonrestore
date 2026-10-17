import { $, api, action, show, message } from "./app.js";
const element = (tag, text) => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
const feedback = (text) => {
  $("durable-feedback").textContent = text;
};
async function renderPlans() {
  const result = await api("plans", {}),
    list = $("durable-plans");
  list.replaceChildren();
  if (!result.plans.length) {
    list.append(
      element(
        "p",
        "尚无可靠计划。创建一个文件夹计划，首次运行会执行完整恢复演练。",
      ),
    );
    return;
  }
  for (const p of result.plans) {
    const row = document.createElement("article");
    row.className = "durable-row";
    const title = document.createElement("div");
    title.append(element("strong", p.config.name), element("small", p.id));
    const evidence = document.createElement("div");
    const labels = [
      ["backup", "备份"],
      ["verified", "校验"],
      ["drill", "恢复演练"],
      ["replica", "副本"],
      ["remote", "远端"],
    ];
    for (const [key, label] of labels) {
      const point = p.evidence[key];
      evidence.append(
        element(
          "span",
          label +
            "：" +
            (point ? new Date(point.finished).toLocaleString() : "未完成"),
        ),
      );
    }
    const state = element(
      "p",
      p.ok
        ? "证据在配置窗口内；不是未来恢复保证。"
        : p.lastError
          ? "最近执行失败；请查看报告，旧恢复点保留。"
          : "尚无完整、有效的恢复证据。",
    );
    const button = element("button", "运行并验证");
    button.type = "button";
    button.className = "secondary";
    button.onclick = () =>
      action(async () => {
        feedback("计划运行中，可在任务栏查看进度或取消。");
        const r = await api("plan-run", { id: p.id });
        show(r);
        feedback(
          r.ok
            ? "本次备份、校验和演练已通过。"
            : "本次计划未全部通过，检查分项证据。",
        );
        await renderPlans();
      });
    row.append(title, evidence, state, button);
    list.append(row);
  }
}
$("plans-refresh").onclick = () => action(renderPlans);
$("durable-plan-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const r = await api("plan-save", {
      name: $("durable-name").value.trim(),
      type: $("durable-type").value,
      repository: $("durable-repository").value.trim(),
      source: $("durable-source").value.trim(),
    });
    show(r);
    feedback("计划已私有保存；不会自动运行。");
    await renderPlans();
  });
};
const resume = () => ({
  repository: $("resume-repository").value.trim(),
  id: $("resume-id").value.trim(),
});
$("resume-status").onclick = () =>
  action(async () => {
    const r = await api("operation-status", resume());
    show(r);
    feedback("任务状态：" + r.state + "；已记录文件：" + r.checkpoint_files);
  });
$("durable-resume-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const r = await api("operation-resume", {
      ...resume(),
      recover: $("resume-recover").checked,
    });
    show(r);
    feedback("续作完成，状态：" + r.state);
  });
};
$("durable-restore-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("durable-restore-accept").checked)
      throw new Error("请确认新目录恢复范围。");
    const target = $("durable-restore-target").value.trim();
    const r = await api("restore-resumable", {
      repository: $("durable-restore-repo").value.trim(),
      snapshot: $("durable-restore-id").value.trim(),
      target,
      confirmation: target,
    });
    show(r);
    feedback("完整恢复及独立磁盘读回通过。操作 ID：" + r.operation);
    message("恢复完成，原仓库未改写。");
  });
};
