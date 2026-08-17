import { cfTransportHeaders } from "../config.js";

// ── Hub callback contract ────────────────────────────────────────────
// Mirrors packages/hub/api/planner/runtime-routes.ts. Every request carries
// the run-scoped HMAC token plus the CF Access service-token headers.

export const PLANNER_RUN_TOKEN_HEADER = "X-Tiller-Planner-Run-Token";
export const CALLBACK_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_MODEL_ACTIVITY_EVENTS_PER_RUN = 40;

export type PlannerRunEvent =
  | { type: "runtime_startup" }
  | { type: "model_activity"; message: string }
  | { type: "model_commentary"; message: string };

export type PlannerModelEventType = Extract<
  PlannerRunEvent,
  { message: string }
>["type"];

export interface PlannerRunContext {
  run: {
    runId: string;
    repoId: string;
    planArtifactId: string;
    role: "reviewer";
    provider: string;
    model: string;
    skill?: string;
    status: string;
  };
  input: {
    instruction?: string;
    githubBaseCommitSha?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "ultra" | "max";
  };
  plan: {
    id: string;
    title: string;
    version: number;
    markdown: string;
  };
  skillInstructions: string;
  threadMessages: Array<{ seq?: number; body?: { role?: string; text?: string } }>;
  threadMessagesTruncated: boolean;
}

export type PlannerRunResult =
  | { status: "succeeded"; text: string }
  | { status: "failed"; error: string };

export interface PlannerHubCallbackOptions {
  baseUrl: string;
  runToken: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

class NonRetriableCallbackError extends Error {}

/**
 * Keeps model activity ordered without letting a fast provider build an
 * unbounded callback backlog. While one request is active, only the newest
 * pending activity is retained.
 */
export class ModelActivityPublisher {
  private inFlight: Promise<void> | null = null;
  private pending = new Map<PlannerModelEventType, {
    message: string;
    type: PlannerModelEventType;
    order: number;
  }>();
  private lastAccepted: string | null = null;
  private nextOrder = 0;

  constructor(private readonly send: (
    message: string,
    type: PlannerModelEventType,
  ) => Promise<void>) {}

  publish(message: string, type: PlannerModelEventType = "model_activity"): void {
    const normalized = message.trim();
    const signature = `${type}\0${normalized}`;
    if (!normalized || signature === this.lastAccepted) return;
    this.lastAccepted = signature;
    const event = { message: normalized, type, order: this.nextOrder };
    this.nextOrder += 1;
    if (this.inFlight) {
      // Tool events can be extremely noisy, but commentary must not be lost
      // merely because the next command started while a callback was in
      // flight. Retain the newest pending event of each kind.
      this.pending.set(type, event);
      return;
    }
    this.start(event);
  }

  async flush(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private start(event: {
    message: string;
    type: PlannerModelEventType;
    order: number;
  }): void {
    const request = this.send(event.message, event.type).catch(() => undefined);
    this.inFlight = request;
    void request.then(() => {
      if (this.inFlight !== request) return;
      this.inFlight = null;
      const next = [...this.pending.values()].sort((left, right) => left.order - right.order)[0];
      if (next) this.pending.delete(next.type);
      if (next) this.start(next);
    });
  }
}

export class PlannerHubCallback {
  readonly baseUrl: string;
  lastRunStatus: string | null = null;
  private readonly runToken: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly activityPublisher: ModelActivityPublisher;
  private modelActivityBudget = MAX_MODEL_ACTIVITY_EVENTS_PER_RUN;

  constructor(options: PlannerHubCallbackOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.runToken = options.runToken;
    this.headers = options.headers ?? cfTransportHeaders;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? CALLBACK_REQUEST_TIMEOUT_MS;
    this.activityPublisher = new ModelActivityPublisher(async (message, type) => {
      await this.postEvent({ type, message });
    });
  }

  async fetchContext(): Promise<PlannerRunContext> {
    const body = await this.requestJson("/context", { method: "GET" }, 3);
    return body as PlannerRunContext;
  }

  async postEvent(event: PlannerRunEvent): Promise<string> {
    if (event.type === "model_activity" || event.type === "model_commentary") {
      if (this.modelActivityBudget <= 0) return this.lastRunStatus ?? "running";
      this.modelActivityBudget -= 1;
    }
    return this.postEventBatch([event]);
  }

  // An empty batch is a pure status poll — the in-band cancellation signal.
  async pollRunStatus(): Promise<string> {
    return this.postEventBatch([]);
  }

  queueModelActivity(message: string): void {
    this.activityPublisher.publish(message);
  }

  queueModelCommentary(message: string): void {
    this.activityPublisher.publish(message, "model_commentary");
  }

  async flushModelActivity(): Promise<void> {
    await this.activityPublisher.flush();
  }

  async postResult(result: PlannerRunResult): Promise<void> {
    // The result post is the one request that must not be lost — retry
    // network errors and 5xx with backoff. `{ ignored: true }` (idempotent
    // late/duplicate result) counts as success.
    await this.requestJson("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    }, 4);
  }

  private async postEventBatch(events: PlannerRunEvent[]): Promise<string> {
    const body = await this.requestJson("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    }, 2) as { ok?: boolean; runStatus?: string };
    if (typeof body.runStatus === "string") {
      this.lastRunStatus = body.runStatus;
    }
    return this.lastRunStatus ?? "running";
  }

  private async requestJson(path: string, init: RequestInit, attempts: number): Promise<unknown> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await delay(this.retryDelayMs * 2 ** (attempt - 1));
      }
      try {
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, timeoutSignal])
            : timeoutSignal,
          headers: {
            ...this.headers,
            [PLANNER_RUN_TOKEN_HEADER]: this.runToken,
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        if (response.ok) {
          return await response.json();
        }
        const detail = (await response.text()).slice(0, 500);
        const message = `Planner callback ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
        if (response.status < 500) {
          throw new NonRetriableCallbackError(message);
        }
        throw new Error(message);
      } catch (error) {
        if (error instanceof NonRetriableCallbackError) throw error;
        // Fetch, response-body, and 5xx errors are retriable.
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Planner callback ${path} failed: ${String(lastError)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
