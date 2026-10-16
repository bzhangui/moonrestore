const $ = (id) => document.getElementById(id);
let token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
let selected = null,
  offset = 0,
  catalogTotal = 0,
  preview = null,
  busy = false,
  lastJobs = [],
  lastSnapshots = [],
  historyOffset = 0,
  activeTask = null;
const message = (text, error = false) => {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
};
const node = (tag, text, className) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
};
const data = (form) => Object.fromEntries(new FormData(form));
function repository() {
  const value = $("open-repo").value.trim();
  if (!value) throw new Error("请先填写仓库路径。");
  return value;
}
async function direct(route, body) {
  const response = await fetch("/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "操作未完成");
  return result;
}
async function api(route, body) {
  let result;
  if (
    body !== undefined &&
    [
      "job-run",
      "snapshots",
      "catalog",
      "search",
      "compare",
      "text-preview",
      "restore-preview",
      "restore",
      "report",
      "drill",
      "key-drill",
      "capacity",
      "prune-preview",
    ].includes(route)
  ) {
    const minutes =
      route === "job-run"
        ? (lastJobs.find((j) => j.id === body.id)?.maxRuntimeMinutes ?? 30)
        : Number($("operation-budget")?.value || 30);
    const started = await direct("task-start", { route, body, minutes });
    activeTask = started.task.id;
    const status = $("task-status");
    if (status) status.hidden = false;
    const began = Date.now();
    try {
      while (true) {
        const { task } = await direct("task");
        if (!task || task.id !== activeTask)
          throw new Error("任务状态已改变，请查看仓库记录。");
        if ($("task-progress"))
          $("task-progress").textContent =
            "阶段：" +
            task.progress.phase +
            " · " +
            Math.floor((Date.now() - began) / 1000) +
            " 秒 · 已读 " +
            (task.progress.read_bytes ?? 0) +
            " 字节 · 已写 " +
            (task.progress.written_bytes ?? 0) +
            " 字节";
        if ($("task-cancel"))
          $("task-cancel").disabled =
            task.status !== "running" || task.cancel_requested;
        if (task.status !== "running") {
          if (task.status === "cancelled")
            throw new Error(
              "已取消。已提交的完整快照保留，未完成恢复不会覆盖目标。",
            );
          if (task.status === "failed" && !task.result)
            throw new Error(task.error);
          result = task.result;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      activeTask = null;
      if ($("task-cancel")) $("task-cancel").disabled = true;
    }
  } else result = await direct(route, body);
  if (route === "catalog") catalogTotal = result.total;
  if (route === "jobs") lastJobs = result.jobs;
  if (route === "snapshots") lastSnapshots = result.snapshots;
  return result;
}
const setHistoryOffset = (value) => {
  historyOffset = value;
};
const invalidatePreview = () => {
  preview = null;
  $("restore-confirm").disabled = true;
};
const setPreview = (value) => {
  preview = value;
};
const getPreview = () => preview;
const getJobs = () => lastJobs;
const getSnapshots = () => lastSnapshots;
async function action(fn) {
  if (busy) return;
  busy = true;
  $("main").setAttribute("aria-busy", "true");
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  message("操作进行中，请等待实际结果。关闭页面不会自动取消已经开始的备份。");
  try {
    await fn();
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
    $("main").setAttribute("aria-busy", "false");
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
    $("restore-confirm").disabled = !preview;
    $("prev-page").disabled = !selected || offset === 0;
    $("next-page").disabled = !selected || offset + 100 >= catalogTotal;
    if ($("task-cancel")) $("task-cancel").disabled = !activeTask;
    document.dispatchEvent(new Event("moonrestore-idle"));
  }
}
function show(result) {
  $("result").textContent = JSON.stringify(result, null, 2);
  $("result").closest("details").open = true;
  message(
    result.ok
      ? "本次操作已完成，请查看结果和记录。"
      : "本次操作未通过，请保留源资料并查看记录。",
    !result.ok,
  );
}
async function refresh() {
  const result = await api("jobs");
  $("connection").textContent = "本机会话已连接";
  const list = $("jobs");
  list.replaceChildren();
  list.classList.toggle("empty", result.jobs.length === 0);
  if (!result.jobs.length) {
    list.textContent = "尚无任务。下方添加你的第一个备份任务。";
    return;
  }
  for (const j of result.jobs) {
    const row = node("article", undefined, "job"),
      copy = node("div");
    copy.append(
      node("h3", j.id),
      node("p", j.source),
      node("p", "仓库：" + j.repository),
      node(
        "p",
        j.lastSuccess
          ? "最近成功：" + new Date(j.lastSuccess).toLocaleString()
          : "尚无成功备份记录",
      ),
      node(
        "p",
        j.lastRun?.ok === false
          ? "最近执行失败：" + j.lastRun.error
          : j.overdue
            ? "已到检查时间；请运行任务或启用系统调度。"
            : "尚未到下一次执行时间。",
      ),
    );
    const buttons = node("div", undefined, "actions"),
      open = node("button", "打开版本", "secondary"),
      run = node("button", "立即备份");
    open.type = run.type = "button";
    open.onclick = () =>
      action(async () => {
        $("open-repo").value = j.repository;
        await loadVersions();
        $("versions").scrollIntoView();
      });
    run.onclick = () => {
      if (confirm("将备份任务 " + j.id + " 的源资料，并执行校验。确认继续？"))
        action(async () => {
          show(await api("job-run", { id: j.id, confirmation: j.id }));
          await refresh();
        });
    };
    buttons.append(open, run);
    row.append(copy, buttons);
    list.append(row);
  }
}
async function loadVersions() {
  const r = await api("snapshots", {
    repository: repository(),
    query: $("history-query")?.value || "",
    from: $("history-from")?.value || "",
    to: $("history-to")?.value || "",
    offset: historyOffset,
  });
  if ($("history-page")) {
    $("history-page").textContent =
      String(historyOffset + 1) +
      "–" +
      Math.min(historyOffset + 100, r.total) +
      " / " +
      r.total;
    $("history-page").dataset.more = String(r.more);
    $("history-page").dataset.offset = String(historyOffset);
  }
  selected = null;
  preview = null;
  $("selection").hidden = true;
  $("snapshots").replaceChildren();
  if (!r.snapshots.length) {
    $("snapshots").textContent = "没有匹配的历史版本，请调整筛选或先备份。";
    return;
  }
  $("snapshots").classList.remove("empty");
  for (const s of r.snapshots) {
    const b = node("button", undefined, "snapshot");
    b.type = "button";
    b.dataset.snapshot = s.id;
    b.setAttribute("aria-pressed", "false");
    b.append(
      node(
        "strong",
        (s.label || "未命名版本") +
          " · " +
          new Date(s.created).toLocaleString(),
      ),
      node(
        "span",
        s.entries + " 项 · " + s.logical_bytes + " 字节 · " + s.id.slice(0, 16),
      ),
    );
    b.onclick = () =>
      action(async () => {
        document
          .querySelectorAll(".snapshot")
          .forEach((e) => e.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        selected = s;
        offset = 0;
        preview = null;
        $("selection").hidden = false;
        $("snapshot-id").textContent = s.id;
        $("selected-label").textContent =
          "已选版本：" + (s.label || "未命名版本");
        $("restore-plan").textContent =
          "先预览恢复范围；确认后才会写入新目录。";
        document.dispatchEvent(new Event("moonrestore-selection"));
        await catalog();
        message("已选择历史版本。可以浏览文件、预览恢复或执行演练。");
      });
    $("snapshots").append(b);
  }
}
async function catalog() {
  if (!selected) return;
  const r = await api("catalog", {
    repository: repository(),
    snapshot: selected.id,
    offset,
    query: $("file-filter")?.value || "",
  });
  const table = node("table"),
    head = node("tr");
  for (const text of ["相对路径", "类型", "字节"])
    head.append(node("th", text));
  const thead = node("thead");
  thead.append(head);
  table.append(thead);
  const body = node("tbody");
  for (const e of r.entries) {
    const row = node("tr"),
      cell = node("td"),
      choice = node("button", e.path, "file-choice");
    choice.type = "button";
    choice.onclick = () => {
      $("restore-form").elements.prefix.value = e.path;
      preview = null;
      $("restore-confirm").disabled = true;
      message("已选择 " + e.path + "，请重新预览恢复范围。");
    };
    cell.append(choice);
    row.append(
      cell,
      node("td", e.kind === "dir" ? "目录" : "文件"),
      node("td", e.size),
    );
    body.append(row);
  }
  table.append(body);
  $("catalog").replaceChildren(table);
  $("page-label").textContent =
    offset + 1 + "–" + Math.min(offset + 100, r.total) + " / " + r.total;
}
$("refresh").onclick = () => action(refresh);
$("job-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const j = data(e.target);
    j.intervalMinutes = Number(j.intervalMinutes);
    show(await api("job-save", j));
    await refresh();
  });
};
$("capacity").onclick = () =>
  action(async () => {
    const j = data($("job-form"));
    show(await api("capacity", { repository: j.repository, source: j.source }));
  });
$("init").onclick = () => {
  const j = data($("job-form"));
  if (!j.repository) {
    message("先输入新仓库完整路径。", true);
    return;
  }
  if (
    confirm(
      "在 " +
        j.repository +
        " 创建全新普通仓库？路径必须尚不存在。重要资料需要加密时，请改用 CLI。",
    )
  )
    action(async () =>
      show(
        await api("init", {
          repository: j.repository,
          confirmation: j.repository,
        }),
      ),
    );
};
$("open-form").onsubmit = (e) => {
  e.preventDefault();
  action(loadVersions);
};
$("open-repo").oninput = () => {
  selected = null;
  preview = null;
  $("selection").hidden = true;
  $("snapshots").textContent = "仓库路径已改变，请重新读取版本。";
};
$("restore-form").oninput = () => {
  preview = null;
  $("restore-confirm").disabled = true;
};
$("restore-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!selected) throw new Error("请先选择版本。");
    preview = await api("restore-preview", {
      repository: repository(),
      snapshot: selected.id,
      ...data(e.target),
    });
    $("restore-plan").textContent =
      "将恢复 " +
      preview.files +
      " 个文件、" +
      preview.bytes +
      " 字节。目标必须为全新目录；原资料不会被覆盖。";
    message("预览完成。核对目标路径后再确认恢复。");
  });
};
$("restore-confirm").onclick = () =>
  action(async () => {
    if (!selected || !preview) throw new Error("请重新预览。");
    const r = await api("restore", {
      repository: repository(),
      snapshot: selected.id,
      ...data($("restore-form")),
      confirmation: preview.confirmation,
    });
    preview = null;
    show(r);
  });
$("report").onclick = () =>
  action(async () => show(await api("report", { repository: repository() })));
$("drill").onclick = () =>
  action(async () => {
    if (!selected) throw new Error("请先选择要演练的版本。");
    show(
      await api("drill", { repository: repository(), snapshot: selected.id }),
    );
  });
$("retention").onclick = () =>
  action(async () =>
    show(await api("prune-preview", { repository: repository() })),
  );
$("prev-page").onclick = () =>
  action(async () => {
    offset = Math.max(0, offset - 100);
    await catalog();
  });
$("next-page").onclick = () =>
  action(async () => {
    offset += 100;
    await catalog();
  });
if (!/^[a-f0-9]{64}$/.test(token)) {
  message(
    "启动链接缺少本机会话。请在 CLI 执行 workbench，并使用其完整链接。",
    true,
  );
  $("connection").textContent = "会话未连接";
} else action(refresh);
export {
  $,
  api,
  direct,
  action,
  show,
  refresh,
  data,
  message,
  selected,
  loadVersions,
  catalog,
  setHistoryOffset,
  invalidatePreview,
  setPreview,
  getPreview,
  getJobs,
  getSnapshots,
};
