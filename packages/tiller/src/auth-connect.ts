import { spawn, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin } from "node:process";
import {
  runAuthConnectApproval,
  type AuthConnectApproval,
  type AuthConnectProvider,
} from "./auth-connect-browser.js";
import {
  HUB_URL,
  hubControlHeaders,
  ensureAuth,
} from "./config.js";
import { ensureInteractiveConfig } from "./init.js";
import { stopChildProcess } from "./shutdown.js";

const MAX_CODEX_AUTH_BYTES = 64 * 1_024;
const MAX_CLAUDE_TOKEN_CHARS = 16 * 1_024;
const MAX_UPLOAD_BODY_BYTES = 64 * 1_024;

export interface CollectedSubscriptionCredentials {
  codexAuthJson?: string;
  claudeOauthToken?: string;
}

export interface AuthConnectDependencies {
  runCommand?: (command: string, args: string[], options: SpawnOptions) => Promise<void>;
  approve?: (hubUrl: string, providers: AuthConnectProvider[]) => Promise<AuthConnectApproval>;
  promptHidden?: (prompt: string) => Promise<string>;
  fetch?: typeof fetch;
  initialize?: (options: { hubUrlOverride?: string }) => Promise<void>;
  validateAuth?: () => void;
  hubUrl?: string;
  accessHeaders?: Record<string, string>;
}

interface HiddenInputSource {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  isPaused(): boolean;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

interface HiddenInputDependencies {
  input?: HiddenInputSource;
  signalSource?: Pick<NodeJS.Process, "once" | "off">;
  writeStderr?: (message: string) => void;
}

function safeChildEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL",
    "TERM", "COLORTERM", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "BROWSER",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

export function buildSubscriptionLoginEnvironment(
  provider: AuthConnectProvider,
  codexHome?: string,
): NodeJS.ProcessEnv {
  return safeChildEnvironment(provider === "codex" && codexHome ? { CODEX_HOME: codexHome } : {});
}

function defaultRunCommand(command: string, args: string[], options: SpawnOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let settled = false;
    let interrupted = false;
    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (settled || interrupted) return;
      interrupted = true;
      const cancellation = new Error(`${command} authentication was cancelled.`);
      const shutdown = stopChildProcess(child, { signal });
      void shutdown.then(
        () => finish(cancellation),
        () => finish(cancellation),
      );
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    const onSighup = () => onSignal("SIGHUP");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("SIGHUP", onSighup);
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT"
        ? new Error(`${command} is not installed or is not available on PATH.`)
        : new Error(`${command} could not be started.`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 && !interrupted) finish();
      else finish(new Error(
        interrupted || signal || code === 130
          ? `${command} authentication was cancelled.`
          : `${command} authentication exited with code ${code ?? "unknown"}.`,
      ));
    });
  });
}

export function readHiddenInput(
  prompt: string,
  dependencies: HiddenInputDependencies = {},
): Promise<string> {
  const inputSource: HiddenInputSource = dependencies.input ?? (stdin as HiddenInputSource);
  const signalSource = dependencies.signalSource ?? process;
  const writeStderr = dependencies.writeStderr ?? ((message: string) => process.stderr.write(message));
  if (!inputSource.isTTY || typeof inputSource.setRawMode !== "function") {
    return Promise.reject(new Error("A terminal is required to paste the Claude subscription token."));
  }
  writeStderr(prompt);
  const wasRaw = inputSource.isRaw;
  const wasPaused = inputSource.isPaused();
  inputSource.setRawMode(true);
  inputSource.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const cleanup = () => {
      inputSource.off("data", onData);
      inputSource.off("end", onEnd);
      inputSource.off("close", onEnd);
      inputSource.off("error", onError);
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      signalSource.off("SIGHUP", onSighup);
      inputSource.setRawMode(Boolean(wasRaw));
      if (wasPaused) inputSource.pause();
      writeStderr("\n");
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Claude authentication was cancelled."));
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onSigint = () => cancel();
    const onSigterm = () => cancel();
    const onSighup = () => cancel();
    const onEnd = () => fail(new Error("Claude authentication input closed."));
    const onError = () => fail(new Error("Claude authentication input failed."));
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cancel();
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
        if (value.length > MAX_CLAUDE_TOKEN_CHARS) {
          fail(new Error("Claude subscription token is too large."));
          return;
        }
      }
    };
    signalSource.once("SIGINT", onSigint);
    signalSource.once("SIGTERM", onSigterm);
    signalSource.once("SIGHUP", onSighup);
    inputSource.on("data", onData);
    inputSource.on("end", onEnd);
    inputSource.on("close", onEnd);
    inputSource.on("error", onError);
  });
}

