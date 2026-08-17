import {
  CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG,
  buildCodexReasoningEffortOverride,
  ensureCodexProjectTrust,
} from "../../codex-config.js";
import type { ProviderCommand } from "./types.js";

// Codex headless one-shot via `codex exec` uses OPENAI_API_KEY. Subscription
// executions are owned by the app-server runtime instead.

export interface CodexArgsOptions {
  prompt: string;
  model: string;
  checkoutDir: string;
  fallbackOutputFile: string;
  configPath?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
}

export function buildArgs(options: CodexArgsOptions): ProviderCommand {
  const model = options.model.trim();
  if (!model) throw new Error("A Codex planner model is required");
  // codex refuses untrusted project dirs; the checkout is created per run.
  ensureCodexProjectTrust(options.checkoutDir, options.configPath);

  const commonArgs = [
    "--json",
    "--output-last-message",
    options.fallbackOutputFile,
    "--skip-git-repo-check",
    CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG,
  ];
  commonArgs.push(
    "-c",
    buildCodexReasoningEffortOverride(options.effort ?? "xhigh"),
    "-m",
    model,
  );
  const args = ["exec", options.prompt, ...commonArgs];
  return { command: "codex", args, env: {} };
}
