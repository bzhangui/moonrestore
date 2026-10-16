import {
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
} from "./app.js";
const node = (tag, text) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  return e;
};
const button = (text, fn) => {
  const b = node("button", text);
  b.type = "button";
  b.className = "secondary";
  b.onclick = fn;
  return b;
};
const form = $("job-form");
form.querySelector("button[type=submit]").id = "save-job";
form
  .querySelector(".form-grid")
  .after($("advanced-template").content.cloneNode(true));
$("message").after($("task-template").content.cloneNode(true));
$("open-form").after($("history-template").content.cloneNode(true));
$("catalog").before($("catalog-template").content.cloneNode(true));
$("restore-form").append($("restore-extra-template").content.cloneNode(true));
let editing = null,
  selectedPaths = new Set(),
  searchCursor = null,
  searchState = null,
  searchEntry = 0,
  seen = new Set(),
  initialNotices = true;
const repo = () => $("open-repo").value.trim();
const selectionBody = () => ({
  repository: repo(),
  snapshot: selected?.id,
  target: $("restore-form").elements.target.value,
  selections: selectedPaths.size
    ? [...selectedPaths]
    : $("restore-form").elements.prefix.value
      ? [$("restore-form").elements.prefix.value]
      : [],
  restoreModes: $("restore-modes").checked,
});
function resetEditor() {
  editing = null;
  form.reset();
  form.elements.id.readOnly = false;
  $("save-job").textContent = "保存备份任务";
  $("cancel-edit").hidden = true;
}
function config() {
  const f = data(form);
  return {
    id: f.id,
    repository: f.repository,
    source: f.source,
    intervalMinutes: Number(f.intervalMinutes),
    drillEvery: Number(f.drillEvery),
    reserveBytes: f.reserveBytes,
    maxDropPercent: Number(f.maxDropPercent),
    maxRuntimeMinutes: Number(f.maxRuntimeMinutes),
    retryLimit: Number(f.retryLimit),
    retryMinutes: Number(f.retryMinutes),
    excludes: f.excludes
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    allowEmpty: form.elements.allowEmpty.checked,
    notify: form.elements.notify.checked,
    automatic: form.elements.automatic.checked,
    ...(f.secondaryRepository
      ? { secondaryRepository: f.secondaryRepository }
      : {}),
  };
}
form.onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    const value = config();
    if (editing) {
      if (!confirm("更新任务 " + editing.id + "？已保存的快照不会删除。"))
        return;
      show(
        await api("job-edit", {
          id: editing.id,
          confirmation: editing.revision,
          config: value,
        }),
      );
    } else show(await api("job-save", value));
    resetEditor();
    await refresh();
  });
};
$("cancel-edit").onclick = resetEditor;
function enhanceJobs() {
  for (const row of $("jobs").querySelectorAll(".job")) {
    if (row.dataset.enhanced) continue;
    const job = getJobs().find(
      (j) => j.id === row.querySelector("h3").textContent,
    );
    if (!job) continue;
    row.dataset.enhanced = "true";
    const copy = row.firstElementChild,
      times = node("dl");
    times.className = "evidence-times";
    for (const [key, label] of [
      ["lastBackup", "备份"],
      ["lastVerified", "校验"],
      ["lastDrill", "演练"],
      ["lastReplica", "副本"],
    ]) {
      times.append(
        node("dt", label),
        node("dd", job[key] ? new Date(job[key]).toLocaleString() : "尚无记录"),
      );
    }
    copy.append(times);
    if (job.paused) copy.append(node("p", "已暂停：不会自动运行。"));
    if (job.nextAttempt)
      copy.append(
        node(
          "p",
          "设备离线重试：" + new Date(job.nextAttempt).toLocaleString(),
        ),
      );
    const controls = row.querySelector(".actions");
    controls.append(
      button("编辑", () => {
        form.reset();
        editing = job;
        for (const [key, value] of Object.entries(job)) {
          const field = form.elements[key];
          if (field && field.type !== "checkbox")
            field.value = key === "excludes" ? value.join("\n") : value;
        }
        for (const key of ["allowEmpty", "notify", "automatic"])
          form.elements[key].checked = job[key] === true;
        form.elements.id.readOnly = true;
        $("save-job").textContent = "更新任务";
        $("cancel-edit").hidden = false;
        $("setup").scrollIntoView();
      }),
      button(job.paused ? "恢复任务" : "暂停任务", () =>
        action(async () => {
          show(
            await api("job-change", {
              id: job.id,
              action: job.paused ? "resume" : "pause",
              confirmation: job.revision,
            }),
          );
          await refresh();
        }),
      ),
      button("删除配置", () => {
        if (
          confirm(
            "只删除任务 " +
              job.id +
              " 的配置，不删除任何备份。已有系统计划不会擅自删除，之后调用将因任务不存在而拒绝。确认？",
          )
        )
          action(async () => {
            show(
              await api("job-change", {
                id: job.id,
                action: "delete",
                confirmation: job.revision,
              }),
            );
            await refresh();
          });
      }),
    );
  }
}
new MutationObserver(enhanceJobs).observe($("jobs"), {
  childList: true,
  subtree: true,
});
enhanceJobs();
$("task-cancel").onclick = async () => {
  try {
    const { task } = await direct("task?summary=1");
    if (task?.status === "running") {
      await direct("task-cancel", { id: task.id });
      message("正在请求安全取消；已提交的完整快照保留。");
      $("task-cancel").disabled = true;
    }
  } catch (e) {
    message(e.message, true);
  }
};
for (const control of document.querySelectorAll("[data-pick]"))
  control.onclick = () =>
    action(async () => {
      const response = await api("picker", {
        kind: control.dataset.kind || "folder",
      });
      if (!response.path) return;
      const input = document.querySelector(control.dataset.pick);
      input.value =
        response.path + (control.dataset.newRepo ? "\\MoonRestoreVault" : "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
$("history-filter").onclick = () =>
  action(async () => {
    setHistoryOffset(0);
    await loadVersions();
  });
$("history-prev").onclick = () =>
  action(async () => {
    setHistoryOffset(
      Math.max(0, Number($("history-page").dataset.offset || 0) - 100),
    );
    await loadVersions();
  });
$("history-next").onclick = () =>
  action(async () => {
    setHistoryOffset(Number($("history-page").dataset.offset || 0) + 100);
    await loadVersions();
  });
$("filter-files").onclick = () => action(catalog);
document.addEventListener("moonrestore-idle", () => {
  $("history-prev").disabled =
    Number($("history-page").dataset.offset || 0) === 0;
  $("history-next").disabled = $("history-page").dataset.more !== "true";
  const choices = $("compare-before"),
    value = choices.value;
  choices.replaceChildren();
  for (const s of getSnapshots()) {
    const option = node(
      "option",
      new Date(s.created).toLocaleString() +
        " · " +
        (s.label || s.id.slice(0, 12)),
    );
    option.value = s.id;
    choices.append(option);
  }
  if ([...choices.options].some((o) => o.value === value))
    choices.value = value;
  void updateNotices();
});
function countSelection() {
  $("selection-count").textContent =
    "批量选择：" + selectedPaths.size + " 项（跨当前版本文件分页保留）";
  invalidatePreview();
}
$("restore-form").elements.prefix.addEventListener("input", () => {
  selectedPaths.clear();
  for (const checkbox of $("catalog").querySelectorAll("input[type=checkbox]"))
    checkbox.checked = false;
  countSelection();
});
document.addEventListener("moonrestore-selection", () => {
  selectedPaths.clear();
  countSelection();
});
function enhanceCatalog() {
  for (const row of $("catalog").querySelectorAll("tbody tr")) {
    if (row.dataset.enhanced) continue;
    row.dataset.enhanced = "true";
    const cell = row.firstElementChild,
      relative = cell.querySelector(".file-choice").textContent,
      checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPaths.has(relative);
    checkbox.setAttribute("aria-label", "批量选择 " + relative);
    checkbox.onchange = () => {
      if (checkbox.checked && selectedPaths.size >= 128) {
        checkbox.checked = false;
        message("一次最多选择 128 项。", true);
        return;
      }
      checkbox.checked
        ? selectedPaths.add(relative)
        : selectedPaths.delete(relative);
      $("restore-form").elements.prefix.value = "";
      countSelection();
    };
    cell.prepend(checkbox);
    cell.querySelector(".file-choice").addEventListener("click", () => {
      selectedPaths.clear();
      for (const c of $("catalog").querySelectorAll("input[type=checkbox]"))
        c.checked = false;
      countSelection();
    });
    if (row.children[1].textContent === "文件")
      cell.append(
        button("文本预览", () =>
          action(async () => {
            const result = await api("text-preview", {
              repository: repo(),
              snapshot: selected.id,
              path: relative,
            });
            $("text-preview").textContent = result.text;
            $("text-preview").closest("details").open = true;
          }),
        ),
      );
  }
}
new MutationObserver(enhanceCatalog).observe($("catalog"), {
  childList: true,
  subtree: true,
});
$("restore-form").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    if (!selected) throw new Error("先选择一个历史版本。");
    const plan = await api("restore-preview", selectionBody());
    setPreview(plan);
    $("restore-plan").textContent =
      "将恢复 " +
      plan.files +
      " 个文件、" +
      plan.bytes +
      " 字节；不会覆盖已有目录。";
    message("预览完成，请核对范围及目标后确认。");
  });
};
$("restore-confirm").onclick = () =>
  action(async () => {
    if (!selected || !getPreview()) throw new Error("请先重新预览。");
    const result = await api("restore", {
      ...selectionBody(),
      confirmation: getPreview().confirmation,
    });
    invalidatePreview();
    show(result);
    $("open-restored").hidden = false;
    $("open-restored").dataset.directory = result.destination.target;
  });
