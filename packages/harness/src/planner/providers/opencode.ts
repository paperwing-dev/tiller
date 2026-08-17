import { writeOpenCodeConfigContent } from "../../mcp-config.js";
import {
  renderOpenCodeConfig,
  resolveOpenCodeSelection,
} from "../../opencode-config.js";
import type { ProviderCommand } from "./types.js";

// OpenCode headless JSON runs via `opencode run --format json`. Auth goes
// through the hub's OpenCode proxy. Planner and interactive sessions share the
// same renderer, because one-shot containers exec tiller-planner before the
// interactive entrypoint block runs.

export function buildOpenCodeProxyConfig(
  env: NodeJS.ProcessEnv = process.env,
  effort?: "low" | "medium" | "high" | "xhigh" | "ultra" | "max",
): string | null {
  const selection = resolveOpenCodeSelection(env, true);
  if (!selection) return null;
  return renderOpenCodeConfig(env, {
    reasoningEffort: effort,
    requireReasoningEffort: false,
  });
}

export interface OpenCodeArgsOptions {
  prompt: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "ultra" | "max";
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export function buildArgs(options: OpenCodeArgsOptions): ProviderCommand {
  const env = options.env ?? process.env;
  const selection = resolveOpenCodeSelection(env, true);
  const proxyConfig = buildOpenCodeProxyConfig(env, options.effort);
  if (selection && options.model.trim() !== selection.modelId) {
    throw new Error(
      `Planner OpenCode model ${options.model} does not match the selected runtime model ${selection.modelId}.`,
    );
  }
  if (proxyConfig) {
    // Write to the file OpenCode scans AND export the env var; older
    // versions only honor one of the two.
    if (options.configPath) {
      writeOpenCodeConfigContent(proxyConfig, options.configPath);
    } else {
      writeOpenCodeConfigContent(proxyConfig);
    }
  }
  const args = ["run", "--format", "json"];
  // `opencode run -m` expects provider/model format. With the hub proxy
  // configured, the alias is the only valid model reference; without it,
  // OpenCode's own configured default applies (raw model ids like @cf/… are
  // not valid -m values).
  if (proxyConfig) {
    if (!selection) throw new Error("OpenCode proxy configuration is missing its selection.");
    args.push("--model", `${selection.providerAlias}/${selection.modelAlias}`);
  }
  args.push(options.prompt);
  return {
    command: "opencode",
    args,
    env: {
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...(proxyConfig ? { OPENCODE_CONFIG_CONTENT: proxyConfig } : {}),
    },
  };
}
