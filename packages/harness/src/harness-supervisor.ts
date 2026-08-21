export interface HarnessRespawnPolicyOptions {
  isInteractive: boolean;
  hubUrl?: string | null;
  repoSlug?: string | null;
}

export interface HarnessRespawnBudgetOptions {
  currentCount: number;
  lastRespawnAtMs: number;
  nowMs?: number;
  maxRespawns?: number;
  resetWindowMs?: number;
}

export interface HarnessRespawnBudgetResult {
  allow: boolean;
  nextCount: number;
  nextRespawnAtMs: number;
}

export const CODEX_TERMINAL_AUTH_EXIT_CODE = 78;

export type HarnessExitClassification = "retryable" | "terminal-auth";

export function classifyHarnessExit(code: number): HarnessExitClassification {
  return code === CODEX_TERMINAL_AUTH_EXIT_CODE ? "terminal-auth" : "retryable";
}

export function codexRuntimeExitCode(error: unknown): number {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "needs_reconnect"
    || code === "runtime_inactive"
    ? CODEX_TERMINAL_AUTH_EXIT_CODE
    : 1;
}

export function shouldKeepHarnessAlive(options: HarnessRespawnPolicyOptions): boolean {
  return !options.isInteractive && Boolean(options.hubUrl?.trim() || options.repoSlug?.trim());
}

export function evaluateHarnessRespawnBudget(
  options: HarnessRespawnBudgetOptions,
): HarnessRespawnBudgetResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxRespawns = options.maxRespawns ?? 10;
  const resetWindowMs = options.resetWindowMs ?? 300_000;
  const withinWindow =
    options.lastRespawnAtMs > 0 && nowMs - options.lastRespawnAtMs <= resetWindowMs;
  const nextCount = withinWindow ? options.currentCount + 1 : 1;

  return {
    allow: nextCount <= maxRespawns,
    nextCount,
    nextRespawnAtMs: nowMs,
  };
}
