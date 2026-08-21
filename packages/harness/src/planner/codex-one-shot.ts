import {
  CodexAppServerClient,
  createCodexAppServerSocketLease,
  sanitizeCodexChildEnvironment,
  type CodexThreadItem,
  type GetCodexRuntimeAuth,
} from "../codex-app-server-client.js";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexItemActivity } from "./output-tracker.js";
import { chmodSync, chownSync } from "node:fs";

export class CodexOneShotCancelledError extends Error {
  constructor() {
    super("Codex reviewer run was cancelled");
    this.name = "CodexOneShotCancelledError";
  }
}

export const CODEX_ONE_SHOT_DEADLINE_MS = 60 * 60_000;
export const CODEX_CANCELLATION_POLL_MS = 500;
export const REVIEWER_INSPECTION_REQUIRED_ERROR =
  "Reviewer completed without successfully inspecting the repository checkout.";

interface TurnCompletedNotification {
  threadId?: string;
  turn?: { id?: string; status?: string; error?: { message?: string } | null };
}

interface ItemCompletedNotification {
  threadId?: string;
  turnId?: string;
  item?: CodexThreadItem;
}

interface CodexEnvironmentInfoResponse {
  shell: {
    name: string;
    path: string;
  };
  cwd?: string | null;
}

interface CodexEnvironmentSelection {
  environmentId: "local";
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function localEnvironment(cwd: string): CodexEnvironmentSelection[] {
  return [{ environmentId: "local", cwd }];
}

function codexThreadConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    mcp_servers: {},
    // Docker's default seccomp profile blocks the user namespaces required by
    // bubblewrap. Cloudflare Containers support Codex's default bwrap sandbox,
    // so only host-backed Docker jobs use the legacy Landlock implementation.
    ...(env.RUNNER_BACKEND === "host"
      ? { "features.use_legacy_landlock": true }
      : {}),
  };
}

