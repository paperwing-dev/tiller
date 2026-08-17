import type {
  CodexEffectiveThreadSettings,
  CodexThreadMetadata,
} from "./codex-app-server-client.js";
import { CodexForegroundActivityTracker } from "./activity-reporter.js";
import type { RuntimeActivitySignal } from "./activity-controller.js";
import type { CodexDiagnosticSink } from "./runtime-diagnostics.js";

export interface CodexActivitySubscriptionClient {
  listLoadedThreadIds(): Promise<string[]>;
  readThreadMetadata(threadId: string): Promise<CodexThreadMetadata>;
  subscribeThread(threadId: string): Promise<CodexEffectiveThreadSettings>;
}

export interface CodexActivityMonitorOptions {
  client: CodexActivitySubscriptionClient;
  onActivity(signal: RuntimeActivitySignal): void | Promise<unknown>;
  onError?(error: unknown): void;
  pollIntervalMs?: number;
  diagnosticSink?: CodexDiagnosticSink;
  diagnosticTimestamp?: () => string;
}

const MAX_RECONCILE_BACKOFF_MS = 5_000;

export function codexActivityPollDelayMs(
  pollIntervalMs = 250,
  consecutiveFailures = 0,
): number {
  const base = Math.max(10, pollIntervalMs);
  if (consecutiveFailures <= 1) return base;
  return Math.min(
    Math.max(base, MAX_RECONCILE_BACKOFF_MS),
    base * 2 ** Math.min(consecutiveFailures - 1, 10),
  );
}

function isActiveThread(
  thread: CodexThreadMetadata["thread"] | CodexEffectiveThreadSettings["thread"],
): boolean {
  return thread.status?.type === "active";
}

export class CodexActivityMonitor {
  private readonly tracker: CodexForegroundActivityTracker;
  private readonly subscribedRootThreadIds = new Set<string>();
  private readonly ignoredChildThreadIds = new Set<string>();
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvePollWait: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private lastErrorMessage: string | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly options: CodexActivityMonitorOptions) {
    this.tracker = new CodexForegroundActivityTracker({
      diagnosticSink: options.diagnosticSink,
      diagnosticTimestamp: options.diagnosticTimestamp,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.resolvePollWait?.();
    this.resolvePollWait = null;
  }

  handleNotification(method: string, params: unknown): void {
    this.report(this.tracker.handleNotification(method, params));
  }

  async reconcile(): Promise<void> {
    const threadIds = await this.options.client.listLoadedThreadIds();
    for (const threadId of threadIds) {
      if (
        this.subscribedRootThreadIds.has(threadId)
        || this.ignoredChildThreadIds.has(threadId)
      ) continue;

      let metadata: CodexThreadMetadata;
      try {
        metadata = await this.options.client.readThreadMetadata(threadId);
      } catch {
        // A TUI-created thread can be visible through thread/loaded/list before
        // its rollout is readable. Joining the already-loaded thread uses the
        // app-server's in-memory state and establishes the notification
        // subscription without waiting for that rollout to become readable.
        const subscribed = await this.options.client.subscribeThread(threadId);
        this.registerSubscription(threadId, subscribed, false);
        continue;
      }
      this.tracker.registerThread(metadata.thread, "discovery");
      if (metadata.thread.parentThreadId !== null) {
        this.ignoredChildThreadIds.add(threadId);
        continue;
      }

      if (isActiveThread(metadata.thread)) {
        this.report(this.tracker.markThreadActive(threadId));
      }
      const subscribed = await this.options.client.subscribeThread(threadId);
      this.registerSubscription(threadId, subscribed, isActiveThread(metadata.thread));
    }
  }

  private registerSubscription(
    threadId: string,
    subscribed: CodexEffectiveThreadSettings,
    wasActiveBeforeJoin: boolean,
  ): void {
    this.tracker.registerThread(subscribed.thread, "subscription");
    if (subscribed.thread.parentThreadId !== null) {
      this.ignoredChildThreadIds.add(threadId);
      this.report(this.tracker.settleThread(threadId, "idle"));
      return;
    }
    this.subscribedRootThreadIds.add(threadId);
    if (isActiveThread(subscribed.thread)) {
      this.report(this.tracker.markThreadActive(threadId));
    } else if (wasActiveBeforeJoin) {
      // The turn settled while this connection was joining and its terminal
      // notification was not observable. Fail closed as idle instead of
      // leaving automatic stop permanently armed as working.
      this.report(this.tracker.settleThread(threadId, "idle"));
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.reconcile();
        this.lastErrorMessage = null;
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastErrorMessage) {
          this.lastErrorMessage = message;
          this.options.onError?.(error);
        }
      }
      if (this.running) await this.waitForNextPoll();
    }
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.resolvePollWait = null;
        resolve();
      };
      this.resolvePollWait = finish;
      this.pollTimer = setTimeout(
        finish,
        codexActivityPollDelayMs(
          this.options.pollIntervalMs,
          this.consecutiveFailures,
        ),
      );
    });
  }

  private report(signal: RuntimeActivitySignal | null): void {
    if (signal) void this.options.onActivity(signal);
  }
}
