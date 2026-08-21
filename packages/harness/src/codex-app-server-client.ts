import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData } from "ws";

export interface CodexRuntimeAuth {
  accessToken: string;
  accountId: string;
  expiresAt: string;
}

export type GetCodexRuntimeAuth = (
  rejectedAccessTokenSha256?: string,
) => Promise<CodexRuntimeAuth>;

export type CodexRuntimeAuthErrorCode =
  | "needs_reconnect"
  | "auth_temporarily_unavailable"
  | "runtime_inactive";

export class CodexRuntimeAuthError extends Error {
  constructor(
    message: string,
    readonly code: CodexRuntimeAuthErrorCode,
  ) {
    super(message);
    this.name = "CodexRuntimeAuthError";
  }
}

export interface CodexThreadItem {
  type: string;
  id: string;
  text?: string;
  phase?: "commentary" | "final_answer" | null;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress" | string;
  completedAt: number | null;
  items: CodexThreadItem[];
  error?: { message?: string } | null;
}

export interface CodexThreadRead {
  thread: {
    id: string;
    parentThreadId: string | null;
    cwd: string;
    status: { type?: string } | string;
    turns: CodexTurn[];
    [key: string]: unknown;
  };
}

export interface CodexEffectiveThreadSettings {
  thread: {
    id: string;
    parentThreadId: string | null;
    cwd: string;
    status?: CodexThreadRuntimeStatus;
  };
  cwd: string;
  approvalPolicy: unknown;
  sandbox: { type?: string; networkAccess?: boolean };
}

export type CodexThreadRuntimeStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags?: unknown[] };

export interface CodexThreadMetadata {
  thread: {
    id: string;
    parentThreadId: string | null;
    cwd: string;
    status?: CodexThreadRuntimeStatus;
  };
}

