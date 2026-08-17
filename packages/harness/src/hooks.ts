import { resolve, dirname } from "node:path";
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HOME_DIR } from "./config.js";
import { buildManagedClaudeMcpServers, type ManagedMcpServer } from "./mcp-config.js";

export const CLAUDE_SETTINGS_PATH = resolve(HOME_DIR, ".claude/settings.json");
const CLAUDE_STATE_PATH = resolve(HOME_DIR, ".claude.json");
export const OPENCODE_ACTIVITY_PLUGIN_PATH = resolve(
  HOME_DIR,
  ".config/opencode/plugins/tiller-activity.mjs",
);

export interface InstalledHarnessHooks {
  permissionHookPath: string;
  activityHookPath: string;
  openCodeActivityPluginPath: string;
}

function packageHookPath(fileName: string): string {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  return resolve(sourceDir, `../hooks/${fileName}`);
}

export function installHarnessHooks(): InstalledHarnessHooks {
  const hookDir = resolve(HOME_DIR, ".config/tiller/hooks");
  mkdirSync(hookDir, { recursive: true });
  mkdirSync(dirname(OPENCODE_ACTIVITY_PLUGIN_PATH), { recursive: true });

  const permissionHookPath = resolve(hookDir, "pre-tool-use.mjs");
  const activityHookPath = resolve(hookDir, "activity-hook.mjs");
  const assets = [
    [packageHookPath("pre-tool-use.mjs"), permissionHookPath],
    [packageHookPath("activity-hook.mjs"), activityHookPath],
    [packageHookPath("opencode-activity.mjs"), OPENCODE_ACTIVITY_PLUGIN_PATH],
  ] as const;
  for (const [source, destination] of assets) {
    if (existsSync(source)) copyFileSync(source, destination);
  }

  return {
    permissionHookPath,
    activityHookPath,
    openCodeActivityPluginPath: OPENCODE_ACTIVITY_PLUGIN_PATH,
  };
}

export function installHook(): string {
  return installHarnessHooks().permissionHookPath;
}

function isManagedHookCommand(command: unknown, fileName: string): boolean {
  return typeof command === "string"
    && command.includes(".config/tiller/hooks/")
    && command.includes(fileName);
}

function withoutManagedHook(
  groups: unknown[],
  fileName: string,
): Array<{ matcher?: string; hooks?: Array<{ type: string; command: string }> }> {
  return groups
    .map((value) => {
      if (!value || typeof value !== "object") return null;
      const group = value as {
        matcher?: string;
        hooks?: Array<{ type: string; command: string }>;
      };
      const handlers = Array.isArray(group.hooks)
        ? group.hooks.filter((handler) => !isManagedHookCommand(handler?.command, fileName))
        : [];
      return handlers.length > 0 ? { ...group, hooks: handlers } : null;
    })
    .filter((value): value is { matcher?: string; hooks: Array<{ type: string; command: string }> } => Boolean(value));
}

function appendCommandHook(
  hooks: Record<string, unknown[]>,
  event: string,
  command: string,
  fileName: string,
): void {
  const groups = withoutManagedHook(hooks[event] ?? [], fileName);
  groups.push({ hooks: [{ type: "command", command }] });
  hooks[event] = groups;
}

export function ensureClaudeSettings(
  permissionHookPath: string | null,
  activityHookPath?: string,
): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, "utf-8"));
  } catch { /* file doesn't exist yet */ }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const cleanedPreToolUse = withoutManagedHook(
    hooks.PreToolUse ?? [],
    "pre-tool-use.mjs",
  );
  if (permissionHookPath) {
    cleanedPreToolUse.push({
      hooks: [{ type: "command", command: `node ${JSON.stringify(permissionHookPath)}` }],
    });
    console.error(`[tiller] Installed PreToolUse hook → ${permissionHookPath}`);
  }
  hooks.PreToolUse = cleanedPreToolUse;

  if (activityHookPath) {
    for (const [event, state] of [
      ["UserPromptSubmit", "working"],
      ["Stop", "completed"],
      ["StopFailure", "idle"],
    ] as const) {
      appendCommandHook(
        hooks,
        event,
        `node ${JSON.stringify(activityHookPath)} ${state}`,
        "activity-hook.mjs",
      );
    }
    console.error(`[tiller] Installed Claude activity hooks → ${activityHookPath}`);
  }

  settings.hooks = hooks;
  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

export function ensureClaudeAutonomousSettings(cwd: string, mcpServers: ManagedMcpServer[] = []): void {
  mkdirSync(dirname(CLAUDE_STATE_PATH), { recursive: true });
  mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });

  // Pre-approve the API key so Claude Code skips the "Detected a custom API key"
  // dialog. Claude stores approved keys as key.slice(-20) in customApiKeyResponses.
  const useSubscriptionAuth =
    process.env.TILLER_HARNESS === "claude-code" &&
    process.env.TILLER_CLAUDE_AUTH_RESOLVED_MODE === "subscription";
  const apiKey = useSubscriptionAuth ? undefined : process.env.ANTHROPIC_API_KEY;
  const customApiKeyResponses = apiKey
    ? { approved: [apiKey.slice(-20)], rejected: [] }
    : { approved: [], rejected: [] };
  let existingState: Record<string, unknown> = {};
  try {
    existingState = JSON.parse(readFileSync(CLAUDE_STATE_PATH, "utf-8")) as Record<string, unknown>;
  } catch {
    existingState = {};
  }
  const existingProjects = existingState && typeof existingState.projects === "object" && existingState.projects
    ? existingState.projects as Record<string, unknown>
    : {};
  const existingProject = existingProjects[cwd] && typeof existingProjects[cwd] === "object"
    ? existingProjects[cwd] as Record<string, unknown>
    : {};
  const existingMcpServers = existingProject.mcpServers && typeof existingProject.mcpServers === "object"
    ? existingProject.mcpServers as Record<string, unknown>
    : {};
  const nextMcpServers = buildManagedClaudeMcpServers(existingMcpServers, mcpServers);

  writeFileSync(
    CLAUDE_STATE_PATH,
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      customApiKeyResponses,
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          allowedTools: [],
          mcpServers: nextMcpServers,
        },
      },
    }),
  );
  writeFileSync(
    CLAUDE_SETTINGS_PATH,
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      ...(process.env.TILLER_CLAUDE_FAST_MODE === "1" ? { fastMode: true } : {}),
    }, null, 2) + "\n",
  );
}
