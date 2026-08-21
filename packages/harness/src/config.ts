import { hostname } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// ── Config loading ───────────────────────────────────────────────────

export interface TillerConfig {
  hubUrl?: string;
  namespace?: string;
  clientId?: string;
  clientSecret?: string;
}

export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "~";
export const CONFIG_PATH = process.env.TILLER_CONFIG_PATH || resolve(HOME_DIR, ".config/tiller/config.json");

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function isWorkersDevHubUrl(hubUrl: string): boolean {
  if (!hubUrl) return false;

  try {
    return new URL(hubUrl).hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

export function loadConfig(): TillerConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

const config = loadConfig();

export const HUB_URL = normalizeUrl(process.env.HUB_URL || config.hubUrl);
export const NAMESPACE = process.env.NAMESPACE || config.namespace || hostname();
export const MACHINE_ID = process.env.MACHINE_ID || hostname();
const RAW_CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID || config.clientId || "";
const RAW_CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || config.clientSecret || "";
export const IS_WORKERS_DEV_HUB = isWorkersDevHubUrl(HUB_URL);
export const CF_ACCESS_CLIENT_ID = RAW_CF_ACCESS_CLIENT_ID;
export const CF_ACCESS_CLIENT_SECRET = RAW_CF_ACCESS_CLIENT_SECRET;
export const HAS_CF_ACCESS_SERVICE_TOKEN = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET);

export const cfTransportHeaders: Record<string, string> = {
  ...(CF_ACCESS_CLIENT_ID ? { "CF-Access-Client-Id": CF_ACCESS_CLIENT_ID } : {}),
  ...(CF_ACCESS_CLIENT_SECRET ? { "CF-Access-Client-Secret": CF_ACCESS_CLIENT_SECRET } : {}),
};

export const environmentRuntimeHeaders: Record<string, string> = {
  ...cfTransportHeaders,
  ...(process.env.TILLER_RUNTIME_CAPABILITY?.trim()
    ? { "X-Tiller-Capability": process.env.TILLER_RUNTIME_CAPABILITY.trim() }
    : {}),
};

export function ensureAuth(): void {
  if (!HUB_URL) {
    console.error(`Hub URL required. Set HUB_URL or add hubUrl to ${CONFIG_PATH}`);
    process.exit(1);
  }
  if ((CF_ACCESS_CLIENT_ID && !CF_ACCESS_CLIENT_SECRET) || (!CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET)) {
    console.error("Incomplete CF Access service token. Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.");
    console.error(`or add both clientId and clientSecret to ${CONFIG_PATH}`);
    process.exit(1);
  }
  if (IS_WORKERS_DEV_HUB && !HAS_CF_ACCESS_SERVICE_TOKEN) {
    console.error("Protected workers.dev hubs require the Tiller Cloudflare Access service token.");
    process.exit(1);
  }
}
