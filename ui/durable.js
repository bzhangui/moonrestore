import { $, api, action, show, message } from "./app.js";
const element = (tag, text) => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
const feedback = (text) => {
  $("durable-feedback").textContent = text;
};
document.addEventListener("moonrestore-idle", () => {
  for (const b of document.querySelectorAll("[data-os-confirm]"))
    b.disabled = b.dataset.osConfirm !== "ready";
});
async function renderReadiness() {
  const report = await api("readiness", {}),
    list = $("readiness-list");
  list.replaceChildren();
  if (report.issues.length)
    list.append(element("p", "计划调度记录异常；本次不能判定恢复准备度通过。"));
  if (!report.plans.length) {
    list.append(
      element("p", "尚无计划。请先建立并完成一次备份、校验与恢复演练。"),
    );
    return;
  }
  for (const p of report.plans) {
    const row = element("article");
    row.className = "readiness-row";
    row.append(
      element("strong", p.name),
      element(
        "p",
        p.ready
          ? "证据与配置目标均满足；不是未来恢复保证。"
          : "待处理：" + p.reasons.join(" / "),
      ),
      element(
        "small",
        "RPO：" +
          ({ within: "窗口内", unknown: "未知", exceeded: "超出目标" }[
            p.goal.rpo_state
          ] || p.goal.rpo_state) +
          " · RTO演练：" +
          ({
            within: "目标内",
            unknown: "未知",
            exceeded: "超出目标",
            not_configured: "未设置",
          }[p.goal.rto_state] || p.goal.rto_state) +
          " · 调度：" +
          ({
            not_configured: "未配置",
            scheduled: "等待到期",
            due: "已到期",
            running: "执行中",
            missing: "执行缺席",
            running_overdue: "执行超时",
            disabled: "已禁用",
            blocked: "已阻断",
            clock_discontinuity: "时钟异常",
          }[p.schedule] || p.schedule),
      ),
      element(
        "small",
        p.real_independent_copy_verified
          ? "已有独立副本验证记录"
          : "独立设备/真实云副本尚未验证",
      ),
    );
    list.append(row);
  }
}
$("readiness-refresh").onclick = () => action(renderReadiness);
$("state-location").onclick = () =>
  action(async () => {
    const r = await api("state-status", {});
    show(r);
    $("state-current").textContent =
      "当前私有目录：" +
      r.active +
      (r.unified
        ? " · 已统一"
        : " · 未自动搬迁；CLI与桌面可显式使用同一 --home。");
  });
