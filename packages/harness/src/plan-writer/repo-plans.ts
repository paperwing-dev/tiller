export const REPO_PLANS_SERVER_NAME = "tiller_plans";
export const REPO_PLANS_MCP_COMMAND = "tiller-plan-writer-plans-mcp";
export const REPO_PLAN_COMMAND_PROXY_TIMEOUT_MS = 120_000;
export const REPO_PLAN_MCP_ATTEMPT_TIMEOUT_MS =
  REPO_PLAN_COMMAND_PROXY_TIMEOUT_MS + 5_000;
export const REPO_PLAN_TOOL_NAMES = [
  "list_plans",
  "read_plan",
  "create_plan",
  "update_plan",
] as const;

export type RepoPlanToolName = (typeof REPO_PLAN_TOOL_NAMES)[number];

function claudeRepoPlanToolName<T extends RepoPlanToolName>(
  tool: T,
): `mcp__${typeof REPO_PLANS_SERVER_NAME}__${T}` {
  return `mcp__${REPO_PLANS_SERVER_NAME}__${tool}`;
}

export const CLAUDE_REPO_PLAN_TOOLS = REPO_PLAN_TOOL_NAMES.map((tool) =>
  claudeRepoPlanToolName(tool),
);

const REPO_PLAN_MUTATION_TOOL_NAMES = ["create_plan", "update_plan"] as const satisfies
  readonly RepoPlanToolName[];

export const CLAUDE_REPO_PLAN_MUTATION_TOOLS =
  REPO_PLAN_MUTATION_TOOL_NAMES.map((tool) => claudeRepoPlanToolName(tool));

export function isClaudeRepoPlanMutationTool(
  value: unknown,
): value is (typeof CLAUDE_REPO_PLAN_MUTATION_TOOLS)[number] {
  return (
    typeof value === "string" &&
    CLAUDE_REPO_PLAN_MUTATION_TOOLS.some((tool) => tool === value)
  );
}

export const OPENCODE_REPO_PLAN_TOOLS = REPO_PLAN_TOOL_NAMES.map(
  (tool) => `${REPO_PLANS_SERVER_NAME}_${tool}`,
);

export function repoPlansEnabled(context: {
  capabilities?: { repoPlansV1?: true };
}): boolean {
  return context.capabilities?.repoPlansV1 === true;
}

export interface CodexRepoPlansServerConfig {
  command: typeof REPO_PLANS_MCP_COMMAND;
  enabled: true;
  enabled_tools: RepoPlanToolName[];
  default_tools_approval_mode: "approve";
  env: { TILLER_PLAN_WRITER_SOCKET: string };
}

export function codexRepoPlansServerConfig(
  socketPath: string,
): CodexRepoPlansServerConfig {
  return {
    command: REPO_PLANS_MCP_COMMAND,
    enabled: true,
    enabled_tools: [...REPO_PLAN_TOOL_NAMES],
    default_tools_approval_mode: "approve",
    env: { TILLER_PLAN_WRITER_SOCKET: socketPath },
  };
}

export function codexRepoPlansTomlLines(socketPath: string): string[] {
  const config = codexRepoPlansServerConfig(socketPath);
  return [
    `[mcp_servers.${REPO_PLANS_SERVER_NAME}]`,
    `command = ${JSON.stringify(config.command)}`,
    `enabled = ${String(config.enabled)}`,
    `enabled_tools = ${JSON.stringify(config.enabled_tools)}`,
    `default_tools_approval_mode = ${JSON.stringify(config.default_tools_approval_mode)}`,
    `env = { TILLER_PLAN_WRITER_SOCKET = ${JSON.stringify(config.env.TILLER_PLAN_WRITER_SOCKET)} }`,
  ];
}

export function codexRepoPlansCliOverrides(socketPath: string): string[] {
  const config = codexRepoPlansServerConfig(socketPath);
  return Object.entries(config).flatMap(([field, value]) => [
    "-c",
    `mcp_servers.${REPO_PLANS_SERVER_NAME}.${field}=${
      field === "env"
        ? `{ TILLER_PLAN_WRITER_SOCKET = ${JSON.stringify(config.env.TILLER_PLAN_WRITER_SOCKET)} }`
        : JSON.stringify(value)
    }`,
  ]);
}
