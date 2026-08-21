import type { ProviderCommand } from "./types.js";

// Claude Code headless one-shot. NEVER --bare: bare mode does not read the
// subscription OAuth token used by the machine execution backend.
export interface ClaudeArgsOptions {
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export function buildArgs(options: ClaudeArgsOptions): ProviderCommand {
  return {
    command: "claude",
    args: [
      "-p",
      options.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
      ...(options.model?.trim() ? ["--model", options.model.trim()] : []),
      ...(options.effort ? ["--effort", options.effort] : []),
    ],
    env: {},
  };
}
