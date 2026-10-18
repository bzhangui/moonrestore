import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { checked, rememberKey, rewrapVault, writePrivate } from "./vault.mjs";
import {
  core,
  health,
  drill,
  capacity,
  options,
  openHost,
  advanced,
} from "./maintenance.mjs";
import { saveJob, listJobs, runJob, changeJob } from "./jobs.mjs";
import { previewPrune } from "./retention.mjs";
import { TaskManager, withCredentials } from "./activity.mjs";
import {
  history,
  searchHistory,
  restorePlan,
  restoreSelected,
  previewText,
} from "./explorer.mjs";
import {
  choosePath,
  openFolder,
  deviceRelation,
  vssPreflight,
} from "./system.mjs";
import { notices } from "./notifications.mjs";
import {
  rescuePlan,
  rescueToNewTarget,
  recoveryChecklist,
  rebuildCopy,
  scrub,
  recoveryHealth,
} from "./recovery.mjs";
import { randomUUID } from "node:crypto";
import { savePlan, listPlans, runPlan } from "./plans.mjs";
import {
  configureSchedule,
  scheduledPlans,
  runDuePlans,
} from "./plan-scheduler.mjs";
import {
  createOperation,
  runOperation,
  operationStatus,
} from "./operations.mjs";

const ui = fileURLToPath(new URL("../ui/", import.meta.url));
function object(value, allowed) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new Error("Invalid request fields");
}
export async function startWorkbench({
  port = 8790,
  token = randomBytes(32).toString("hex"),
  autoRun = false,
  autoIntervalMs = 15000,
} = {}) {
  if (
    typeof autoRun !== "boolean" ||
    !Number.isInteger(autoIntervalMs) ||
    autoIntervalMs < 1000 ||
    autoIntervalMs > 60000 ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new Error("Invalid workbench options");
  let busy = false,
    origin,
    closing = false;
  const tasks = new TaskManager(),
    secrets = new Map();
  const secretKey = (value) =>
    process.platform === "win32"
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  const credentialSource = (repository) => {
    if (typeof repository !== "string") return {};
    const key = secretKey(repository),
      value = secrets.get(key);
    if (value && value.expires > Date.now()) return value.env;
    if (value) secrets.delete(key);
    return {};
  };
  const captureCredentials = () => {
    const now = Date.now(),
      values = new Map(
        [...secrets]
          .filter(([, v]) => v.expires > now)
          .map(([key, value]) => [key, { ...value.env }]),
      );
    const resolve = (repository) =>
      typeof repository === "string"
        ? values.get(secretKey(repository)) || {}
        : {};
    resolve.dispose = () => values.clear();
    return resolve;
  };
  const runRoute = async (route, p) => {
    switch (route) {
      case "emergency-list": {
        object(p, ["repository", "recoveryKeyFile"]);
        if (
          p.recoveryKeyFile !== undefined &&
          typeof p.recoveryKeyFile !== "string"
        )
          throw new Error("Invalid recovery key path");
        return core(["list", p.repository], {
          env: {
            MOONRESTORE_READ_ONLY: "1",
            MOONRESTORE_RECOVERY_TARGET: "",
            ...(p.recoveryKeyFile
              ? {
                  MOONRESTORE_PASSWORD: "",
                  MOONRESTORE_KEY_FILE: checked(p.recoveryKeyFile),
                }
              : {}),
          },
        });
      }
      case "rescue-preview":
        object(p, [
          "repository",
          "snapshot",
          "target",
          "selections",
          "recoveryKeyFile",
        ]);
        return rescuePlan(p);
      case "rescue-apply":
        object(p, [
          "repository",
          "snapshot",
          "target",
          "selections",
          "recoveryKeyFile",
          "confirmation",
          "acceptPartial",
        ]);
        return rescueToNewTarget(p);
      case "recovery-health":
        object(p, ["repository", "maxAgeHours"]);
        return recoveryHealth(p.repository, { maxAgeHours: p.maxAgeHours });
      case "plans":
        object(p, []);
        return listPlans();
      case "plan-save":
        return savePlan(p);
      case "plan-schedules":
        object(p, []);
        return scheduledPlans();
      case "plan-schedule":
        object(p, ["id", "config", "confirmation"]);
        return configureSchedule(p.id, p.config, p.confirmation);
      case "plan-run":
        object(p, ["id", "recover", "acceptAnomaly"]);
        return runPlan(p.id, {
          recover: p.recover ?? false,
          acceptAnomaly: p.acceptAnomaly ?? false,
        });
      case "operation-status":
        object(p, ["repository", "id"]);
        return { ...operationStatus(p.repository, p.id), ok: true };
      case "operation-resume":
        object(p, ["repository", "id", "recover"]);
        if (p.recover !== undefined && typeof p.recover !== "boolean")
          throw new Error("Strict recovery flag required");
        return runOperation(p.repository, p.id, {
          recover: p.recover === true,
        });
      case "restore-resumable": {
        object(p, ["repository", "snapshot", "target", "confirmation"]);
        if (p.confirmation !== p.target)
          throw new Error("Explicit new target confirmation required");
        const id = await createOperation({
          repository: p.repository,
          snapshot: p.snapshot,
          target: p.target,
        });
        return runOperation(p.repository, id);
      }
      case "scrub":
        object(p, ["repository", "maxFiles", "maxBytes", "snapshot"]);
        return scrub(p.repository, {
          maxFiles: p.maxFiles,
          maxBytes: p.maxBytes,
          snapshot: p.snapshot,
        });
      case "recovery-checklist":
        object(p, ["repository", "output", "confirmation"]);
        if (p.confirmation !== p.output)
          throw new Error("Explicit new checklist path confirmation required");
        return recoveryChecklist(p.repository, p.output);
      case "rebuild-copy":
        object(p, [
          "repository",
          "snapshot",
          "donor",
          "destination",
          "confirmation",
          "destinationPassword",
        ]);
        if (p.confirmation !== p.destination)
          throw new Error("Explicit new rebuild destination required");
        return rebuildCopy(p.repository, p.snapshot, p.donor, p.destination, {
          destinationPassword: p.destinationPassword,
        });
      case "job-save":
        return saveJob(p);
      case "job-edit":
        object(p, ["id", "confirmation", "config"]);
        if (!p.config || p.config.id !== p.id)
          throw new Error("Invalid job edit");
        return saveJob(p.config, {
          replace: true,
          confirmation: p.confirmation,
        });
      case "job-change":
        object(p, ["id", "action", "confirmation"]);
        return changeJob(p.id, p.action, p.confirmation);
      case "job-run":
        object(p, ["id", "confirmation"]);
        if (p.confirmation !== p.id)
          throw new Error("Explicit job confirmation required");
        return runJob(p.id);
      case "snapshots":
        object(p, ["repository", "query", "from", "to", "offset"]);
        return history(p.repository, p);
      case "search":
        object(p, ["repository", "query", "offset", "entryOffset", "state"]);
        return searchHistory(p.repository, p);
      case "catalog": {
        object(p, ["repository", "snapshot", "offset", "query"]);
        if (
          !Number.isInteger(p.offset ?? 0) ||
          (p.offset ?? 0) < 0 ||
          (p.offset ?? 0) > 100000 ||
          typeof (p.query ?? "") !== "string" ||
          (p.query ?? "").length > 200
        )
          throw new Error("Invalid catalog filters");
        const data = await core(["catalog", p.repository, p.snapshot]);
        data.entries = data.entries.filter(
          (e) =>
            !p.query || e.path.toLowerCase().includes(p.query.toLowerCase()),
        );
        data.total = data.entries.length;
        data.entries = data.entries.slice(p.offset ?? 0, (p.offset ?? 0) + 100);
        data.entries = data.entries.map(({ path, kind, size, hash }) => ({
          path,
          kind,
          size,
          hash,
        }));
        return data;
      }
      case "compare":
        object(p, ["repository", "before", "after"]);
        return core(["diff", p.repository, p.before, p.after]);
      case "text-preview":
        object(p, ["repository", "snapshot", "path"]);
        return previewText(p.repository, p.snapshot, p.path);
      case "restore-preview": {
        object(p, [
          "repository",
          "snapshot",
          "target",
          "prefix",
          "selections",
          "restoreModes",
        ]);
        const result = await restorePlan(p);
        delete result.plan;
        return result;
      }
      case "restore":
        object(p, [
          "repository",
          "snapshot",
          "target",
          "prefix",
          "selections",
          "confirmation",
          "restoreModes",
        ]);
        return restoreSelected(p);
      case "report":
        object(p, ["repository", "snapshot"]);
        return health(p.repository, p.snapshot || "all");
      case "drill":
        object(p, ["repository", "snapshot"]);
        return drill(p.repository, p.snapshot);
      case "capacity":
        object(p, ["repository", "source"]);
        return capacity(p.repository, p.source);
      case "prune-preview": {
        object(p, ["repository"]);
        const result = await previewPrune(p.repository);
        delete result.plan.entries;
        return result;
      }
      case "init":
        object(p, ["repository", "confirmation"]);
        if (p.confirmation !== p.repository)
          throw new Error("Explicit repository confirmation required");
        return { ...(await core(["init", p.repository])), ok: true };
      case "init-encrypted": {
        object(p, ["repository", "password", "confirmation"]);
        if (p.confirmation !== p.repository || typeof p.password !== "string")
          throw new Error("Explicit encrypted initialization required");
        const result = await core(["init", p.repository], {
          env: {
            MOONRESTORE_INIT_ENCRYPTED: "1",
            MOONRESTORE_PASSWORD: p.password,
            MOONRESTORE_KEY_FILE: "",
          },
        });
        secrets.set(secretKey(p.repository), {
          expires: Date.now() + 1800000,
          env: { MOONRESTORE_PASSWORD: p.password, MOONRESTORE_KEY_FILE: "" },
        });
        return { ...result, ok: true };
      }
      case "unlock": {
        object(p, ["repository", "password", "recoveryKeyFile", "remember"]);
        if (
          (p.password !== undefined && typeof p.password !== "string") ||
          (p.recoveryKeyFile !== undefined &&
            typeof p.recoveryKeyFile !== "string") ||
          (p.remember !== undefined && typeof p.remember !== "boolean")
        )
          throw new Error("Invalid unlock request");
        const env = {
            ...process.env,
            MOONRESTORE_PASSWORD: p.password || "",
            MOONRESTORE_KEY_FILE: p.recoveryKeyFile || "",
          },
          host = openHost(p.repository, { environment: env });
        try {
          if (!host.key) throw new Error("Repository is not encrypted");
          if (p.remember) rememberKey(host.vault, host.key);
          secrets.set(secretKey(p.repository), {
            expires: Date.now() + 1800000,
            env: p.remember
              ? { MOONRESTORE_PASSWORD: "", MOONRESTORE_KEY_FILE: "" }
              : {
                  MOONRESTORE_PASSWORD: p.password || "",
                  MOONRESTORE_KEY_FILE: p.recoveryKeyFile || "",
                },
          });
          return {
            ok: true,
            unlocked_for_minutes: 30,
            persisted_password: false,
            dpapi_requested: !!p.remember,
          };
        } finally {
          host.clean();
        }
      }
      case "lock-session":
        object(p, []);
        secrets.clear();
        return { ok: true, session_credentials_forgotten: true };
      case "key-export":
        object(p, ["repository", "output", "confirmation"]);
        if (p.confirmation !== p.repository)
          throw new Error("Explicit key export required");
        return advanced(["key-export", p.repository, "--output", p.output]);
      case "key-drill":
        object(p, ["repository", "snapshot", "recoveryKeyFile"]);
        if (typeof p.recoveryKeyFile !== "string" || !p.recoveryKeyFile)
          throw new Error("Independent recovery key required");
        return drill(p.repository, p.snapshot, {
          env: {
            MOONRESTORE_PASSWORD: "",
            MOONRESTORE_KEY_FILE: checked(p.recoveryKeyFile),
          },
        });
      case "password-change": {
        object(p, ["repository", "newPassword", "confirmation"]);
        if (
          p.confirmation !== p.repository ||
          typeof p.newPassword !== "string"
        )
          throw new Error("Explicit password change required");
        const host = openHost(p.repository);
        try {
          host.lock();
          if (!host.key) throw new Error("Not encrypted");
          const config = rewrapVault(host.vault, host.key, p.newPassword),
            temp = host.repoPath("tmp/" + randomUUID() + ".keyconfig");
          writePrivate(temp, JSON.stringify(config));
          fs.renameSync(temp, host.repoPath("encryption.json"));
          secrets.set(secretKey(p.repository), {
            expires: Date.now() + 1800000,
            env: {
              MOONRESTORE_PASSWORD: p.newPassword,
              MOONRESTORE_KEY_FILE: "",
            },
          });
          return {
            ok: true,
            password_changed: true,
            repository_master_key_rotated: false,
            old_config_copies_not_revoked: true,
          };
        } finally {
          host.clean();
        }
      }
      case "picker":
        object(p, ["kind"]);
        return choosePath(p.kind);
      case "open-folder":
        object(p, ["directory"]);
        return openFolder(p.directory);
      case "devices":
        object(p, ["first", "second"]);
        return deviceRelation(p.first, p.second);
      case "vss-preflight":
        object(p, ["source"]);
        return vssPreflight(p.source);
      default:
        throw new Error("Unknown operation");
    }
  };
  const routes = [
    "plans",
    "plan-save",
    "plan-run",
    "plan-schedules",
    "plan-schedule",
    "operation-status",
    "operation-resume",
    "restore-resumable",
    "emergency-list",
    "rescue-preview",
    "rescue-apply",
    "recovery-health",
    "scrub",
    "recovery-checklist",
    "rebuild-copy",
    "job-save",
    "job-edit",
    "job-change",
    "job-run",
    "snapshots",
    "search",
    "catalog",
    "compare",
    "text-preview",
    "restore-preview",
    "restore",
    "report",
    "drill",
    "capacity",
    "prune-preview",
    "init",
    "init-encrypted",
    "unlock",
    "lock-session",
    "key-export",
    "key-drill",
    "password-change",
    "picker",
    "open-folder",
    "devices",
    "vss-preflight",
  ];
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, { ok: false, error: "来源被拒绝" });
      return;
    }
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      send(400, { ok: false, error: "无效请求地址" });
      return;
    }
    if (
      req.method === "GET" &&
      [
        "/",
        "/app.js",
        "/enhancements.js",
        "/recovery.js",
        "/durable.js",
        "/style.css",
      ].includes(url.pathname)
    ) {
      const file = path.join(
        ui,
        {
          "/": "index.html",
          "/app.js": "app.js",
          "/enhancements.js": "enhancements.js",
          "/recovery.js": "recovery.js",
          "/durable.js": "durable.js",
          "/style.css": "style.css",
        }[url.pathname],
      );
      try {
        const bytes = fs.readFileSync(file);
        res.writeHead(200, {
          "Content-Type": url.pathname.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : url.pathname.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        });
        res.end(bytes);
      } catch {
        send(500, { ok: false, error: "工作台资源缺失，请重新检查发行包。" });
      }
      return;
    }
    const supplied = req.headers.authorization?.replace(/^Bearer /, "") || "";
    if (
      Buffer.byteLength(supplied) !== token.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      send(401, {
        ok: false,
        error: "本机会话未授权，请使用启动时提供的完整链接。",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs") {
      try {
        send(200, {
          ok: true,
          jobs: listJobs(),
          busy: busy || tasks.state()?.status === "running",
          notices: notices(),
        });
      } catch {
        send(400, {
          ok: false,
          error: "任务配置无法读取，请在本机修复后重试。",
        });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/task") {
      const task = tasks.state();
      if (task && url.searchParams.get("summary") === "1") delete task.result;
      send(200, { ok: true, task });
      return;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== origin ||
      req.headers["content-type"] !== "application/json"
    ) {
      send(403, { ok: false, error: "请求方法、来源或内容类型不正确" });
      return;
    }
    const route = url.pathname.replace(/^\/api\//, "");
    if (closing) {
      send(503, { ok: false, error: "工作台正在安全停止。" });
      return;
    }
    if (
      route !== "task-cancel" &&
      (busy || tasks.state()?.status === "running")
    ) {
      send(409, {
        ok: false,
        error: "已有操作正在执行；可以查看进度或请求取消。",
      });
      return;
    }
    if (
      !routes.includes(route) &&
      !["task-start", "task-cancel"].includes(route)
    ) {
      send(404, { ok: false, error: "操作不存在" });
      return;
    }
    if (route !== "task-cancel") busy = true;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) throw new Error("Request body exceeds 64 KiB");
        chunks.push(chunk);
      }
      const p = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result;
      if (route === "task-cancel") {
        object(p, ["id"]);
        send(200, { ok: true, task: tasks.cancel(p.id) });
        return;
      }
      if (route === "task-start") {
        object(p, ["route", "body", "minutes"]);
        if (
          !routes.includes(p.route) ||
          [
            "unlock",
            "password-change",
            "init-encrypted",
            "picker",
            "key-export",
            "lock-session",
          ].includes(p.route)
        )
          throw new Error("Operation must use a direct confirmed request");
        result = {
          ok: true,
          task: tasks.start(() => runRoute(p.route, p.body), {
            minutes: p.minutes ?? 30,
            credentials: captureCredentials(),
          }),
        };
      } else
        result = await withCredentials(credentialSource, () =>
          runRoute(route, p),
        );
      send(200, result);
    } catch (e) {
      send(400, {
        ok: false,
        error:
          "操作未完成：" +
          String(e.message).slice(0, 240) +
          "。原始资料不会被自动删除。",
      });
    } finally {
      if (route !== "task-cancel") busy = false;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  const expireSecrets = setInterval(() => {
    for (const [key, value] of secrets)
      if (value.expires <= Date.now()) secrets.delete(key);
  }, 60000);
  const automatic = autoRun
    ? setInterval(() => {
        if (closing || busy || tasks.state()?.status === "running") return;
        try {
          const nextPlan = scheduledPlans().schedules.find(
            (s) =>
              s.enabled &&
              s.state !== "blocked" &&
              (s.overdue || s.clock_discontinuity || s.state === "running"),
          );
          if (nextPlan) {
            tasks.start(() => runDuePlans(), {
              minutes: nextPlan.maxRuntimeMinutes,
              credentials: captureCredentials(),
            });
            return;
          }
          const due = listJobs().find((j) => j.automatic && j.overdue);
          if (due)
            tasks.start(() => runJob(due.id), {
              minutes: due.maxRuntimeMinutes ?? 30,
              credentials: captureCredentials(),
            });
        } catch {
          /* Invalid state must not turn into a backup of guessed paths. */
        }
      }, autoIntervalMs)
    : null;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        origin = "http://127.0.0.1:" + server.address().port;
        resolve();
      });
    });
  } catch (error) {
    clearInterval(expireSecrets);
    if (automatic) clearInterval(automatic);
    throw error;
  }
  return {
    server,
    origin,
    token,
    url: origin + "/#" + token,
    close: async () => {
      closing = true;
      clearInterval(expireSecrets);
      if (automatic) clearInterval(automatic);
      await tasks.close();
      secrets.clear();
      await new Promise((resolve) => {
        server.closeIdleConnections();
        server.close(resolve);
      });
    },
  };
}
export async function workbenchCommand(args) {
  if (args[0] !== "workbench") return null;
  const { values: v, positionals: p } = options(args.slice(1), ["port"]);
  if (p.length || (v.port && !/^[0-9]{1,5}$/.test(v.port)))
    throw new Error("Usage: workbench [--port 8790]");
  const app = await startWorkbench({
    port: v.port === undefined ? 8790 : Number(v.port),
    autoRun: true,
  });
  console.log(
    "MoonRestore 本机工作台（此链接含临时授权，请勿公开）：\n" +
      app.url +
      "\nCtrl+C 停止；只监听本机回环。",
  );
  return new Promise((resolve) => {
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await app.close();
      resolve({ ok: true, stopped: true });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