export interface CodexAppServerClientOptions {
  socketPath: string;
  cwd: string;
  env: Record<string, string>;
  account?: { uid: number; gid: number };
  getAuth?: GetCodexRuntimeAuth;
  clientName?: string;
  rejectUnexpectedServerRequests?: boolean;
  /** Non-interactive clients must answer MCP elicitations instead of hanging. */
  declineMcpServerElicitations?: boolean;
  appServerArgs?: string[];
  /** Test seam; production runtimes use the pinned `codex` executable. */
  codexExecutable?: string;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export const CODEX_AUTH_OPERATION_BUDGET_MS = 9_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface CodexAppServerSocketLease {
  directory: string;
  socketPath: string;
  cleanup(): void;
}

/**
 * Codex makes the Unix socket's parent directory owner-only before binding.
 * Give each runtime a directory it owns instead of placing the socket directly
 * under a shared, root-owned temporary directory such as /tmp.
 */
export function createCodexAppServerSocketLease(
  prefix = "tiller-codex-app-server-",
): CodexAppServerSocketLease {
  // Keep macOS socket paths below the platform's short AF_UNIX path limit.
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const directory = mkdtempSync(join(temporaryRoot, prefix));
  let cleaned = false;
  return {
    directory,
    socketPath: join(directory, "app-server.sock"),
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRuntimeAuthError(error: unknown): CodexRuntimeAuthError | null {
  if (error instanceof CodexRuntimeAuthError) return error;
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (
    code === "needs_reconnect"
    || code === "auth_temporarily_unavailable"
    || code === "runtime_inactive"
  ) return new CodexRuntimeAuthError(errorMessage(error), code);
  return null;
}

async function withDeadline<T>(operation: Promise<T>, deadline: number, label: string): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CodexRuntimeAuthError(`${label} exceeded the authentication deadline.`, "auth_temporarily_unavailable");
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CodexRuntimeAuthError(`${label} exceeded the authentication deadline.`, "auth_temporarily_unavailable"));
    }, remaining);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private stopping = false;
  private closedSettled = false;
  private lastAccessToken: string | null = null;
  private accountId: string | null = null;
  private refreshTail: Promise<void> = Promise.resolve();
  private resolveClosed!: (error: Error | null) => void;
  readonly closed: Promise<Error | null>;

  constructor(readonly options: CodexAppServerClientOptions) {
    super();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }

  async start(): Promise<void> {
    if (this.child || this.socket) throw new Error("Codex app-server client was already started");
    rmSync(this.options.socketPath, { force: true });
    this.child = spawn(this.options.codexExecutable ?? "codex", [
      "app-server",
      "--listen",
      `unix://${this.options.socketPath}`,
      "--strict-config",
      "-c",
      "mcp_servers={}",
      ...(this.options.appServerArgs ?? []),
    ], {
      cwd: this.options.cwd,
      env: this.options.env,
      ...(this.options.account ?? {}),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    this.child.stderr?.on("data", (data) => { stderr = `${stderr}${String(data)}`.slice(-4_000); });
    this.child.once("exit", (code, signal) => {
      const detail = stderr.trim();
      this.finishClosed(this.stopping
        ? null
        : new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
    });
    this.child.once("error", (error) => this.finishClosed(error));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(this.options.socketPath)) break;
      if (this.child.exitCode !== null) throw new Error(`Codex app-server exited during startup: ${stderr.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!existsSync(this.options.socketPath)) {
      await this.stop();
      throw new Error(`Codex app-server socket did not appear: ${this.options.socketPath}`);
    }

    this.socket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => createConnection({ path: this.options.socketPath }),
        perMessageDeflate: false,
      });
      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    this.socket.on("message", (data) => this.handleData(data));
    this.socket.on("error", (error) => this.finishClosed(error));
    this.socket.on("close", (code, reason) => {
      if (!this.stopping) {
        const detail = reason.toString().trim();
        this.finishClosed(new Error(
          `Codex app-server control connection closed (${code})${detail ? `: ${detail}` : ""}`,
        ));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: this.options.clientName ?? "tiller-codex-runtime",
        title: "Tiller Codex Runtime",
        version: "1",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized", {});
    if (this.options.getAuth) await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    const deadline = Date.now() + CODEX_AUTH_OPERATION_BUDGET_MS;
    const auth = await this.getAuthWithinBudget(undefined, deadline);
    this.accountId = auth.accountId;
    this.lastAccessToken = auth.accessToken;
    const response = await this.request<{ type?: string }>("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: auth.accessToken,
      chatgptAccountId: auth.accountId,
      chatgptPlanType: null,
    }, Math.max(1, deadline - Date.now()));
    if (response?.type !== "chatgptAuthTokens") {
      throw new Error("Codex app-server did not accept external ChatGPT credentials");
    }
  }

  private async getAuthWithinBudget(
    rejectedAccessTokenSha256: string | undefined,
    deadline: number,
  ): Promise<CodexRuntimeAuth> {
    const getAuth = this.options.getAuth;
    if (!getAuth) throw new Error("Codex runtime authentication is not configured");
    try {
      return await withDeadline(getAuth(rejectedAccessTokenSha256), deadline, "Codex runtime authentication");
    } catch (error) {
      throw asRuntimeAuthError(error) ?? error;
    }
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server control connection is not open"));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server control connection is not open");
    }
    this.socket.send(JSON.stringify({ method, params }));
  }

  private handleData(data: RawData): void {
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
      this.handleMessage(JSON.parse(text) as JsonRpcMessage);
    } catch (error) {
      this.fail(new Error(`Invalid Codex app-server message: ${errorMessage(error)}`));
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || `Codex request failed: ${pending.method}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (
        message.method === "mcpServer/elicitation/request"
        && this.options.declineMcpServerElicitations
      ) {
        this.respond(message.id, { action: "decline", content: null });
        return;
      }
      if (message.method === "account/chatgptAuthTokens/refresh") {
        this.refreshTail = this.refreshTail.then(
          () => this.handleAuthRefresh(message.id!, message.params),
          () => this.handleAuthRefresh(message.id!, message.params),
        );
        return;
      }
      if (this.options.rejectUnexpectedServerRequests) {
        this.respondError(message.id, -32601, `Unexpected Codex server request: ${message.method}`);
        this.fail(new Error(`Unexpected Codex server request: ${message.method}`));
      } else {
        // Interactive requests are owned by the attached stock TUI. The
        // persistent control connection deliberately does not impersonate it.
        this.emit("serverRequest", message);
      }
      return;
    }
    if (message.method) this.emit("notification", message.method, message.params);
  }

  private async handleAuthRefresh(id: number | string, params: unknown): Promise<void> {
    try {
      const previousAccountId = params && typeof params === "object"
        ? (params as { previousAccountId?: unknown }).previousAccountId
        : undefined;
      if (
        previousAccountId !== undefined
        && previousAccountId !== null
        && previousAccountId !== this.accountId
      ) throw new CodexRuntimeAuthError("Codex requested credentials for another ChatGPT account.", "needs_reconnect");
      if (!this.lastAccessToken || !this.accountId) {
        throw new CodexRuntimeAuthError("Codex subscription identity is unavailable.", "needs_reconnect");
      }
      const rejectedHash = createHash("sha256").update(this.lastAccessToken).digest("hex");
      const deadline = Date.now() + CODEX_AUTH_OPERATION_BUDGET_MS;
      const auth = await this.getAuthWithinBudget(rejectedHash, deadline);
      if (auth.accountId !== this.accountId) {
        throw new CodexRuntimeAuthError("Refreshed credentials changed the ChatGPT account.", "needs_reconnect");
      }
      this.lastAccessToken = auth.accessToken;
      this.respond(id, {
        accessToken: auth.accessToken,
        chatgptAccountId: auth.accountId,
        chatgptPlanType: null,
      });
    } catch (error) {
      this.respondError(id, -32001, errorMessage(error));
      this.fail(asRuntimeAuthError(error) ?? new Error(errorMessage(error)));
    }
  }

  private respond(id: number | string, result: unknown): void {
    this.socket?.send(JSON.stringify({ id, result }));
  }

  private respondError(id: number | string, code: number, message: string): void {
    this.socket?.send(JSON.stringify({ id, error: { code, message } }));
  }

  waitForNotification<T = unknown>(
    method: string,
    predicate: (params: T) => boolean = () => true,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const listener = (receivedMethod: string, params: T) => {
        if (receivedMethod !== method || !predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for Codex notification: ${method}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off("notification", listener);
      };
      this.on("notification", listener);
    });
  }

  readThread(threadId: string): Promise<CodexThreadRead> {
    return this.request<CodexThreadRead>("thread/read", { threadId, includeTurns: true });
  }

  async listLoadedThreadIds(): Promise<string[]> {
    const threadIds: string[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const page: {
        data?: unknown;
        nextCursor?: unknown;
      } = await this.request("thread/loaded/list", cursor ? { cursor } : {});
      if (Array.isArray(page.data)) {
        for (const candidate of page.data) {
          if (typeof candidate === "string" && candidate.trim()) {
            threadIds.push(candidate.trim());
          }
        }
      }
      const nextCursor: string | null = typeof page.nextCursor === "string" && page.nextCursor.trim()
        ? page.nextCursor.trim()
        : null;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return [...new Set(threadIds)];
  }

  readThreadMetadata(threadId: string): Promise<CodexThreadMetadata> {
    return this.request<CodexThreadMetadata>("thread/read", {
      threadId,
      includeTurns: false,
    });
  }

  subscribeThread(threadId: string): Promise<CodexEffectiveThreadSettings> {
    return this.request<CodexEffectiveThreadSettings>("thread/resume", {
      threadId,
      excludeTurns: true,
    });
  }

  readEffectiveSettings(threadId: string): Promise<CodexEffectiveThreadSettings> {
    return this.subscribeThread(threadId);
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  private fail(error: Error): void {
    this.finishClosed(error);
    void this.stop();
  }

  private finishClosed(error: Error | null): void {
    if (this.closedSettled) return;
    this.closedSettled = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("Codex app-server stopped"));
    }
    this.pending.clear();
    this.resolveClosed(error);
    this.emit("closed", error);
  }

  async stop(options: { termGraceMs?: number; killGraceMs?: number } = {}): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        let settled = false;
        const finish = (exited: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", onExit);
          child.off("close", onExit);
          resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
        child.once("exit", onExit);
        child.once("close", onExit);
      });
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      if (!await waitForExit(options.termGraceMs ?? 2_000)) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        await waitForExit(options.killGraceMs ?? 500);
      }
    }
    rmSync(this.options.socketPath, { force: true });
    this.finishClosed(null);
  }
}

