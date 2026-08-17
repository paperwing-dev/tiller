import { cfTransportHeaders } from "../config.js";
import {
  CALLBACK_REQUEST_TIMEOUT_MS,
  MAX_MODEL_ACTIVITY_EVENTS_PER_RUN,
  ModelActivityPublisher,
  type PlannerRunEvent,
} from "./hub-callback.js";

export const ENV_REVIEW_RUN_TOKEN_HEADER = "X-Tiller-Env-Review-Run-Token";

export interface EnvReviewRunContext {
  run: {
    runId: string;
    envSlug: string;
    repoId: string;
    threadId: string;
    provider: string;
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "ultra" | "max";
    roleLabel: string;
    status: string;
    /** Defaults to true for compatibility with older Hub responses. */
    requiresRepositoryInspection?: boolean;
  };
  prompt: string;
  preparation?: unknown;
  changeContext?: unknown;
  planBasis?: unknown;
  workspace?: {
    githubDeletedPaths?: string[];
  };
}

export type EnvReviewRunResult =
  | { status: "succeeded"; text: string; providerSessionId?: string; summary?: string }
  | { status: "failed"; error: string };

class NonRetriableCallbackError extends Error {}

export class EnvReviewHubCallback {
  readonly baseUrl: string;
  lastRunStatus: string | null = null;
  private readonly runToken: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly activityPublisher: ModelActivityPublisher;
  private modelActivityBudget = MAX_MODEL_ACTIVITY_EVENTS_PER_RUN;

  constructor(options: {
    baseUrl: string;
    runToken: string;
    headers?: Record<string, string>;
    fetchImpl?: typeof fetch;
    retryDelayMs?: number;
    requestTimeoutMs?: number;
  }) {
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

  async fetchContext(): Promise<EnvReviewRunContext> {
    return await this.requestJson("/context", { method: "GET" }, 3) as EnvReviewRunContext;
  }

  async fetchWorkspaceTar(): Promise<Uint8Array> {
    return await this.request(
      "/workspace.tar",
      { method: "GET" },
      3,
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  async fetchInspectionTar(): Promise<Uint8Array> {
    return await this.request(
      "/inspection.tar",
      { method: "GET" },
      3,
      async (response) => new Uint8Array(await response.arrayBuffer()),
    );
  }

  async postEvent(event: PlannerRunEvent): Promise<string> {
    if (event.type === "model_activity" || event.type === "model_commentary") {
      if (this.modelActivityBudget <= 0) return this.lastRunStatus ?? "running";
      this.modelActivityBudget -= 1;
    }
    return this.postEventBatch([event]);
  }

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

  async postResult(result: EnvReviewRunResult): Promise<void> {
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
    }, 2) as { runStatus?: string };
    if (typeof body.runStatus === "string") {
      this.lastRunStatus = body.runStatus;
    }
    return this.lastRunStatus ?? "running";
  }

  private async requestJson(path: string, init: RequestInit, attempts: number): Promise<unknown> {
    return await this.request(path, init, attempts, async (response) => await response.json());
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    attempts: number,
    consume: (response: Response) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await delay(this.retryDelayMs * 2 ** (attempt - 1));
      try {
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          signal: init.signal
            ? AbortSignal.any([init.signal, timeoutSignal])
            : timeoutSignal,
          headers: {
            ...this.headers,
            [ENV_REVIEW_RUN_TOKEN_HEADER]: this.runToken,
            ...(init.headers as Record<string, string> | undefined),
          },
        });
        if (response.ok) {
          return await consume(response);
        }
        const detail = (await response.text()).slice(0, 500);
        const message = `Env review callback ${path} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`;
        if (response.status < 500) {
          throw new NonRetriableCallbackError(message);
        }
        throw new Error(message);
      } catch (error) {
        if (error instanceof NonRetriableCallbackError) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Env review callback failed: ${String(lastError)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