function filesystemPath(value: string): string {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

function isWithinCheckout(path: string, cwd: string, checkoutDir: string): boolean {
  const resolvedCwd = resolve(filesystemPath(cwd));
  const resolvedPath = resolve(
    resolvedCwd,
    filesystemPath(path),
  );
  const checkoutRoot = resolve(checkoutDir);
  const rel = relative(checkoutRoot, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSuccessfulRepositoryInspection(
  item: CodexThreadItem,
  checkoutDir: string,
): boolean {
  if (
    item.type !== "commandExecution"
    || item.status !== "completed"
    || item.exitCode !== 0
    || typeof item.cwd !== "string"
    || !isWithinCheckout(".", item.cwd, checkoutDir)
    || !Array.isArray(item.commandActions)
  ) return false;

  return item.commandActions.some((candidate) => {
    if (!isRecord(candidate)) return false;
    if (candidate.type === "read") {
      return typeof candidate.path === "string"
        && isWithinCheckout(candidate.path, item.cwd as string, checkoutDir);
    }
    if (candidate.type === "listFiles" || candidate.type === "search") {
      return candidate.path === null || candidate.path === undefined
        ? true
        : typeof candidate.path === "string"
          && isWithinCheckout(candidate.path, item.cwd as string, checkoutDir);
    }
    return false;
  });
}

function parseLocalEnvironmentInfo(value: unknown): CodexEnvironmentInfoResponse {
  if (!isRecord(value) || !isRecord(value.shell)) {
    throw new Error("Codex local environment returned invalid shell metadata");
  }
  const name = typeof value.shell.name === "string" ? value.shell.name.trim() : "";
  const path = typeof value.shell.path === "string" ? value.shell.path.trim() : "";
  if (!name || !path) {
    throw new Error("Codex local environment returned invalid shell metadata");
  }
  return {
    shell: { name, path },
    ...(typeof value.cwd === "string" || value.cwd === null ? { cwd: value.cwd } : {}),
  };
}

async function requireLocalEnvironment(client: CodexOneShotClient): Promise<void> {
  try {
    parseLocalEnvironmentInfo(await client.request<unknown>("environment/info", {
      environmentId: "local",
    }));
  } catch (cause) {
    const error = new Error("Codex local reviewer environment is unavailable") as Error & {
      cause?: unknown;
    };
    error.cause = cause;
    throw error;
  }
}

export function codexNotificationActivity(method: string, params: unknown): string | null {
  if (method !== "item/started" || !isRecord(params) || !isRecord(params.item)) return null;
  return codexItemActivity(params.item);
}

/**
 * Return only text Codex marks for user display. Reasoning summaries are safe
 * to surface; raw reasoning content is intentionally never returned here.
 */
export function codexNotificationCommentary(method: string, params: unknown): string | null {
  if (method !== "item/completed" || !isRecord(params) || !isRecord(params.item)) return null;
  const item = params.item;
  if (
    item.type === "agentMessage"
    && item.phase === "commentary"
    && typeof item.text === "string"
    && item.text.trim()
  ) return item.text.trim();
  if (item.type !== "reasoning" || !Array.isArray(item.summary)) return null;
  const summary = item.summary
    .filter((part): part is string => typeof part === "string" && Boolean(part.trim()))
    .map((part) => part.trim())
    .join("\n\n");
  return summary || null;
}

interface CodexOneShotClient {
  readonly closed: Promise<Error | null>;
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: "notification", listener: (method: string, params: unknown) => void): unknown;
  off(event: "notification", listener: (method: string, params: unknown) => void): unknown;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
}

function finalAgentMessage(items: CodexThreadItem[]): string {
  const messages = items.filter((item) => item.type === "agentMessage" && item.text?.trim());
  const preferred = messages.filter((item) => item.phase === "final_answer");
  const compatible = preferred.length > 0
    ? preferred
    : messages.filter((item) => item.phase === null || item.phase === undefined);
  const message = compatible[compatible.length - 1]?.text?.trim() ?? "";
  if (!message) throw new Error("Codex reviewer completed without a final agent message");
  return message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCodexOneShot(input: {
  cwd: string;
  model: string;
  effort?: string;
  prompt: string;
  getAuth: GetCodexRuntimeAuth;
  isCancelled: () => Promise<boolean>;
  onActivity?: (message: string) => void | Promise<void>;
  onCommentary?: (message: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  account?: { uid: number; gid: number };
  requireInspection?: boolean;
  completionTimeoutMs?: number;
  cancellationPollMs?: number;
  clientFactory?: (
    options: ConstructorParameters<typeof CodexAppServerClient>[0],
  ) => CodexOneShotClient;
}): Promise<string> {
  const runEnv = input.env ?? process.env;
  const socketLease = createCodexAppServerSocketLease("tiller-codex-reviewer-");
  if (input.account && process.getuid?.() === 0) {
    chownSync(socketLease.directory, input.account.uid, input.account.gid);
    chmodSync(socketLease.directory, 0o700);
  }
  const clientOptions: ConstructorParameters<typeof CodexAppServerClient>[0] = {
    socketPath: socketLease.socketPath,
    cwd: input.cwd,
    env: sanitizeCodexChildEnvironment(runEnv),
    ...(input.account ? { account: input.account } : {}),
    getAuth: input.getAuth,
    clientName: "tiller-one-shot-reviewer",
    rejectUnexpectedServerRequests: true,
    declineMcpServerElicitations: true,
  };
  let client: CodexOneShotClient;
  try {
    client = input.clientFactory
      ? input.clientFactory(clientOptions)
      : new CodexAppServerClient(clientOptions);
  } catch (error) {
    socketLease.cleanup();
    throw error;
  }
  let threadId: string | null = null;
  let turnId: string | null = null;
  let finished = false;
  const bufferedCompletions: TurnCompletedNotification[] = [];
  const completedItems: ItemCompletedNotification[] = [];
  let resolveCompletion!: (notification: TurnCompletedNotification) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<TurnCompletedNotification>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const completionTimer = setTimeout(() => {
    rejectCompletion(new Error("Timed out waiting for Codex reviewer completion"));
  }, input.completionTimeoutMs ?? CODEX_ONE_SHOT_DEADLINE_MS);
  const notificationListener = (method: string, params: unknown) => {
    if (
      method === "item/completed"
      && isRecord(params)
      && isRecord(params.item)
    ) completedItems.push(params as unknown as ItemCompletedNotification);
    if (method === "turn/completed") {
      const candidate = params as TurnCompletedNotification;
      if (candidate.threadId === threadId) {
        if (turnId && candidate.turn?.id === turnId) resolveCompletion(candidate);
        else if (!turnId) bufferedCompletions.push(candidate);
      }
    }
    if (!finished) {
      const commentary = codexNotificationCommentary(method, params);
      if (commentary) void Promise.resolve(input.onCommentary?.(commentary)).catch(() => undefined);
      const activity = codexNotificationActivity(method, params);
      if (activity) void Promise.resolve(input.onActivity?.(activity)).catch(() => undefined);
    }
  };

  try {
    await client.start();
    client.on("notification", notificationListener);
    await requireLocalEnvironment(client);
    const startedThread = await client.request<{ thread: { id: string } }>("thread/start", {
      model: input.model,
      cwd: input.cwd,
      runtimeWorkspaceRoots: [input.cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: localEnvironment(input.cwd),
      dynamicTools: [],
      ephemeral: true,
      historyMode: "legacy",
      experimentalRawEvents: false,
      config: codexThreadConfig(runEnv),
    });
    threadId = startedThread.thread.id;
    const startedTurn = await client.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: input.cwd,
      runtimeWorkspaceRoots: [input.cwd],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      environments: localEnvironment(input.cwd),
    });
    turnId = startedTurn.turn.id;
    const bufferedCompletion = bufferedCompletions.find((candidate) => candidate.turn?.id === turnId);
    if (bufferedCompletion) resolveCompletion(bufferedCompletion);

    const cancellation = (async () => {
      while (!finished) {
        await delay(input.cancellationPollMs ?? CODEX_CANCELLATION_POLL_MS);
        let cancelled = false;
        try {
          cancelled = await input.isCancelled();
        } catch {
          // Status callbacks are liveness checks. A transient failure must not
          // fail or cancel the authoritative Codex turn.
          continue;
        }
        if (!cancelled) continue;
        if (threadId && turnId) {
          await Promise.race([
            client.interruptTurn(threadId, turnId).catch(() => undefined),
            delay(2_000),
          ]);
        }
        throw new CodexOneShotCancelledError();
      }
      return null;
    })();
    const closed = client.closed.then((error) => {
      if (error) throw error;
      if (!finished) throw new Error("Codex app-server stopped before reviewer completion");
      return null;
    });
    const notification = await Promise.race([completion, cancellation, closed]);
    finished = true;
    if (!notification || !("turn" in notification)) throw new CodexOneShotCancelledError();
    if (notification.turn?.status !== "completed") {
      throw new Error(notification.turn?.error?.message || `Codex reviewer turn ended with status ${notification.turn?.status ?? "unknown"}`);
    }
    // Ephemeral threads cannot be read back with includeTurns. Completed item
    // notifications are the app-server's authoritative result stream.
    const turnItems = completedItems
      .filter((candidate) => candidate.threadId === threadId && candidate.turnId === turnId)
      .flatMap((candidate) => candidate.item ? [candidate.item] : []);
    if (
      input.requireInspection
      && !turnItems.some((item) => isSuccessfulRepositoryInspection(item, input.cwd))
    ) {
      throw new Error(REVIEWER_INSPECTION_REQUIRED_ERROR);
    }
    return finalAgentMessage(turnItems);
  } finally {
    finished = true;
    clearTimeout(completionTimer);
    client.off("notification", notificationListener);
    try {
      await client.stop();
    } finally {
      socketLease.cleanup();
    }
  }
}

export const _test = {
  codexThreadConfig,
  finalAgentMessage,
  isSuccessfulRepositoryInspection,
};
