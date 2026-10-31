import { $, api, action, show } from "./app.js";
let preview = null;
const value = (id) => $(id).value.trim();
const request = () => ({
  repository: value("wizard-repository"),
  snapshot: value("wizard-snapshot"),
  target: value("wizard-target"),
  metadataMode: value("wizard-metadata"),
  restoreModes: $("wizard-permissions").checked,
});
const feedback = (text) => {
  $("wizard-summary").textContent = text;
};
const attempt = (fn) =>
  action(async () => {
    try {
      await fn();
    } catch (error) {
      preview = null;
      gate();
      feedback(
        "本次未完成：" +
          error.message +
          "。请保留原库和已记录的操作 ID；核对后重试。",
      );
      throw error;
    }
  });
const gate = () => {
  $("wizard-apply").disabled =
    !preview ||
    !$("wizard-consent").checked ||
    $("main").getAttribute("aria-busy") === "true";
};
const invalidate = () => {
  preview = null;
  $("wizard-consent").checked = false;
  gate();
  feedback("参数已改变，请重新预览。");
};
for (const id of [
  "wizard-repository",
  "wizard-snapshot",
  "wizard-target",
  "wizard-metadata",
  "wizard-permissions",
])
  $(id).addEventListener("input", invalidate);
$("wizard-consent").addEventListener("change", gate);
document.addEventListener("moonrestore-idle", gate);
const step = (n) => {
  for (let i = 1; i <= 3; i++) {
    const e = $("workflow-step-" + i);
    if (i === n) e.setAttribute("aria-current", "step");
    else e.removeAttribute("aria-current");
  }
};
$("restore-wizard-form").onsubmit = (e) => {
  e.preventDefault();
  attempt(async () => {
    invalidate();
    feedback("正在核对仓库能力并完整检查恢复范围…");
    const p = request(),
      key = JSON.stringify(p);
    const capabilities = await api("restore-capabilities", {
      repository: p.repository,
    });
    const result = await api("restore-preview", p);
    if (JSON.stringify(request()) !== key) return;
    preview = { p, result, capabilities };
    $("wizard-consent").checked = false;
    step(2);
    show(result);
    feedback(
      "格式 " +
        capabilities.format +
        "；" +
        (result.files ?? result.verified_files ?? 0) +
        " 个文件。" +
        (p.metadataMode === "native"
          ? "原生元数据：要求平台、权限匹配并独立核验。"
          : "基础/便携模式：不会还原全部原生元数据。") +
        " 目标：" +
        p.target +
        "。请核对后勾选确认。",
    );
    gate();
  });
};
$("wizard-apply").onclick = () =>
  attempt(async () => {
    if (!preview || !$("wizard-consent").checked)
      throw new Error("先预览并确认恢复范围。");
    const current = preview;
    preview = null;
    gate();
    feedback("正在恢复，完成前请勿删除暂存资料。");
    let result;
    if (current.capabilities.paged) {
      const p = current.p,
        created = await api("restore-writer-create", {
          repository: p.repository,
          snapshot: p.snapshot,
          target: p.target,
          confirmation: p.target,
          metadataMode: p.metadataMode,
          permissions: p.restoreModes,
        });
      $("writer-repository").value = p.repository;
      $("writer-operation").value = created.operation;
      feedback(
        "恢复操作 " + created.operation + " 已建立；中断后可在下方查询并继续。",
      );
      result = await api("restore-writer-resume", {
        repository: p.repository,
        id: created.operation,
        recover: false,
      });
    } else
      result = await api("restore", {
        ...current.p,
        confirmation: current.result.confirmation,
      });
    show(result);
    step(3);
    $("application-root").value = current.p.target;
    feedback(
      result.ok === false
        ? "恢复未完成；保留操作 ID 和暂存资料，不要当作可用副本。"
        : "内容恢复和读回已通过。应用业务约束尚未验证，可在下方执行私有验收契约。",
    );
  });
const writer = () => ({
  repository: value("writer-repository"),
  id: value("writer-operation"),
});
$("writer-status").onclick = () =>
  action(async () => show(await api("restore-writer-status", writer())));
$("writer-resume-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () =>
    show(
      await api("restore-writer-resume", {
        ...writer(),
        recover: $("writer-recover").checked,
      }),
    ),
  );
};
$("application-contract-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    $("application-result").textContent = "正在只读验证声明的应用约束…";
    try {
      const r = await api("application-validate", {
        root: value("application-root"),
        contract: JSON.parse(value("application-contract-json")),
      });
      show(r);
      $("application-result").textContent =
        "声明的文件、JSON 和数据库附件检查通过；未启动应用，不代表全部业务或真实生产环境验证。";
    } catch (error) {
      $("application-result").textContent = "应用检查未通过：" + error.message;
      throw error;
    }
  });
};