$("open-restored").onclick = () =>
  action(async () =>
    show(
      await api("open-folder", {
        directory: $("open-restored").dataset.directory,
      }),
    ),
  );
$("compare").onclick = () =>
  action(async () => {
    if (!selected) throw new Error("先选择要比较的版本。");
    show(
      await api("compare", {
        repository: repo(),
        before: $("compare-before").value,
        after: selected.id,
      }),
    );
  });
$("history-search").onsubmit = (e) => {
  e.preventDefault();
  searchCursor = 0;
  searchState = null;
  searchEntry = 0;
  $("search-results").replaceChildren();
  void searchMore();
};
async function searchMore() {
  await action(async () => {
    const result = await api("search", {
      repository: repo(),
      query: $("search-name").value,
      offset: searchCursor ?? 0,
      entryOffset: searchEntry,
      ...(searchState ? { state: searchState } : {}),
    });
    searchCursor = result.next;
    searchEntry = result.nextEntry;
    searchState = result.state;
    for (const hit of result.results) {
      const row = node("div");
      row.className = "search-hit";
      row.append(
        node("span", hit.path + " · " + new Date(hit.created).toLocaleString()),
        button("打开此版本", async () => {
          $("history-query").value = hit.snapshot;
          setHistoryOffset(0);
          await action(loadVersions);
          const choice = [...$("snapshots").querySelectorAll(".snapshot")].find(
            (b) => b.dataset.snapshot === hit.snapshot,
          );
          if (choice) {
            await choice.onclick();
            $("restore-form").elements.prefix.value = hit.path;
            invalidatePreview();
          }
        }),
      );
      $("search-results").append(row);
    }
    if (!result.results.length)
      $("search-results").append(
        node("p", "本批次没有匹配；可继续搜索其他历史版本。"),
      );
    $("search-more").hidden = searchCursor === null;
    message(
      searchCursor === null
        ? "已搜索完所有历史版本。"
        : "已搜索本批历史版本，点击继续可检索剩余版本。",
    );
  });
}
$("search-more").onclick = searchMore;
const security = () => ({
  repository: $("secure-repository").value.trim(),
  password: $("secure-password").value,
  recoveryKeyFile: $("secure-key").value.trim(),
  remember: $("remember-key").checked,
});
const secretAction = (fn) =>
  action(async () => {
    try {
      await fn();
    } finally {
      $("secure-password").value = "";
      $("new-password").value = "";
    }
  });
