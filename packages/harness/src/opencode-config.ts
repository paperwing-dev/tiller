export type OpenCodeProviderKind =
  "openai" | "anthropic" | "cloudflare-workers-ai";

export type OpenCodeConfigEnv = Readonly<Record<string, string | undefined>>;

export interface OpenCodeSelection {
  providerKind: OpenCodeProviderKind;
  providerAlias: string;
  providerLabel: string;
  providerPackage: "@ai-sdk/anthropic" | "@ai-sdk/openai-compatible";
  modelAlias: string;
  modelLabel: string;
  modelId: string;
  modelLimit: {
    context: number;
    input?: number;
    output: number;
  };
  baseURL: string;
  apiKey: string;
}

export interface OpenCodeConfigOptions {
  reasoningEffort?: string;
  requireReasoningEffort?: boolean;
}

const SELECTION_ENV_NAMES = [
  "TILLER_OPENCODE_BASE_URL",
  "TILLER_OPENCODE_AUTH_TOKEN",
  "TILLER_OPENCODE_PROVIDER_KIND",
  "TILLER_OPENCODE_PROVIDER_ALIAS",
  "TILLER_OPENCODE_PROVIDER_LABEL",
  "TILLER_OPENCODE_MODEL_ID",
  "TILLER_OPENCODE_MODEL_ALIAS",
  "TILLER_OPENCODE_MODEL_LABEL",
  "TILLER_OPENCODE_MODEL_CONTEXT_LIMIT",
  "TILLER_OPENCODE_MODEL_INPUT_LIMIT",
  "TILLER_OPENCODE_MODEL_OUTPUT_LIMIT",
] as const;

function readValue(
  env: OpenCodeConfigEnv,
  name: string,
  fallback = "",
): string {
  const value = env[name]?.trim() ?? "";
  return value || fallback;
}

function requireValue(env: OpenCodeConfigEnv, name: string): string {
  const value = readValue(env, name);
  if (!value)
    throw new Error(
      `${name} is required to render the OpenCode configuration.`,
    );
  return value;
}

function positiveInteger(
  env: OpenCodeConfigEnv,
  name: string,
  required: boolean,
): number | undefined {
  const raw = readValue(env, name);
  if (!raw && !required) return undefined;
  if (!raw)
    throw new Error(
      `${name} is required to render the OpenCode configuration.`,
    );
  if (!/^\d+$/.test(raw))
    throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export function resolveOpenCodeSelection(
  env: OpenCodeConfigEnv = process.env,
  allowMissing = false,
): OpenCodeSelection | null {
  if (
    allowMissing &&
    !SELECTION_ENV_NAMES.some((name) => readValue(env, name))
  ) {
    return null;
  }

  const providerKind = requireValue(env, "TILLER_OPENCODE_PROVIDER_KIND");
  if (
    providerKind !== "openai" &&
    providerKind !== "anthropic" &&
    providerKind !== "cloudflare-workers-ai"
  ) {
    throw new Error(
      `Unsupported TILLER_OPENCODE_PROVIDER_KIND: ${providerKind}`,
    );
  }
  const contextLimit = positiveInteger(
    env,
    "TILLER_OPENCODE_MODEL_CONTEXT_LIMIT",
    true,
  )!;
  const inputLimit = positiveInteger(
    env,
    "TILLER_OPENCODE_MODEL_INPUT_LIMIT",
    false,
  );
  const outputLimit = positiveInteger(
    env,
    "TILLER_OPENCODE_MODEL_OUTPUT_LIMIT",
    true,
  )!;

  return {
    providerKind,
    providerAlias: requireValue(env, "TILLER_OPENCODE_PROVIDER_ALIAS"),
    providerLabel: requireValue(env, "TILLER_OPENCODE_PROVIDER_LABEL"),
    providerPackage:
      providerKind === "anthropic"
        ? "@ai-sdk/anthropic"
        : "@ai-sdk/openai-compatible",
    modelAlias: requireValue(env, "TILLER_OPENCODE_MODEL_ALIAS"),
    modelLabel: requireValue(env, "TILLER_OPENCODE_MODEL_LABEL"),
    modelId: requireValue(env, "TILLER_OPENCODE_MODEL_ID"),
    modelLimit: {
      context: contextLimit,
      ...(inputLimit ? { input: inputLimit } : {}),
      output: outputLimit,
    },
    baseURL: requireValue(env, "TILLER_OPENCODE_BASE_URL"),
    apiKey: requireValue(env, "TILLER_OPENCODE_AUTH_TOKEN"),
  };
}

export function buildOpenCodeConfig(
  env: OpenCodeConfigEnv = process.env,
  options: OpenCodeConfigOptions = {},
) {
  const selection = resolveOpenCodeSelection(env);
  if (!selection) throw new Error("OpenCode selection is required.");

  const reasoningEffort =
    options.reasoningEffort?.trim() ||
    readValue(env, "TILLER_OPENCODE_REASONING_EFFORT");
  if ((options.requireReasoningEffort ?? true) && !reasoningEffort) {
    throw new Error(
      "TILLER_OPENCODE_REASONING_EFFORT is required to render the OpenCode configuration.",
    );
  }

  const providerOptions: {
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  } = {
    baseURL: selection.baseURL,
    apiKey: selection.apiKey,
  };
  const cfAccessClientId = readValue(env, "CF_ACCESS_CLIENT_ID");
  const cfAccessClientSecret = readValue(env, "CF_ACCESS_CLIENT_SECRET");
  if (
    selection.providerKind === "cloudflare-workers-ai" &&
    cfAccessClientId &&
    cfAccessClientSecret
  ) {
    providerOptions.headers = {
      "CF-Access-Client-Id": cfAccessClientId,
      "CF-Access-Client-Secret": cfAccessClientSecret,
    };
  }

  const selectedModel = `${selection.providerAlias}/${selection.modelAlias}`;
  const modelOptions = reasoningEffort
    ? selection.providerKind === "anthropic"
      ? {
          thinking: { type: "adaptive", display: "summarized" },
          effort: reasoningEffort,
        }
      : { reasoningEffort }
    : null;
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    enabled_providers: [selection.providerAlias],
    provider: {
      [selection.providerAlias]: {
        npm: selection.providerPackage,
        name: selection.providerLabel,
        options: providerOptions,
        models: {
          [selection.modelAlias]: {
            id: selection.modelId,
            name: selection.modelLabel,
            limit: selection.modelLimit,
            ...(modelOptions ? { options: modelOptions } : {}),
          },
        },
      },
    },
    model: selectedModel,
    small_model: selectedModel,
    permission: {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
    },
    share: "disabled",
  };
}

export function renderOpenCodeConfig(
  env: OpenCodeConfigEnv = process.env,
  options: OpenCodeConfigOptions = {},
): string {
  return `${JSON.stringify(buildOpenCodeConfig(env, options), null, 2)}\n`;
}
