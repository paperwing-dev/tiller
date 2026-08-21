import {
  CodexAppServerClient,
  type CodexEffectiveThreadSettings,
  type CodexThreadRead,
  type GetCodexRuntimeAuth,
} from "../codex-app-server-client.js";
import type { PlanWriterTurnLifecycle } from "./activity.js";
import {
  codexRepoPlansCliOverrides,
  codexRepoPlansServerConfig,
  REPO_PLANS_SERVER_NAME,
} from "./repo-plans.js";

export type {
  CodexEffectiveThreadSettings,
  CodexThreadItem,
  CodexThreadRead,
} from "../codex-app-server-client.js";

export function codexNotificationThreadId(notification: Record<string, unknown>): string | null {
  for (const key of ["thread-id", "thread_id", "threadId"]) {
    const value = notification[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function hasManagedCodexSettings(
  settings: CodexEffectiveThreadSettings,
  expected: { threadId: string; cwd: string },
): boolean {
  return settings.thread.id === expected.threadId
    && settings.thread.parentThreadId === null
    && settings.thread.cwd === expected.cwd
    && settings.cwd === expected.cwd
    && settings.approvalPolicy === "never"
    && settings.sandbox?.type === "dangerFullAccess";
}

export interface CodexThreadSettings {
  cwd: string;
  approvalPolicy: unknown;
  sandboxPolicy: { type?: string; networkAccess?: boolean };
  collaborationMode: {
    mode?: string;
    settings?: {
      model?: string;
      reasoning_effort?: string | null;
      developer_instructions?: string | null;
    };
  };
  [key: string]: unknown;
}

export function hasManagedCodexThreadSettings(
  settings: CodexThreadSettings,
  expected: { cwd: string },
): boolean {
  return settings.cwd === expected.cwd
    && settings.approvalPolicy === "never"
    && settings.sandboxPolicy?.type === "dangerFullAccess"
    && settings.collaborationMode?.mode === "plan";
}

type ThreadSettingsListener = (threadId: string, settings: CodexThreadSettings) => void;
type PlanWriterTurnLifecycleListener = (lifecycle: PlanWriterTurnLifecycle) => void;

interface PlanWriterTurnLifecycleSubscription {
  threadId: string;
  listener: PlanWriterTurnLifecycleListener;
}

export function codexPlanWriterTurnLifecycle(
  method: string,
  params: unknown,
  expectedThreadId: string,
): PlanWriterTurnLifecycle | null {
  if (!params || typeof params !== "object") return null;
  const notification = params as Record<string, unknown>;
  if (codexNotificationThreadId(notification) !== expectedThreadId) return null;
  if (method === "turn/started") return "started";
  if (method !== "turn/completed") return null;
  const turn = notification.turn && typeof notification.turn === "object"
    ? notification.turn as { status?: unknown }
    : null;
  if (turn?.status === "completed" || turn?.status === "failed") return "settled";
  if (turn?.status === "interrupted") return "cancelled";
  return null;
}

export class CodexPlanWriterTurnQueue {
  private tail = Promise.resolve();

  constructor(private readonly onLifecycle: (
    lifecycle: PlanWriterTurnLifecycle,
  ) => void | Promise<void>) {}

  enqueue(lifecycle: PlanWriterTurnLifecycle): Promise<void> {
    return this.enqueueOperation(() => this.onLifecycle(lifecycle));
  }

  enqueueOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

export async function reconcileCodexCompletionWithRetry<T>(input: {
  reconcile(): Promise<T>;
  shouldContinue(): boolean;
  sleep(): Promise<void>;
  onError?(error: unknown): void;
  maxAttempts?: number;
}): Promise<
  | { completed: true; value: T }
  | { completed: false; reason: "stopped" | "exhausted"; attempts: number }
> {
  const requestedAttempts = input.maxAttempts ?? 3;
  const maxAttempts = Number.isFinite(requestedAttempts)
    ? Math.max(1, Math.floor(requestedAttempts))
    : 3;
  let attempts = 0;
  while (input.shouldContinue() && attempts < maxAttempts) {
    attempts += 1;
    try {
      return { completed: true, value: await input.reconcile() };
    } catch (error) {
      input.onError?.(error);
      if (!input.shouldContinue()) return { completed: false, reason: "stopped", attempts };
      if (attempts >= maxAttempts) return { completed: false, reason: "exhausted", attempts };
      await input.sleep();
    }
  }
  return {
    completed: false,
    reason: input.shouldContinue() ? "exhausted" : "stopped",
    attempts,
  };
}

export class CodexAppServer {
  private client: CodexAppServerClient | null = null;
  private readonly threadSettings = new Map<string, CodexThreadSettings>();
  private readonly threadSettingsListeners = new Set<ThreadSettingsListener>();
  private readonly planWriterTurnLifecycleSubscriptions =
    new Set<PlanWriterTurnLifecycleSubscription>();
  readonly socketPath: string;
  private readonly cwd: string;
  private readonly env: Record<string, string>;
  private readonly account?: { uid: number; gid: number };
  private readonly getAuth?: GetCodexRuntimeAuth;
  private readonly repoPlansSocketPath?: string;

  constructor(input: {
    socketPath: string;
    cwd: string;
    env: Record<string, string>;
    account?: { uid: number; gid: number };
    getAuth?: GetCodexRuntimeAuth;
    repoPlansSocketPath?: string;
  }) {
    this.socketPath = input.socketPath;
    this.cwd = input.cwd;
    this.env = input.env;
    this.account = input.account;
    this.getAuth = input.getAuth;
    this.repoPlansSocketPath = input.repoPlansSocketPath;
  }

  get closed(): Promise<Error | null> {
    return this.client?.closed ?? Promise.resolve(null);
  }

  async start(): Promise<void> {
    const client = new CodexAppServerClient({
      socketPath: this.socketPath,
      cwd: this.cwd,
      env: this.env,
      ...(this.account ? { account: this.account } : {}),
      ...(this.getAuth ? { getAuth: this.getAuth } : {}),
      clientName: "tiller-plan-writer",
      ...(this.repoPlansSocketPath
        ? {
            appServerArgs: codexRepoPlansCliOverrides(this.repoPlansSocketPath),
          }
        : {}),
    });
    this.client = client;
    client.on("notification", (method: string, params: unknown) => {
      for (const subscription of this.planWriterTurnLifecycleSubscriptions) {
        const lifecycle = codexPlanWriterTurnLifecycle(method, params, subscription.threadId);
        if (lifecycle) subscription.listener(lifecycle);
      }
      if (method !== "thread/settings/updated" || !params || typeof params !== "object") return;
      const notification = params as { threadId?: unknown; threadSettings?: unknown };
      if (
        typeof notification.threadId !== "string"
        || !notification.threadSettings
        || typeof notification.threadSettings !== "object"
      ) return;
      const settings = notification.threadSettings as CodexThreadSettings;
      this.threadSettings.set(notification.threadId, settings);
      for (const listener of this.threadSettingsListeners) {
        listener(notification.threadId, settings);
      }
    });
    try {
      await client.start();
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.stop();
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.client) throw new Error("Codex app-server is not running");
    return this.client.request<T>(method, params);
  }

  onThreadSettingsUpdated(listener: ThreadSettingsListener): () => void {
    this.threadSettingsListeners.add(listener);
    return () => this.threadSettingsListeners.delete(listener);
  }

  onPlanWriterTurnLifecycle(
    threadId: string,
    listener: PlanWriterTurnLifecycleListener,
  ): () => void {
    const subscription = { threadId, listener };
    this.planWriterTurnLifecycleSubscriptions.add(subscription);
    return () => this.planWriterTurnLifecycleSubscriptions.delete(subscription);
  }

  currentThreadSettings(threadId: string): CodexThreadSettings | null {
    return this.threadSettings.get(threadId) ?? null;
  }

  private async waitForThreadSettings(
    threadId: string,
    predicate: (settings: CodexThreadSettings) => boolean,
    timeoutMessage: string,
    timeoutMs = 15_000,
  ): Promise<CodexThreadSettings> {
    const current = this.threadSettings.get(threadId);
    if (current && predicate(current)) return current;
    return await new Promise<CodexThreadSettings>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.threadSettingsListeners.delete(onSettings);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      const onSettings: ThreadSettingsListener = (updatedThreadId, settings) => {
        if (updatedThreadId !== threadId || !predicate(settings)) return;
        clearTimeout(timeout);
        this.threadSettingsListeners.delete(onSettings);
        resolve(settings);
      };
      this.threadSettingsListeners.add(onSettings);
    });
  }

  async createManagedThread(input: {
    model: string;
    context: string;
  }): Promise<string> {
    const started = await this.request<{ thread: { id: string } }>(
      "thread/start",
      {
        model: input.model,
        cwd: this.cwd,
        runtimeWorkspaceRoots: [this.cwd],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: input.context,
        environments: [],
        dynamicTools: [],
        ephemeral: false,
        historyMode: "legacy",
        experimentalRawEvents: false,
        config: {
          mcp_servers: this.repoPlansSocketPath
            ? {
                [REPO_PLANS_SERVER_NAME]: codexRepoPlansServerConfig(
                  this.repoPlansSocketPath,
                ),
              }
            : {},
        },
      },
    );
    const threadId = started.thread.id;
    await this.request("thread/inject_items", {
      threadId,
      items: [{
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Tiller initialized this managed Plan Writer thread." }],
      }],
    });
    return threadId;
  }

  async initializeManagedPlanTui(input: {
    threadId: string;
    writeInput: (data: string) => Promise<void>;
  }): Promise<CodexThreadSettings> {
    // Codex 0.144.x does not include collaboration mode in thread/resume and
    // ignores resume overrides while this supervisor owns the loaded thread.
    // Drive the stock TUI's native /plan command instead. Its own
    // thread/settings/update is the causal proof that the TUI attached and
    // changed its local composer to Plan mode.
    const ready = this.waitForThreadSettings(
      input.threadId,
      (settings) => hasManagedCodexThreadSettings(settings, { cwd: this.cwd }),
      "Codex native TUI did not enter the managed Plan mode",
    );
    try {
      while (true) {
        // Ctrl-U makes retries idempotent if the composer accepted the text
        // before it was ready to dispatch Enter.
        await input.writeInput("\u0015/plan\r");
        const result = await Promise.race([
          ready.then((settings) => ({ settings })),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
        ]);
        if (result) {
          // A retry can already be in the TUI's input queue when the settings
          // notification arrives. Clear any residual bootstrap command before
          // exposing the composer to the user.
          await input.writeInput("\u0015");
          return result.settings;
        }
      }
    } catch (error) {
      void ready.catch(() => undefined);
      throw error;
    }
  }

  readThread(threadId: string): Promise<CodexThreadRead> {
    if (!this.client) throw new Error("Codex app-server is not running");
    return this.client.readThread(threadId);
  }

  readEffectiveSettings(threadId: string): Promise<CodexEffectiveThreadSettings> {
    if (!this.client) throw new Error("Codex app-server is not running");
    return this.client.readEffectiveSettings(threadId);
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    if (!this.client) throw new Error("Codex app-server is not running");
    return this.client.interruptTurn(threadId, turnId);
  }
}

export function newestCompletedPlan(thread: CodexThreadRead, afterEventId?: string): {
  turnId: string;
  eventId: string;
  markdown: string;
} | null {
  if (thread.thread.parentThreadId !== null) return null;
  const turns = [...thread.thread.turns]
    .filter((turn) => turn.status === "completed")
    .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0));
  for (const turn of turns) {
    const plan = [...turn.items].reverse().find((item) => item.type === "plan" && item.text?.trim());
    if (!plan) continue;
    if (plan.id === afterEventId) return null;
    return { turnId: turn.id, eventId: plan.id, markdown: plan.text! };
  }
  return null;
}

export function codexThreadRestingLifecycle(
  thread: CodexThreadRead,
): Exclude<PlanWriterTurnLifecycle, "started"> | null {
  const latest = [...thread.thread.turns].reverse().find((turn) => (
    turn.status === "completed"
    || turn.status === "failed"
    || turn.status === "interrupted"
  ));
  if (!latest) return null;
  return latest.status === "interrupted" ? "cancelled" : "settled";
}
