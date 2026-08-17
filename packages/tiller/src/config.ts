import { hostname } from "node:os";
import { resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// ── Config loading ───────────────────────────────────────────────────

export interface TillerConfig {
  hubUrl?: string;
  clientId?: string;
  clientSecret?: string;
  controlSecret?: string;
  machineId?: string;
  displayName?: string;
  localRunnerPort?: number;
  localRunnerImage?: string;
}

export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "~";
export const TILLER_CONFIG_DIR = resolve(HOME_DIR, ".config/tiller");
export const LOCAL_STATE_DIR = resolve(TILLER_CONFIG_DIR, "local");
export const CONFIG_PATH = process.env.TILLER_CONFIG_PATH || resolve(TILLER_CONFIG_DIR, "config.json");

function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

export interface LoadedDotEnvValue {
  path: string;
  value: string;
}

export const loadedDotEnvValues: Record<string, LoadedDotEnvValue> = {};

function loadDotEnv(): void {
  const candidates = [
    process.env.TILLER_DOTENV_PATH,
    resolve(TILLER_CONFIG_DIR, ".env"),
    resolve(process.cwd(), ".env"),
  ].filter((value): value is string => Boolean(value && value.trim()));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;

    const parsed = parseDotEnv(readFileSync(candidate, "utf-8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] == null) {
        process.env[key] = value;
        loadedDotEnvValues[key] = { path: candidate, value };
      }
    }
  }
}

loadDotEnv();

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function isWorkersDevHubUrl(hubUrl: string): boolean {
  if (!hubUrl) return false;

  try {
    const url = new URL(hubUrl);
    return url.protocol === "https:"
      && url.hostname.endsWith(".workers.dev")
      && url.hostname !== "workers.dev"
      && url.port === ""
      && (url.pathname === "" || url.pathname === "/")
      && url.search === ""
      && url.hash === ""
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

export function isMachineUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value.trim());
}

export function normalizeTillerConfig(value: unknown): TillerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const string = (key: string): string | undefined => {
    const candidate = source[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  };
  const legacyWorkersDevUrl = string("workersDevHubUrl");
  const configuredHubUrl = string("hubUrl");
  const hubUrl = isWorkersDevHubUrl(legacyWorkersDevUrl ?? "")
    ? normalizeUrl(legacyWorkersDevUrl)
    : configuredHubUrl
      ? normalizeUrl(configuredHubUrl)
      : undefined;
  const localRunnerPort = source.localRunnerPort;
  const normalized: Record<string, unknown> = { ...source };
  for (const key of [
    "gatewayPort",
    "cloudflaredConfigPath",
    "gatewayTunnelName",
    "gatewayTunnelId",
    "gatewayTunnelToken",
    "gatewayTargetPort",
    "gatewayHostname",
    "gatewayServiceToken",
    "tunnelToken",
    "codexGatewayAuthMode",
    "workersDevHubUrl",
    "selfHostSetupAttemptId",
    "selfHostEnableToken",
    "customDomainAttempt",
    "promotion",
    "namespace",
    "publicHub",
    "hostnameIdentity",
    "machineHostname",
  ]) {
    delete normalized[key];
  }
  if (hubUrl) normalized.hubUrl = hubUrl;
  else delete normalized.hubUrl;
  for (const key of ["clientId", "clientSecret", "controlSecret", "displayName", "localRunnerImage"]) {
    const valueString = string(key);
    if (valueString) normalized[key] = valueString;
    else delete normalized[key];
  }
  const machineId = string("machineId");
  if (machineId && isMachineUuid(machineId)) normalized.machineId = machineId;
  else delete normalized.machineId;
  delete normalized.skipCodexSubscriptionPrompt;
  if (typeof localRunnerPort !== "number" || !Number.isInteger(localRunnerPort)) {
    delete normalized.localRunnerPort;
  }
  return normalized as TillerConfig;
}

