export type ResolvedClaudeBillingMode = "subscription" | "api";

export const HARNESS_OWNED_CLAUDE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_ACCESS_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "TILLER_CLAUDE_AUTH_MODE",
  "TILLER_CLAUDE_AUTH_WARNING",
  "TILLER_CLAUDE_AUTH_RESOLVED_MODE",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDECODE",
  "CLAUDE_CODE",
] as const;

function readMode(env: NodeJS.ProcessEnv | Record<string, string>): ResolvedClaudeBillingMode | null {
  return env.TILLER_CLAUDE_AUTH_RESOLVED_MODE === "subscription"
    || env.TILLER_CLAUDE_AUTH_RESOLVED_MODE === "api"
    ? env.TILLER_CLAUDE_AUTH_RESOLVED_MODE
    : null;
}

/**
 * Final Claude spawn boundary. Remove every harness-owned credential/control,
 * then restore only the route already selected and materialized by the Hub.
 */
export function sanitizeClaudeChildEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  const mode = readMode(env);
  const selectedCredential = mode === "subscription"
    ? env.CLAUDE_CODE_OAUTH_TOKEN
    : mode === "api"
      ? env.ANTHROPIC_API_KEY
      : undefined;

  for (const key of HARNESS_OWNED_CLAUDE_ENV_KEYS) delete env[key];

  if (mode && selectedCredential) {
    if (mode === "subscription") env.CLAUDE_CODE_OAUTH_TOKEN = selectedCredential;
    else env.ANTHROPIC_API_KEY = selectedCredential;
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
    env.TILLER_CLAUDE_AUTH_RESOLVED_MODE = mode;
  }
  return env;
}
