import type { Harness } from "./harness.js";

export type RunnerReadyStrategy = "spawned" | "first-output";

export function resolveResumeArgs(harness: Harness, resumeRequested: boolean): string[] {
  if (!resumeRequested) {
    return [];
  }

  return [harness === "opencode" ? "--continue" : "--resume"];
}

export function resolveDebugCliArgs(
  harness: Harness,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (harness === "opencode" && env.TILLER_OPENCODE_DEBUG === "1") {
    return ["--print-logs", "--log-level", "DEBUG"];
  }

  return [];
}

export function resolveClaudeModelEffortArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const model = env.TILLER_CLAUDE_MODEL?.trim() ?? "";
  const effort = env.TILLER_CLAUDE_EFFORT?.trim() ?? "";
  if (!model) throw new Error("TILLER_CLAUDE_MODEL is required for a Claude Code launch");
  if (!effort) throw new Error("TILLER_CLAUDE_EFFORT is required for a Claude Code launch");
  return ["--model", model, "--effort", effort];
}

export function resolveRunnerReadyStrategy(harness: Harness): RunnerReadyStrategy {
  return harness === "claude-code" ? "spawned" : "first-output";
}

export const STARTUP_PLAN_IMPLEMENTATION_PREAMBLE = [
  "Read the approved startup plan below and execute it immediately.",
  "",
  "Work step by step, update files as needed, run relevant checks, and continue until the plan is complete or you hit a real blocker.",
  "",
  "Startup plan:",
  "",
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context.",
  "Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation",
  "and verification.",
].join("\n");

export const MAX_STARTUP_PLAN_CLI_ARG_BYTES = 96 * 1024;

export function buildStartupPlanDocument(planText: string): string {
  const trimmed = planText.trim();
  if (!trimmed) {
    return STARTUP_PLAN_IMPLEMENTATION_PREAMBLE;
  }

  const normalized = trimmed.replace(/\r\n/g, "\n");
  if (normalized.startsWith(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE)) {
    return trimmed;
  }

  return `${STARTUP_PLAN_IMPLEMENTATION_PREAMBLE}\n\n${trimmed}`;
}

export function buildInteractiveStartupPlanPrompt(planText: string): string {
  return buildStartupPlanDocument(planText);
}

export function resolveStartupPlanCliArgs(
  harness: Harness,
  startupPlanPrompt?: string,
) : string[] {
  if (
    !startupPlanPrompt
    || new TextEncoder().encode(startupPlanPrompt).byteLength > MAX_STARTUP_PLAN_CLI_ARG_BYTES
  ) {
    return [];
  }

  if (harness === "opencode") {
    return ["--prompt", startupPlanPrompt];
  }

  if (harness === "codex" || harness === "claude-code") {
    return [startupPlanPrompt];
  }

  return [];
}

export function buildHarnessSpawnArgs(
  baseArgs: readonly string[],
  initialStartupPlanCliArgs: readonly string[],
  isReplacement: boolean,
): string[] {
  return isReplacement
    ? [...baseArgs]
    : [...baseArgs, ...initialStartupPlanCliArgs];
}
