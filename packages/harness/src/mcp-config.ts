import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { HOME_DIR } from "./config.js";

export const TILLER_MCP_SERVERS_ENV_VAR = "TILLER_MCP_SERVERS_JSON";
export const TILLER_MCP_MANAGED_ID_PREFIX = "tiller_";
export const OPENCODE_CONFIG_PATH = resolve(HOME_DIR, ".config/opencode/config.json");

const LOCAL_HOST_SUFFIXES = [
  "corp",
  "example",
  "home",
  "home.arpa",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "onion",
  "test",
];

export interface ManagedMcpServer {
  id: string;
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function validatePublicHostname(id: string, hostname: string): void {
  const normalized = normalizeHostname(hostname);
  if (!normalized || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.includes(":")) {
    throw new Error(`MCP server ${id} URL must use a public hostname.`);
  }
  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => label.length === 0)) {
    throw new Error(`MCP server ${id} URL must use a public hostname.`);
  }
  if (LOCAL_HOST_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
    throw new Error(`MCP server ${id} URL must use a public hostname.`);
  }
}

function validateMcpServer(input: unknown): ManagedMcpServer {
  if (!isRecord(input)) {
    throw new Error("MCP server entries must be objects.");
  }
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("MCP server id is invalid.");
  }
  if (!id.startsWith(TILLER_MCP_MANAGED_ID_PREFIX)) {
    throw new Error("MCP server id is not Tiller-managed.");
  }
  if (url.includes("?")) {
    throw new Error(`MCP server ${id} URL cannot include a query string.`);
  }
  if (url.includes("#")) {
    throw new Error(`MCP server ${id} URL cannot include a fragment.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MCP server ${id} URL is invalid.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`MCP server ${id} URL must use https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`MCP server ${id} URL cannot include credentials.`);
  }
  if (parsed.search) {
    throw new Error(`MCP server ${id} URL cannot include a query string.`);
  }
  if (parsed.hash) {
    throw new Error(`MCP server ${id} URL cannot include a fragment.`);
  }
  validatePublicHostname(id, parsed.hostname);
  return { id, url: parsed.href };
}

export function readManagedMcpServersFromEnv(env: NodeJS.ProcessEnv = process.env): ManagedMcpServer[] {
  const raw = env[TILLER_MCP_SERVERS_ENV_VAR]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${TILLER_MCP_SERVERS_ENV_VAR} must be valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${TILLER_MCP_SERVERS_ENV_VAR} must be a JSON array.`);
  }
  const servers = parsed.map(validateMcpServer);
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) {
      throw new Error(`Duplicate MCP server id: ${server.id}`);
    }
    ids.add(server.id);
  }
  return servers;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function removeManagedMcpEntries(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.startsWith(TILLER_MCP_MANAGED_ID_PREFIX)) {
      next[key] = entry;
    }
  }
  return next;
}

export function buildManagedClaudeMcpServers(
  existingMcpServers: unknown,
  servers: ManagedMcpServer[],
): Record<string, unknown> {
  const mcpServers = removeManagedMcpEntries(existingMcpServers);
  for (const server of servers) {
    mcpServers[server.id] = {
      type: "http",
      url: server.url,
    };
  }
  return mcpServers;
}

export function buildCodexMcpConfigOverrides(
  servers: ManagedMcpServer[],
): string[] {
  return servers.map(
    (server) => `mcp_servers.${server.id}={ url = ${JSON.stringify(server.url)} }`,
  );
}

export function applyManagedOpenCodeMcpConfig(
  baseConfigContent: string,
  servers: ManagedMcpServer[],
): string {
  const parsed = baseConfigContent.trim()
    ? JSON.parse(baseConfigContent) as unknown
    : {};
  if (!isRecord(parsed)) {
    throw new Error("OpenCode config content must be a JSON object.");
  }
  const config = { ...parsed };
  const mcp = removeManagedMcpEntries(config.mcp);
  for (const server of servers) {
    mcp[server.id] = {
      type: "remote",
      url: server.url,
      enabled: true,
      oauth: false,
    };
  }
  config.mcp = mcp;
  return JSON.stringify(config, null, 2) + "\n";
}

export function writeOpenCodeConfigContent(
  content: string,
  configPath = OPENCODE_CONFIG_PATH,
): void {
  writeJson(configPath, JSON.parse(content) as unknown);
  process.env.OPENCODE_CONFIG_CONTENT = content;
}
