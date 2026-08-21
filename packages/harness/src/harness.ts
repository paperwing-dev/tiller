export type Harness = "claude-code" | "codex" | "opencode";

export function isHarness(value: string | null | undefined): value is Harness {
  return value === "claude-code" || value === "codex" || value === "opencode";
}

export function resolveHarness(value?: string | null): Harness {
  if (isHarness(value)) {
    return value;
  }

  throw new Error("TILLER_HARNESS must be 'claude-code', 'codex', or 'opencode'");
}

export function getHarnessLabel(harness: Harness): string {
  return harness === "codex"
    ? "Codex"
    : harness === "opencode"
      ? "OpenCode"
      : "Claude Code";
}
