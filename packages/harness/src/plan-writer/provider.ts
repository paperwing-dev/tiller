import { createHash } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeTuiLaunch, PlanWriterContext } from "./contract.js";
import { renderManagedPlanWriterContext } from "./context.js";
import { CodexAppServer } from "./codex-app-server.js";
import {
  CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG,
} from "../codex-config.js";
import {
  sanitizeCodexChildEnvironment,
  type GetCodexRuntimeAuth,
} from "../codex-app-server-client.js";
import { sanitizeClaudeChildEnvironment } from "../claude-environment.js";
import {
  CLAUDE_REPO_PLAN_MUTATION_TOOLS,
  CLAUDE_REPO_PLAN_TOOLS,
  codexRepoPlansTomlLines,
  REPO_PLANS_MCP_COMMAND,
  REPO_PLANS_SERVER_NAME,
  repoPlansEnabled,
} from "./repo-plans.js";

const BASE_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "TZ"] as const;
const CLAUDE_AUTH_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const CODEX_AUTH_ALLOWLIST = [
  "OPENAI_API_KEY",
] as const;

function copyAllowed(source: NodeJS.ProcessEnv, keys: readonly string[], target: Record<string, string>): void {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export function renderCodexPlanWriterConfig(input: {
  model: string;
  planModeReasoningEffort?: string;
  fastMode?: boolean;
  repoPlansSocketPath?: string;
}): string {
  return (
    [
      `model = ${JSON.stringify(input.model)}`,
      ...(input.planModeReasoningEffort
        ? [
            `plan_mode_reasoning_effort = ${JSON.stringify(input.planModeReasoningEffort)}`,
          ]
        : []),
      ...(input.fastMode
        ? ['service_tier = "fast"', "features.fast_mode = true"]
        : []),
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      'notify = ["tiller-plan-writer-codex-notify"]',
      "features.plugins = false",
      "[mcp_servers]",
      ...(input.repoPlansSocketPath
        ? codexRepoPlansTomlLines(input.repoPlansSocketPath)
        : []),
    ].join("\n") + "\n"
  );
}

export function buildProviderEnvironment(input: {
  provider: "claude-code" | "codex";
  home: string;
  socketPath: string;
  contextPath: string;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = input.source ?? process.env;
  const env: Record<string, string> = {
    HOME: input.home,
    USER: "tiller",
    LOGNAME: "tiller",
    SHELL: "/bin/bash",
    TMPDIR: join(input.home, "tmp"),
    // Root creates this protected config while materializing the read-only
    // checkout. It permits provider-side Git reads without granting writes.
    GIT_CONFIG_GLOBAL: "/run/tiller-plan-writer-gitconfig",
    TILLER_PLAN_WRITER_SOCKET: input.socketPath,
    TILLER_PLAN_WRITER_CONTEXT_PATH: input.contextPath,
    ...(input.provider === "claude-code" ? { CLAUDE_CONFIG_DIR: join(input.home, "claude-state") } : {}),
  };
  copyAllowed(source, BASE_ENV_ALLOWLIST, env);
  const externalCodexAuth = input.provider === "codex"
    && source.TILLER_CODEX_RUNTIME_MODE === "app-server"
    && source.TILLER_CODEX_AUTH_MODE === "subscription";
  if (!externalCodexAuth) {
    copyAllowed(source, input.provider === "claude-code" ? CLAUDE_AUTH_ALLOWLIST : CODEX_AUTH_ALLOWLIST, env);
  }
  if (input.provider === "claude-code") {
    const resolvedMode = source.TILLER_CLAUDE_AUTH_RESOLVED_MODE;
    if (resolvedMode === "subscription" || resolvedMode === "api") {
      env.TILLER_CLAUDE_AUTH_RESOLVED_MODE = resolvedMode;
    }
    return sanitizeClaudeChildEnvironment(env);
  }
  return sanitizeCodexChildEnvironment(env, {
    authMode: externalCodexAuth ? "subscription" : "api-key",
  });
}

export function deterministicClaudeSessionId(identity: string): string {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function installClaudeConfiguration(
  home: string,
  context: PlanWriterContext,
  account: { uid: number; gid: number },
): string {
  const stateDirectory = join(home, "claude-state");
  const directory = join(home, "managed-claude");
  const settingsPath = join(directory, "settings.json");
  const tempDirectory = join(home, "tmp");
  mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
  chownSync(tempDirectory, account.uid, account.gid);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chownSync(stateDirectory, account.uid, account.gid);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const command = "tiller-plan-writer-hook";
  const repoPlans = repoPlansEnabled(context);
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: {
          defaultMode: "plan",
          allow: repoPlans ? CLAUDE_REPO_PLAN_TOOLS : [],
        },
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
          Stop: [{ hooks: [{ type: "command", command }] }],
          StopFailure: [{ hooks: [{ type: "command", command }] }],
          PreToolUse: [
            {
              matcher: "ExitPlanMode",
              hooks: [{ type: "command", command, timeout: 120 }],
            },
            ...(repoPlans
              ? CLAUDE_REPO_PLAN_MUTATION_TOOLS.map((matcher) => ({
                  matcher,
                  hooks: [{ type: "command", command }],
                }))
              : []),
          ],
        },
        enabledPlugins: {},
        mcpServers: {},
      },
      null,
      2,
    ),
    { mode: 0o400 },
  );
  chmodSync(settingsPath, 0o444);
  chmodSync(directory, 0o555);
  return settingsPath;
}