async function renderPlans() {
  const result = await api("plans", {}),
    schedules = (await api("plan-schedules", {})).schedules,
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
      const names = {
        current: "当前快照/窗口内",
        unknown: "未完成",
        stale: "已过期",
        future: "时间异常",
        different_snapshot: "属于旧快照",
        invalid: "记录无效",
      };
      evidence.append(
        element(
          "span",
          label +
            "：" +
            (point
              ? new Date(point.finished).toLocaleString()
              : p.stages?.[key]?.required === false
                ? "未配置/不要求"
                : "未完成") +
            " · " +
            (names[p.stages?.[key]?.state] || "未知"),
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
    const schedule = schedules.find((s) => s.id === p.id),
      controls = document.createElement("div"),
      label = element(
        "label",
        "允许此计划在已开启自动运行的工作台/显式 runner 中执行（不会注册系统服务）",
      ),
      consent = document.createElement("input"),
      interval = document.createElement("input"),
      intervalLabel = element("label", "执行间隔（分钟）"),
      save = element("button", "确认调度设置");
    consent.type = "checkbox";
    label.className = "check";
    controls.className = "form-grid durable-schedule";
    consent.checked = schedule?.enabled === true;
    consent.setAttribute("aria-label", "允许计划自动执行：" + p.config.name);
    label.prepend(consent);
    interval.type = "number";
    interval.min = "1";
    interval.max = "10080";
    interval.value = String(schedule?.intervalMinutes ?? 1440);
    interval.setAttribute("aria-label", "执行间隔：" + p.config.name);
    intervalLabel.append(interval);
    save.type = "button";
    save.className = "secondary";
    save.onclick = () =>
      action(async () => {
        await api("plan-schedule", {
          id: p.id,
          confirmation: p.id,
          config: {
            enabled: consent.checked,
            intervalMinutes: Number(interval.value),
          },
        });
        feedback(
          "调度设置已保存；只有显式 runner 或已启用自动运行的工作台才会执行，凭据不落盘。",
        );
        await renderPlans();
      });
    controls.append(
      label,
      intervalLabel,
      element(
        "p",
        schedule
          ? "调度状态：" +
              (schedule.clock_discontinuity
                ? "clock_discontinuity"
                : schedule.state) +
              (schedule.reason ? " / " + schedule.reason : "")
          : "调度未启用",
      ),
      save,
    );
    const osPreview = element("button", "预览 Windows 独立调度任务"),
      osInstall = element("button", "确认注册预览任务");
    osPreview.type = osInstall.type = "button";
    osPreview.className = osInstall.className = "secondary";
    osInstall.disabled = true;
    let exactTask;
    osInstall.dataset.osConfirm = "not_ready";
    osPreview.onclick = () =>
      action(async () => {
        exactTask = null;
        osInstall.dataset.osConfirm = "not_ready";
        osInstall.disabled = true;
        const r = await api("plan-os-preview", { id: p.id });
        show(r);
        exactTask = r.task;
        osInstall.dataset.osConfirm = "ready";
        osInstall.disabled = false;
        feedback(
          "仅预览：" + r.task + "。仅当前用户登录时运行；尚未注册或执行。",
        );
      });
    osInstall.onclick = () =>
      action(async () => {
        if (
          !exactTask ||
          !confirm(
            "确认注册专用任务 " +
              exactTask +
              "？不会请求管理员权限；既有同名任务不会覆盖。",
          )
        )
          return;
        const confirmation = exactTask;
        exactTask = null;
        osInstall.dataset.osConfirm = "not_ready";
        osInstall.disabled = true;
        show(await api("plan-os-install", { id: p.id, confirmation }));
        feedback("已确认注册；实际触发与恢复验证仍需独立检查。");
      });
    controls.append(osPreview, osInstall);
    row.append(title, evidence, state, button, controls);
    list.append(row);
  }
}
$("plans-refresh").onclick = () => action(renderPlans);
$("durable-plan-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const type = $("durable-type").value,
      remote = $("durable-remote").checked;
    const config = {
      name: $("durable-name").value.trim(),
      type,
      repository: $("durable-repository").value.trim(),
      rpoHours: Number($("durable-rpo").value),
      rtoMinutes: Number($("durable-rto").value),
      ...(type === "postgresql"
        ? {
            postgres: {
              database: $("durable-pg-database").value.trim(),
              user: $("durable-pg-user").value.trim(),
              host: "127.0.0.1",
              port: 5432,
              dumpExecutable: $("durable-pg-dump").value.trim(),
              restoreExecutable: $("durable-pg-restore").value.trim(),
            },
          }
        : { source: $("durable-source").value.trim() }),
      ...($("durable-replica").value.trim()
        ? { replica: $("durable-replica").value.trim() }
        : {}),
      ...(remote
        ? {
            remote: {
              endpoint: $("durable-remote-endpoint").value.trim(),
              bucket: $("durable-remote-bucket").value.trim(),
              region: $("durable-remote-region").value.trim(),
              prefix: "moonrestore",
              accessKeyEnv: "MOONRESTORE_S3_ACCESS_KEY_ID",
              secretKeyEnv: "MOONRESTORE_S3_SECRET_ACCESS_KEY",
              allowRemote: $("durable-remote-consent").checked,
            },
          }
        : {}),
    };
    if (remote && !$("durable-remote-consent").checked)
      throw new Error("远端计划需明确同意联网；密码和访问密钥不在页面填写。");
    const r = await api("plan-save", config);
    show(r);
    feedback("计划已私有保存；不会自动运行。");
    await renderPlans();
  });
};
$("durable-type").onchange = () => {
  $("durable-postgres-fields").hidden =
    $("durable-type").value !== "postgresql";
  $("durable-source").required = $("durable-type").value !== "postgresql";
  for (const id of [
    "durable-pg-database",
    "durable-pg-user",
    "durable-pg-dump",
    "durable-pg-restore",
  ])
    $(id).required = $("durable-type").value === "postgresql";
};
$("durable-remote").onchange = () => {
  $("durable-remote-fields").hidden = !$("durable-remote").checked;
  for (const id of [
    "durable-remote-endpoint",
    "durable-remote-bucket",
    "durable-remote-region",
    "durable-remote-consent",
  ])
    $(id).required = $("durable-remote").checked;
};
$("rescue-kit-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!$("rescue-kit-accept").checked)
      throw new Error("请核对独立保存的运行包摘要并确认新目录。");
    const destination = $("rescue-kit-destination").value.trim();
    const r = await api("rescue-kit-create", {
      repository: $("rescue-kit-repository").value.trim(),
      snapshot: $("rescue-kit-snapshot").value.trim(),
      bundle: $("rescue-kit-bundle").value.trim(),
      manifestSha256: $("rescue-kit-sha").value.trim(),
      destination,
      confirmation: destination,
    });
    show(r);
    feedback("救援包已生成；请独立私有保存 recipe_sha256，密钥必须另存。");
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
