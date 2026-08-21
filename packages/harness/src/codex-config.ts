import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HOME_DIR } from "./config.js";

export const CODEX_CONFIG_PATH = resolve(HOME_DIR, ".codex/config.toml");
export const CODEX_HOOKS_PATH = resolve(HOME_DIR, ".codex/hooks.json");
export const CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG = "--dangerously-bypass-approvals-and-sandbox";
export const CODEX_BYPASS_HOOK_TRUST_ARG = "--dangerously-bypass-hook-trust";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexModelSettings {
  model: string;
  reasoningEffort: CodexReasoningEffort;
  fastMode: boolean;
}

const MANAGED_TRUST_START = "# BEGIN TILLER MANAGED CODEX PROJECT TRUST";
const MANAGED_TRUST_END = "# END TILLER MANAGED CODEX PROJECT TRUST";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlQuotedKey(value: string): string {
  return JSON.stringify(value);
}

function uniqueProjectPaths(cwd: string): string[] {
  return [...new Set(["/workspace", resolve(cwd)])];
}

export function resolveCodexModelSettings(
  env: NodeJS.ProcessEnv = process.env,
): CodexModelSettings {
  const model = env.TILLER_CODEX_MODEL?.trim() ?? "";
  const effort = env.TILLER_CODEX_REASONING_EFFORT?.trim() ?? "";
  const fastMode = env.TILLER_CODEX_FAST_MODE?.trim() ?? "0";
  if (!model) throw new Error("TILLER_CODEX_MODEL is required for a Codex launch");
  if (
    effort !== "low"
    && effort !== "medium"
    && effort !== "high"
    && effort !== "xhigh"
    && effort !== "max"
    && effort !== "ultra"
  ) {
    throw new Error("TILLER_CODEX_REASONING_EFFORT must be low, medium, high, xhigh, max, or ultra");
  }
  if (fastMode !== "0" && fastMode !== "1") {
    throw new Error("TILLER_CODEX_FAST_MODE must be 0 or 1");
  }
  return { model, reasoningEffort: effort, fastMode: fastMode === "1" };
}

export function buildCodexModelOverrides(settings: CodexModelSettings): string[] {
  return [
    `model=${JSON.stringify(settings.model)}`,
    `model_reasoning_effort=${JSON.stringify(settings.reasoningEffort)}`,
    ...(settings.fastMode
      ? [
          "features.fast_mode=true",
          'service_tier="fast"',
        ]
      : []),
  ];
}

export function buildCodexReasoningEffortOverride(reasoningEffort: CodexReasoningEffort): string {
  return `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`;
}

export function splitCodexRemoteRuntimeArgs(args: string[]): {
  appServerArgs: string[];
  tuiArgs: string[];
} {
  const appServerArgs: string[] = [];
  const tuiArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1];
    if ((arg === "-c" || arg === "--config") && value !== undefined) {
      appServerArgs.push("-c", value);
      tuiArgs.push(arg, value);
      index += 1;
      continue;
    }
    tuiArgs.push(arg);
  }
  return { appServerArgs, tuiArgs };
}

export function buildCodexProjectTrustBlock(cwd: string): string {
  const projects = uniqueProjectPaths(cwd)
    .map((project) => [
      `[projects.${tomlQuotedKey(project)}]`,
      'trust_level = "trusted"',
    ].join("\n"))
    .join("\n\n");

  return [
    MANAGED_TRUST_START,
    projects,
    MANAGED_TRUST_END,
  ].join("\n");
}

export function ensureCodexProjectTrust(cwd: string, configPath = CODEX_CONFIG_PATH): void {
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf-8");
  } catch {
    existing = "";
  }

  const managedBlockPattern = new RegExp(
    `\\n?${escapeRegExp(MANAGED_TRUST_START)}[\\s\\S]*?${escapeRegExp(MANAGED_TRUST_END)}\\n?`,
    "g",
  );
  const unmanagedConfig = existing
    .replace(managedBlockPattern, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  const managedBlock = buildCodexProjectTrustBlock(cwd);
  const nextConfig = unmanagedConfig
    ? `${unmanagedConfig}\n\n${managedBlock}\n`
    : `${managedBlock}\n`;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, nextConfig);
}

interface CodexHookHandler {
  type: string;
  command: string;
  [key: string]: unknown;
}

interface CodexHookGroup {
  matcher?: string;
  hooks?: CodexHookHandler[];
  [key: string]: unknown;
}

function withoutManagedActivityHooks(value: unknown): CodexHookGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: CodexHookGroup[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const group = candidate as CodexHookGroup;
    const handlers = Array.isArray(group.hooks)
      ? group.hooks.filter((handler) => !(
          typeof handler?.command === "string"
          && handler.command.includes(".config/tiller/hooks/activity-hook.mjs")
        ))
      : [];
    if (handlers.length > 0) groups.push({ ...group, hooks: handlers });
  }
  return groups;
}

export function removeCodexActivityHooks(
  hooksPath = CODEX_HOOKS_PATH,
): void {
  let document: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  } catch {
    document = {};
  }
  const hooks = document.hooks && typeof document.hooks === "object" && !Array.isArray(document.hooks)
    ? document.hooks as Record<string, unknown>
    : {};
  for (const event of Object.keys(hooks)) {
    const groups = withoutManagedActivityHooks(hooks[event]);
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  document.hooks = hooks;
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(document, null, 2)}\n`);
}