$("unlock").onclick = () =>
  secretAction(async () => show(await api("unlock", security())));
$("init-encrypted").onclick = () =>
  secretAction(async () => {
    const s = security();
    if (confirm("在新路径创建加密仓库？请随后单独保存并演练恢复密钥。"))
      show(
        await api("init-encrypted", {
          repository: s.repository,
          password: s.password,
          confirmation: s.repository,
        }),
      );
  });
$("export-key").onclick = () =>
  secretAction(async () => {
    const s = security();
    if (
      !confirm(
        "恢复密钥可解密全部资料。请保存在仓库之外的私有位置，并不要公开。继续导出？",
      )
    )
      return;
    show(
      await api("key-export", {
        repository: s.repository,
        output: $("export-key-path").value,
        confirmation: s.repository,
      }),
    );
  });
$("key-drill").onclick = () =>
  secretAction(async () => {
    const s = security();
    if (!selected) throw new Error("先在版本区域选择要演练的快照。");
    show(
      await api("key-drill", {
        repository: s.repository,
        snapshot: selected.id,
        recoveryKeyFile: s.recoveryKeyFile,
      }),
    );
  });
$("change-password").onclick = () =>
  secretAction(async () => {
    const s = security();
    if (
      !confirm(
        "这只更换密码包装，不更换仓库主密钥，也不能撤销旧配置副本。确认？",
      )
    )
      return;
    show(
      await api("password-change", {
        repository: s.repository,
        newPassword: $("new-password").value,
        confirmation: s.repository,
      }),
    );
  });