export async function buildClaudeLaunch(input: {
  context: PlanWriterContext;
  checkoutDir: string;
  home: string;
  socketPath: string;
  contextPath: string;
  account: { uid: number; gid: number };
}): Promise<NativeTuiLaunch> {
  const settingsPath = installClaudeConfiguration(input.home, input.context, input.account);
  const conversationId = deterministicClaudeSessionId(
    `${input.context.writer.repoId}\0${input.context.writer.planArtifactId}\0${input.context.writer.generation}`,
  );
  return {
    command: "claude",
    args: [
      "--session-id",
      conversationId,
      "--permission-mode",
      "plan",
      "--setting-sources",
      "user",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({
        mcpServers: repoPlansEnabled(input.context)
          ? {
              [REPO_PLANS_SERVER_NAME]: {
                command: REPO_PLANS_MCP_COMMAND,
                args: [],
              },
            }
          : {},
      }),
      "--no-chrome",
      "--model",
      input.context.writer.model,
      "--settings",
      settingsPath,
      "--append-system-prompt-file",
      input.contextPath,
    ],
    conversationId,
    env: buildProviderEnvironment({
      provider: "claude-code",
      home: input.home,
      socketPath: input.socketPath,
      contextPath: input.contextPath,
    }),
  };
}

export async function buildCodexLaunch(input: {
  context: PlanWriterContext;
  checkoutDir: string;
  home: string;
  socketPath: string;
  contextPath: string;
  appServerSocketPath: string;
  account: { uid: number; gid: number };
  getAuth?: GetCodexRuntimeAuth;
}): Promise<NativeTuiLaunch & { appServer: CodexAppServer; threadId: string }> {
  mkdirSync(join(input.home, ".codex"), { recursive: true, mode: 0o700 });
  mkdirSync(join(input.home, "tmp"), { recursive: true, mode: 0o700 });
  const env = buildProviderEnvironment({
    provider: "codex",
    home: input.home,
    socketPath: input.socketPath,
    contextPath: input.contextPath,
  });
  writeFileSync(
    join(input.home, ".codex", "config.toml"),
    renderCodexPlanWriterConfig({
      model: input.context.writer.model,
      planModeReasoningEffort: input.context.writer.effort,
      fastMode: input.context.writer.fastMode,
      ...(repoPlansEnabled(input.context)
        ? { repoPlansSocketPath: input.socketPath }
        : {}),
    }),
    { mode: 0o400 },
  );
  for (const path of [input.home, join(input.home, ".codex"), join(input.home, ".codex", "config.toml"), join(input.home, "tmp")]) {
    chownSync(path, input.account.uid, input.account.gid);
  }
  const appServer = new CodexAppServer({
    socketPath: input.appServerSocketPath,
    cwd: input.checkoutDir,
    env,
    account: input.account,
    ...(input.getAuth ? { getAuth: input.getAuth } : {}),
    ...(repoPlansEnabled(input.context)
      ? { repoPlansSocketPath: input.socketPath }
      : {}),
  });
  await appServer.start();
  const threadId = await appServer.createManagedThread({
    model: input.context.writer.model,
    context: renderManagedPlanWriterContext(input.context),
  });
  return {
    command: "codex",
    args: [
      "resume",
      "--remote",
      `unix://${input.appServerSocketPath}`,
      threadId,
      "--strict-config",
      "-C",
      input.checkoutDir,
      "-m",
      input.context.writer.model,
      CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG,
    ],
    conversationId: threadId,
    threadId,
    appServer,
    env,
    initializeTui: (writeInput) => appServer.initializeManagedPlanTui({
      threadId,
      writeInput,
    }).then(() => undefined),
    afterExit: () => appServer.stop(),
  };
}