export function loadConfig(): TillerConfig {
  try {
    return normalizeTillerConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf-8")));
  } catch {
    return {};
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function writeConfig(config: TillerConfig): void {
  mkdirSync(TILLER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  chmodSync(TILLER_CONFIG_DIR, 0o700);
  if (existsSync(CONFIG_PATH)) chmodSync(CONFIG_PATH, 0o600);
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(normalizeTillerConfig(config), null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(CONFIG_PATH, 0o600);
}

export function authErrorMessage(): string | null {
  const problems: string[] = [];

  if (!HUB_URL) {
    problems.push(`Hub URL required. Run \`tiller\` or \`tiller init\` to configure it, or set HUB_URL / add hubUrl to ${CONFIG_PATH}`);
  } else if (!isWorkersDevHubUrl(HUB_URL) && !isLocalHubUrl(HUB_URL)) {
    problems.push(
      "The saved Hub URL is not the canonical workers.dev origin. Run "
      + "`tiller host setup --hub-url https://<exact-host>.workers.dev`.",
    );
  }

  return problems.length > 0 ? problems.join("\n") : null;
}

export const DEFAULT_LOCAL_RUNNER_IMAGE = "docker.io/jamieatlason/tiller-sandbox:stable";

let config = loadConfig();

export let HUB_URL = "";
export let IS_WORKERS_DEV_HUB = false;
export let MACHINE_ID = "";
export let MACHINE_DISPLAY_NAME = hostname();
export let CF_ACCESS_CLIENT_ID = "";
export let CF_ACCESS_CLIENT_SECRET = "";
export let CONTROL_SECRET = "";
export let LOCAL_RUNNER_PORT = 8789;
export let LOCAL_RUNNER_IMAGE = DEFAULT_LOCAL_RUNNER_IMAGE;
export let HAS_CF_ACCESS_SERVICE_TOKEN = false;
export let cfTransportHeaders: Record<string, string> = {};
export let hubControlHeaders: Record<string, string> = {};

export function reloadConfig(): void {
  config = loadConfig();
  HUB_URL = normalizeUrl(process.env.HUB_URL || config.hubUrl);
  IS_WORKERS_DEV_HUB = isWorkersDevHubUrl(HUB_URL);
  const rawClientId = process.env.CF_ACCESS_CLIENT_ID || config.clientId || "";
  const rawClientSecret = process.env.CF_ACCESS_CLIENT_SECRET || config.clientSecret || "";
  // Execution-machine identity is durable configuration generated by
  // `tiller host setup`. An environment override could silently present this
  // installation as a different machine and strand pinned workloads.
  MACHINE_ID = config.machineId?.trim() || "";
  MACHINE_DISPLAY_NAME = process.env.TILLER_MACHINE_DISPLAY_NAME?.trim()
    || config.displayName?.trim()
    || hostname();
  CF_ACCESS_CLIENT_ID = rawClientId;
  CF_ACCESS_CLIENT_SECRET = rawClientSecret;
  CONTROL_SECRET = config.controlSecret?.trim() || "";
  LOCAL_RUNNER_PORT = parseInteger(process.env.TILLER_LOCAL_RUNNER_PORT, config.localRunnerPort ?? 8789);
  LOCAL_RUNNER_IMAGE =
    process.env.TILLER_LOCAL_RUNNER_IMAGE ||
    config.localRunnerImage ||
    DEFAULT_LOCAL_RUNNER_IMAGE;
  HAS_CF_ACCESS_SERVICE_TOKEN = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET);
  cfTransportHeaders = {
    ...(CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID } : {}),
    ...(CF_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET } : {}),
  };
  hubControlHeaders = {
    ...cfTransportHeaders,
    ...(CONTROL_SECRET ? { "X-Tiller-Capability": CONTROL_SECRET } : {}),
  };
}

reloadConfig();

export function ensureAuth(): void {
  const message = authErrorMessage();
  if (message) {
    console.error(message);
    process.exit(1);
  }
}

export function isLocalHubUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function ensureHostAuth(): void {
  const problems: string[] = [];
  if (!HUB_URL || (!isWorkersDevHubUrl(HUB_URL) && !isLocalHubUrl(HUB_URL))) {
    problems.push("an exact workers.dev Hub URL");
  }
  if (!isMachineUuid(MACHINE_ID)) problems.push("a generated machine UUID");
  if (!isLocalHubUrl(HUB_URL) && (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET)) {
    problems.push("a valid Hub service credential");
  }
  if (!isLocalHubUrl(HUB_URL) && !CONTROL_SECRET) problems.push("a control credential");
  if (problems.length > 0) {
    throw new Error(
      `Execution machine configuration is missing ${problems.join(", ")}. Run \`tiller host setup --hub-url https://<exact-host>.workers.dev\`.`,
    );
  }
}
