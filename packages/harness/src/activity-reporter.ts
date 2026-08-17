import http from "node:http";
import {
  DEFAULT_HARNESS_CONTROL_SOCKET_PATH,
  type RuntimeActivitySignal,
} from "./activity-controller.js";
import {
  CODEX_THREAD_STATUSES,
  CODEX_TURN_STATUSES,
  type CodexDiagnosticSource,
  type CodexDiagnosticSink,
  type CodexLifecycleDiagnostic,
  type CodexLifecycleStatus,
  type CodexThreadClassification,
} from "./runtime-diagnostics.js";

export interface ReportRuntimeActivityOptions {
  socketPath?: string;
  generation?: string;
  timeoutMs?: number;
}

let reportQueue: Promise<void> = Promise.resolve();
let diagnosticReportQueue: Promise<void> = Promise.resolve();

export function runtimeActivityForCodexNotification(
  method: string,
  params: unknown,
): RuntimeActivitySignal | null {
  if (method === "turn/started") return "working";
  if (method !== "turn/completed") return null;
  const turn = params && typeof params === "object"
    ? (params as { turn?: { status?: unknown } }).turn
    : undefined;
  if (turn?.status === "completed") return "completed";
  if (turn?.status === "interrupted" || turn?.status === "failed") return "idle";
  return null;
}

function codexNotificationThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const notification = params as Record<string, unknown>;
  for (const key of ["thread-id", "thread_id", "threadId"]) {
    const value = notification[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function codexNotificationTurn(
  params: unknown,
): { id: string | null; status: CodexLifecycleStatus } {
  const turn = params && typeof params === "object"
    ? (params as { turn?: { id?: unknown; status?: unknown } }).turn
    : undefined;
  return {
    id: typeof turn?.id === "string" && turn.id.trim() ? turn.id.trim() : null,
    status: normalizeCodexLifecycleStatus(turn?.status, CODEX_TURN_STATUSES),
  };
}

function normalizeCodexLifecycleStatus<T extends CodexLifecycleStatus>(
  value: unknown,
  allowed: readonly T[],
): T | "unknown" {
  const candidate = typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? (value as { type?: unknown }).type
      : undefined;
  return typeof candidate === "string" && allowed.includes(candidate as T)
    ? candidate as T
    : "unknown";
}

interface CodexForegroundActivityTrackerOptions {
  diagnosticSink?: CodexDiagnosticSink;
  diagnosticTimestamp?: () => string;
}

export class CodexForegroundActivityTracker {
  private foregroundThreadId: string | null = null;
  private foregroundTurnActive = false;
  private readonly parentThreadIds = new Map<string, string | null>();

  constructor(private readonly options: CodexForegroundActivityTrackerOptions = {}) {}

  registerThread(
    thread: { id: string; parentThreadId: string | null; status?: unknown },
    source: CodexDiagnosticSource = "discovery",
  ): CodexThreadClassification {
    const threadId = thread.id.trim();
    if (!threadId) return "invalid";
    const parentThreadId = thread.parentThreadId?.trim() || null;
    this.parentThreadIds.set(threadId, parentThreadId);
    const classification = parentThreadId === null ? "root" : "child";
    this.emitDiagnostic({
      component: "codex_lifecycle",
      event: "thread_classified",
      threadId,
      parentThreadId,
      status: normalizeCodexLifecycleStatus(thread.status, CODEX_THREAD_STATUSES),
      classification,
      activity: "ignored",
      source,
      timestamp: this.timestamp(),
    });
    return classification;
  }

  markThreadActive(threadId: string): RuntimeActivitySignal | null {
    const normalizedThreadId = threadId.trim();
    if (
      !normalizedThreadId
      || !this.parentThreadIds.has(normalizedThreadId)
      || this.parentThreadIds.get(normalizedThreadId) !== null
    ) return null;
    if (this.foregroundTurnActive) return null;
    this.foregroundThreadId = normalizedThreadId;
    this.foregroundTurnActive = true;
    return "working";
  }

  settleThread(
    threadId: string,
    signal: Exclude<RuntimeActivitySignal, "working">,
  ): RuntimeActivitySignal | null {
    const normalizedThreadId = threadId.trim();
    if (!this.foregroundTurnActive || normalizedThreadId !== this.foregroundThreadId) return null;
    this.foregroundTurnActive = false;
    return signal;
  }

  handleNotification(method: string, params: unknown): RuntimeActivitySignal | null {
    if (method === "thread/started") {
      const thread = params && typeof params === "object"
        ? (params as { thread?: { id?: unknown; parentThreadId?: unknown; status?: unknown } }).thread
        : undefined;
      const threadId = typeof thread?.id === "string" && thread.id.trim()
        ? thread.id.trim()
        : null;
      const parentThreadId = typeof thread?.parentThreadId === "string"
        ? thread.parentThreadId.trim() || null
        : null;
      this.emitDiagnostic({
        component: "codex_lifecycle",
        event: "thread_started",
        threadId,
        parentThreadId,
        status: normalizeCodexLifecycleStatus(thread?.status, CODEX_THREAD_STATUSES),
        classification: threadId ? (parentThreadId === null ? "root" : "child") : "invalid",
        activity: "ignored",
        source: "notification",
        timestamp: this.timestamp(),
      });
      if (threadId) {
        this.registerThread({
          id: threadId,
          parentThreadId,
          status: thread?.status,
        }, "notification");
      }
      return null;
    }

    const signal = runtimeActivityForCodexNotification(method, params);
    if (method !== "turn/started" && method !== "turn/completed") return null;
    const threadId = codexNotificationThreadId(params);
    const classification = this.classifyThread(threadId);
    let activity: RuntimeActivitySignal | null = null;
    if (threadId && signal) {
      if (method === "turn/started") activity = this.markThreadActive(threadId);
      else if (signal !== "working") activity = this.settleThread(threadId, signal);
    }
    const turn = codexNotificationTurn(params);
    this.emitDiagnostic({
      component: "codex_lifecycle",
      event: method === "turn/started" ? "turn_started" : "turn_completed",
      threadId,
      turnId: turn.id,
      status: turn.status,
      classification,
      activity: activity ?? "ignored",
      timestamp: this.timestamp(),
    });
    return activity;
  }

  private classifyThread(threadId: string | null): CodexThreadClassification {
    if (!threadId) return "invalid";
    if (!this.parentThreadIds.has(threadId)) return "unknown";
    return this.parentThreadIds.get(threadId) === null ? "root" : "child";
  }

  private timestamp(): string {
    try {
      return this.options.diagnosticTimestamp?.() ?? new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  private emitDiagnostic(diagnostic: CodexLifecycleDiagnostic): void {
    try {
      this.options.diagnosticSink?.(diagnostic);
    } catch {
      // Diagnostics must never influence lifecycle classification.
    }
  }
}

export function reportRuntimeActivity(
  state: RuntimeActivitySignal,
  options: ReportRuntimeActivityOptions = {},
): Promise<boolean> {
  const report = reportQueue.then(
    () => sendRuntimeActivity(state, options),
    () => sendRuntimeActivity(state, options),
  );
  reportQueue = report.then(() => undefined, () => undefined);
  return report;
}

export function reportRuntimeDiagnostic(
  diagnostic: CodexLifecycleDiagnostic,
  options: ReportRuntimeActivityOptions = {},
): Promise<boolean> {
  const report = diagnosticReportQueue.then(
    () => sendHarnessControl("/diagnostic", { diagnostic }, options),
    () => sendHarnessControl("/diagnostic", { diagnostic }, options),
  );
  diagnosticReportQueue = report.then(() => undefined, () => undefined);
  return report;
}

function sendRuntimeActivity(
  state: RuntimeActivitySignal,
  options: ReportRuntimeActivityOptions,
): Promise<boolean> {
  return sendHarnessControl("/activity", { state }, options);
}

function sendHarnessControl(
  path: "/activity" | "/diagnostic",
  payload: Record<string, unknown>,
  options: ReportRuntimeActivityOptions,
): Promise<boolean> {
  const socketPath = options.socketPath
    ?? process.env.TILLER_HARNESS_CONTROL_SOCKET
    ?? DEFAULT_HARNESS_CONTROL_SOCKET_PATH;
  const generation = options.generation
    ?? process.env.TILLER_ACTIVITY_GENERATION
    ?? "";
  if (!generation) return Promise.resolve(false);
  const body = JSON.stringify({ ...payload, generation });
  return new Promise((resolve) => {
    const req = http.request({
      socketPath,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseBody) as { ok?: unknown; accepted?: unknown };
          resolve(res.statusCode === 200 && parsed.ok === true && parsed.accepted === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.setTimeout(
      options.timeoutMs ?? 1_500,
      () => req.destroy(new Error("activity control timed out")),
    );
    req.on("error", () => resolve(false));
    req.end(body);
  });
}