async function collectCodexAuth(
  runCommand: NonNullable<AuthConnectDependencies["runCommand"]>,
): Promise<string> {
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const codexHome = await mkdtemp(join(temporaryRoot, "tiller-codex-login-"));
  await chmod(codexHome, 0o700);
  try {
    await writeFile(join(codexHome, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      "",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    process.stderr.write("[tiller] Starting an isolated Codex subscription login.\n");
    await runCommand("codex", ["login"], {
      env: buildSubscriptionLoginEnvironment("codex", codexHome),
      stdio: "inherit",
      windowsHide: true,
    });
    const authPath = join(codexHome, "auth.json");
    const metadata = await stat(authPath).catch(() => null);
    if (!metadata?.isFile()) throw new Error("Codex login completed without creating auth.json.");
    if (metadata.size < 1 || metadata.size > MAX_CODEX_AUTH_BYTES) {
      throw new Error("Codex auth.json is empty or too large.");
    }
    const authJson = await readFile(authPath, "utf8");
    let value: unknown;
    try { value = JSON.parse(authJson) as unknown; } catch { throw new Error("Codex produced an invalid auth.json file."); }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value as { auth_mode?: unknown }).auth_mode !== "chatgpt") {
      throw new Error("Codex login did not produce ChatGPT subscription credentials.");
    }
    return authJson;
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function collectClaudeToken(
  runCommand: NonNullable<AuthConnectDependencies["runCommand"]>,
  promptHidden: NonNullable<AuthConnectDependencies["promptHidden"]>,
): Promise<string> {
  process.stderr.write("[tiller] Starting Claude subscription token setup.\n");
  await runCommand("claude", ["setup-token"], {
    env: buildSubscriptionLoginEnvironment("claude"),
    stdio: "inherit",
    windowsHide: true,
  });
  const token = (await promptHidden("Paste the Claude subscription token (input hidden): ")).trim();
  if (!token) throw new Error("Claude subscription token is required.");
  if (token.length > MAX_CLAUDE_TOKEN_CHARS) throw new Error("Claude subscription token is too large.");
  return token;
}

export async function collectSubscriptionCredentials(
  providers: AuthConnectProvider[],
  dependencies: AuthConnectDependencies = {},
): Promise<CollectedSubscriptionCredentials> {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const promptHidden = dependencies.promptHidden ?? readHiddenInput;
  const result: CollectedSubscriptionCredentials = {};
  if (providers.includes("codex")) result.codexAuthJson = await collectCodexAuth(runCommand);
  if (providers.includes("claude")) result.claudeOauthToken = await collectClaudeToken(runCommand, promptHidden);
  return result;
}

export function parseAuthConnectProviders(args: string[]): AuthConnectProvider[] {
  if (args.length === 0) return ["codex", "claude"];
  if (args.length === 1 && (args[0] === "codex" || args[0] === "claude")) return [args[0]];
  throw new Error("Usage: tiller auth connect [codex|claude] [--hub-url <origin>]");
}

async function uploadCredential(options: {
  fetchImpl: typeof fetch;
  hubUrl: string;
  accessHeaders: Record<string, string>;
  provider: AuthConnectProvider;
  grant: string;
  body: Record<string, unknown>;
}): Promise<void> {
  const serialized = JSON.stringify(options.body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_UPLOAD_BODY_BYTES) {
    throw new Error(`${options.provider === "codex" ? "Codex" : "Claude"} authentication upload is too large.`);
  }
  const response = await options.fetchImpl(
    `${options.hubUrl}/api/auth/subscriptions/${options.provider}/connect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tiller-Auth-Grant": options.grant,
        ...options.accessHeaders,
      },
      body: serialized,
    },
  );
  if (response.ok) return;
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  const message = typeof payload?.error === "string" && payload.error.trim()
    ? payload.error.trim()
    : `Hub rejected the ${options.provider} authentication upload (HTTP ${response.status}).`;
  throw new Error(message);
}

export async function runAuthConnectCommand(
  args: string[],
  options: { hubUrlOverride?: string; dependencies?: AuthConnectDependencies } = {},
): Promise<void> {
  const providers = parseAuthConnectProviders(args);
  const dependencies = options.dependencies ?? {};
  await (dependencies.initialize ?? ensureInteractiveConfig)({ hubUrlOverride: options.hubUrlOverride });
  (dependencies.validateAuth ?? ensureAuth)();
  const hubUrl = dependencies.hubUrl ?? HUB_URL;
  const accessHeaders = dependencies.accessHeaders ?? hubControlHeaders;
  const credentials = await collectSubscriptionCredentials(providers, dependencies);
  const approval = await (dependencies.approve ?? runAuthConnectApproval)(hubUrl, providers);
  if (new URL(approval.hubUrl).origin !== new URL(hubUrl).origin) {
    throw new Error("Owner approval returned a different Hub origin.");
  }
  const fetchImpl = dependencies.fetch ?? fetch;
  for (const provider of providers) {
    const grant = approval.grants[provider];
    if (!grant) throw new Error(`Owner approval did not include a ${provider} connection grant.`);
    if (provider === "codex") {
      if (!credentials.codexAuthJson) throw new Error("Codex authentication was not collected.");
      await uploadCredential({
        fetchImpl,
        hubUrl,
        accessHeaders,
        provider,
        grant,
        body: { version: 1, auth_json: credentials.codexAuthJson },
      });
    } else {
      if (!credentials.claudeOauthToken) throw new Error("Claude authentication was not collected.");
      await uploadCredential({
        fetchImpl,
        hubUrl,
        accessHeaders,
        provider,
        grant,
        body: { version: 1, oauth_token: credentials.claudeOauthToken },
      });
    }
    process.stderr.write(`[tiller] ${provider === "codex" ? "Codex" : "Claude"} subscription connected and activated.\n`);
  }
}
