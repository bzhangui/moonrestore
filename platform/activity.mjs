// A process-local task context; progress contains counts, never file names or keys.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
const storage = new AsyncLocalStorage();
export const activity = () => storage.getStore();
export async function withBudget(minutes, work) {
  const parent = activity(),
    controller = new AbortController(),
    forward = () => controller.abort();
  parent?.signal?.addEventListener("abort", forward, { once: true });
  if (parent?.signal?.aborted) forward();
  const timer = setTimeout(forward, minutes * 60000);
  try {
    return await storage.run(
      { ...parent, signal: controller.signal, budgetMs: minutes * 60000 },
      work,
    );
  } finally {
    clearTimeout(timer);
    parent?.signal?.removeEventListener("abort", forward);
  }
}
export const credentials = (repository) =>
  activity()?.credentials?.(repository) || {};
export const withCredentials = (resolve, work) =>
  storage.run({ ...activity(), credentials: resolve }, work);
export function checkpoint(phase, extra = {}) {
  const context = activity();
  if (context?.signal?.aborted) throw new Error("Operation cancelled");
  context?.progress?.({ phase, ...extra });
}
export class TaskManager {
  constructor() {
    this.current = null;
    this.controller = null;
  }
  start(work, { minutes = 30, credentials } = {}) {
    if (this.current?.status === "running")
      throw new Error("An operation is already running");
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      throw new Error("Budget must be 1..1440 minutes");
    const controller = new AbortController(),
      task = {
        id: randomUUID(),
        status: "running",
        started: new Date().toISOString(),
        progress: { phase: "starting" },
        cancel_requested: false,
      };
    this.current = task;
    this.controller = controller;
    const timer = setTimeout(() => {
      task.cancel_requested = true;
      controller.abort();
    }, minutes * 60000);
    task.promise = storage.run(
      {
        signal: controller.signal,
        budgetMs: minutes * 60000,
        credentials,
        progress: (value) => {
          task.progress = { ...value, updated: new Date().toISOString() };
        },
      },
      async () => {
        try {
          const result = await work();
          task.result = result;
          task.status = controller.signal.aborted
            ? "cancelled"
            : result?.ok === false
              ? "failed"
              : "completed";
        } catch (error) {
          task.status = controller.signal.aborted ? "cancelled" : "failed";
          task.error = controller.signal.aborted
            ? "操作已请求取消；已提交的完整快照保留。"
            : "操作失败：" + String(error.message).slice(0, 240);
        } finally {
          clearTimeout(timer);
          credentials?.dispose?.();
          task.finished = new Date().toISOString();
        }
      },
    );
    return this.state();
  }
  state() {
    if (!this.current) return null;
    const { promise, ...publicState } = this.current;
    return publicState;
  }
  cancel(id) {
    if (
      !this.current ||
      id !== this.current.id ||
      this.current.status !== "running"
    )
      throw new Error("No matching running operation");
    this.current.cancel_requested = true;
    this.controller.abort();
    return this.state();
  }
  async close() {
    if (this.current?.status === "running") this.cancel(this.current.id);
    await this.current?.promise;
  }
}