$("forget-keys").onclick = () =>
  action(async () => show(await api("lock-session", {})));
$("check-devices").onclick = () =>
  action(async () =>
    show(
      await api("devices", {
        first: form.elements.repository.value,
        second: form.elements.secondaryRepository.value,
      }),
    ),
  );
$("vss-check").onclick = () =>
  action(async () =>
    show(await api("vss-preflight", { source: form.elements.source.value })),
  );
async function updateNotices() {
  try {
    const result = await direct("jobs");
    $("notices").replaceChildren();
    for (const notice of result.notices.slice(0, 5)) {
      $("notices").append(
        node(
          "p",
          new Date(notice.time).toLocaleString() +
            " · " +
            notice.job +
            " · " +
            notice.message,
        ),
      );
      if (
        !initialNotices &&
        !seen.has(notice.id) &&
        globalThis.Notification?.permission === "granted"
      )
        new Notification("MoonRestore", { body: notice.message });
      seen.add(notice.id);
    }
    initialNotices = false;
  } catch {}
}
$("enable-notifications").onclick = async () => {
  if (!globalThis.Notification) {
    message("当前浏览器不支持桌面通知。", true);
    return;
  }
  const permission = await Notification.requestPermission();
  message(
    permission === "granted"
      ? "已允许此浏览器会话的通知。系统计划通知需另勾选任务中的本机提醒。"
      : "未启用浏览器通知，仍可在工作台查看。",
  );
};
let backgroundTask = null,
  watching = false;
setInterval(async () => {
  if (watching || $("main").getAttribute("aria-busy") === "true") return;
  watching = true;
  try {
    const { task } = await direct("task?summary=1");
    if ($("main").getAttribute("aria-busy") === "true" || !task) return;
    if (task.status === "running") {
      backgroundTask = task.id;
      $("task-status").hidden = false;
      $("task-progress").textContent =
        "后台任务阶段：" +
        task.progress.phase +
        " · 已读 " +
        (task.progress.read_bytes ?? 0) +
        " 字节 · 已校验 " +
        (task.progress.verified_bytes ?? 0) +
        " 字节";
      $("task-cancel").disabled = task.cancel_requested;
    } else if (backgroundTask === task.id) {
      backgroundTask = null;
      $("task-cancel").disabled = true;
      message(
        task.status === "completed"
          ? "后台任务完成；请查看分别记录的备份、校验、演练和副本时间。"
          : task.error || "后台任务未完成，请查看任务记录。",
        task.status !== "completed",
      );
      await refresh();
    }
  } catch {
    /* Explicit actions keep the actionable error; do not spam disconnected pages. */
  } finally {
    watching = false;
  }
}, 1000);