const CODEX_CHILD_ENV_DENY = new Set([
  "OPENAI_API_KEY",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "HUB_URL",
  "TILLER_CODEX_RUNTIME_AUTH_URL",
  "TILLER_RUNTIME_CAPABILITY",
  "TILLER_CODEX_GATEWAY_BASE_URL",
  "TILLER_CODEX_GATEWAY_SESSION_TOKEN",
  "TILLER_PLAN_WRITER_TOKEN",
  "TILLER_PLAN_WRITER_CALLBACK_BASE",
  "TILLER_PLANNER_RUN_TOKEN",
  "TILLER_PLANNER_CALLBACK_BASE",
  "TILLER_ENV_REVIEW_RUN_TOKEN",
  "TILLER_ENV_REVIEW_CALLBACK_BASE",
]);

const CODEX_CHILD_ENV_DENY_PREFIXES = [
  "TILLER_GITHUB_BRIDGE_",
  "TILLER_WORKSPACE_SYNC_",
];

const CODEX_GITHUB_REPO_ACCESS_ENV = new Set([
  "HUB_URL",
  "TILLER_GITHUB_BRIDGE_ID",
  "TILLER_GITHUB_BRIDGE_SECRET",
  "TILLER_GITHUB_ALLOWED_REPO",
]);

