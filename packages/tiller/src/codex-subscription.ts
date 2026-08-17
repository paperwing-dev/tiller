import {
  HUB_URL,
  hubControlHeaders,
} from "./config.js";

export interface HubSetupStatus {
  enabledHarnesses: string[];
  protectionMode?: "public" | "cf-access";
  hasChatGPTAuth: boolean;
  chatgptAuthStatus?: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
  hasOpenAIKey: boolean;
  claudeBillingMode?: "subscription" | "api" | null;
  openaiBillingMode?: "subscription" | "api" | null;
  codexRouteStatus?: "available" | "backend_offline" | "runtime_update_required" | "environment_not_connected" | "authentication_unavailable" | "direct_api" | "unavailable";
  openaiPlannerRoute?: "api-key" | "subscription-app-server" | null;
  openaiPlannerReason?: string | null;
  hostRegistered: boolean;
  hostConnected: boolean;
}

export class HubSetupStatusError extends Error {
  code: "auth-required" | "http-error" | "invalid-response";
  status?: number;

  constructor(code: "auth-required" | "http-error" | "invalid-response", message: string, status?: number) {
    super(message);
    this.name = "HubSetupStatusError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchHubSetupStatus(
  hubUrl = HUB_URL,
  headers: Record<string, string> = hubControlHeaders,
): Promise<HubSetupStatus> {
  const response = await fetch(`${hubUrl}/api/setup/status`, {
    headers: {
      Accept: "application/json",
      ...headers,
    },
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const raw = await response.text();

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HubSetupStatusError(
        "auth-required",
        "Protected hub access credentials need to be refreshed. Reconnect tiller in the browser and try again.",
        response.status,
      );
    }
    throw new HubSetupStatusError("http-error", `Failed to fetch setup status: ${response.status}`, response.status);
  }

  if (!contentType.includes("application/json")) {
    const looksLikeAccessLogin =
      contentType.includes("text/html")
      || /<html/i.test(raw)
      || /Cloudflare Access/i.test(raw)
      || /Sign in ・ Cloudflare Access/i.test(raw);
    throw new HubSetupStatusError(
      looksLikeAccessLogin ? "auth-required" : "invalid-response",
      looksLikeAccessLogin
        ? "Protected hub access credentials need to be refreshed. Reconnect tiller in the browser and try again."
        : "The hub returned an unexpected response while reading setup status.",
      response.status,
    );
  }

  try {
    const parsed = JSON.parse(raw) as HubSetupStatus;
    if (
      !parsed
      || typeof parsed !== "object"
      || !Array.isArray(parsed.enabledHarnesses)
      || typeof parsed.hostRegistered !== "boolean"
      || typeof parsed.hostConnected !== "boolean"
    ) {
      throw new Error("invalid setup status");
    }
    return parsed;
  } catch {
    throw new HubSetupStatusError(
      "invalid-response",
      "The hub returned malformed setup status JSON.",
      response.status,
    );
  }
}

export function isHubSetupStatusAuthError(error: unknown): boolean {
  return error instanceof HubSetupStatusError && error.code === "auth-required";
}