const CODEX_GITHUB_CF_ACCESS_ENV = new Set([
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
]);

function hasGitHubRepoAccessBridge(source: NodeJS.ProcessEnv): boolean {
  return Boolean(
    source.HUB_URL?.trim()
    && source.TILLER_GITHUB_BRIDGE_ID?.trim()
    && source.TILLER_GITHUB_BRIDGE_SECRET?.trim()
    && source.TILLER_GITHUB_ALLOWED_REPO?.trim()
  );
}

function hasCloudflareAccessPair(source: NodeJS.ProcessEnv): boolean {
  return Boolean(
    source.CF_ACCESS_CLIENT_ID?.trim()
    && source.CF_ACCESS_CLIENT_SECRET?.trim()
  );
}

export function sanitizeCodexChildEnvironment(
  source: NodeJS.ProcessEnv,
  options: {
    authMode?: "subscription" | "api-key";
    githubRepoAccess?: boolean;
  } = {},
): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "TZ",
    "NODE_OPTIONS",
    "GIT_CONFIG_GLOBAL",
    "CODEX_HOME",
    "TILLER_PLAN_WRITER_SOCKET",
    "TILLER_PLAN_WRITER_CONTEXT_PATH",
    "TILLER_HARNESS_CONTROL_SOCKET",
    "TILLER_ACTIVITY_GENERATION",
    "TILLER_ACTIVITY_HOOK_PATH",
  ]);
  if (options.authMode === "api-key") {
    allowed.add("OPENAI_API_KEY");
  }
  const githubRepoAccess = options.githubRepoAccess === true
    && hasGitHubRepoAccessBridge(source);
  const cloudflareAccess = githubRepoAccess && hasCloudflareAccessPair(source);
  if (githubRepoAccess) {
    for (const name of CODEX_GITHUB_REPO_ACCESS_ENV) allowed.add(name);
    if (cloudflareAccess) {
      for (const name of CODEX_GITHUB_CF_ACCESS_ENV) allowed.add(name);
    }
  }
  for (const name of (source.TILLER_SESSION_ENV_NAMES ?? "").split(",")) {
    if (name.trim()) allowed.add(name.trim());
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) continue;
    const isGitHubRepoAccessEnv = githubRepoAccess
      && (
        CODEX_GITHUB_REPO_ACCESS_ENV.has(key)
        || (cloudflareAccess && CODEX_GITHUB_CF_ACCESS_ENV.has(key))
      );
    if (
      !isGitHubRepoAccessEnv
      && (
        (CODEX_CHILD_ENV_DENY.has(key) && !(key === "OPENAI_API_KEY" && options.authMode === "api-key"))
        || CODEX_CHILD_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))
      )
    ) continue;
    result[key] = value;
  }
  return result;
}
