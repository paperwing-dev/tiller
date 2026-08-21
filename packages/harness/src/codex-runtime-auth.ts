import {
  CodexRuntimeAuthError,
  type CodexRuntimeAuthErrorCode,
  type GetCodexRuntimeAuth,
} from "./codex-app-server-client.js";

interface RuntimeAuthResponse {
  access_token?: unknown;
  account_id?: unknown;
  expires_at?: unknown;
  code?: unknown;
  error?: unknown;
}

const ERROR_CODES = new Set<CodexRuntimeAuthErrorCode>([
  "needs_reconnect",
  "auth_temporarily_unavailable",
  "runtime_inactive",
]);

export const CODEX_RUNTIME_AUTH_HTTP_TIMEOUT_MS = 8_500;

function normalizedErrorCode(value: unknown, status: number): CodexRuntimeAuthErrorCode {
  if (typeof value === "string" && ERROR_CODES.has(value as CodexRuntimeAuthErrorCode)) {
    return value as CodexRuntimeAuthErrorCode;
  }
  return status === 503 ? "auth_temporarily_unavailable" : "needs_reconnect";
}

export function createCodexRuntimeAuthGetter(input: {
  url: string;
  tokenHeader: string;
  token: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): GetCodexRuntimeAuth {
  const url = input.url.trim();
  const token = input.token.trim();
  if (!url || !token) throw new Error("Codex runtime-auth callback configuration is incomplete");
  return async (rejectedAccessTokenSha256) => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [input.tokenHeader]: token,
          ...(input.headers ?? {}),
        },
        body: JSON.stringify({
          ...(rejectedAccessTokenSha256
            ? { rejected_access_token_sha256: rejectedAccessTokenSha256 }
            : {}),
        }),
        signal: AbortSignal.timeout(input.timeoutMs ?? CODEX_RUNTIME_AUTH_HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CodexRuntimeAuthError(
        `Codex subscription authentication is temporarily unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "auth_temporarily_unavailable",
      );
    }
    const body = await response.json().catch(() => ({})) as RuntimeAuthResponse;
    if (!response.ok) {
      throw new CodexRuntimeAuthError(
        typeof body.error === "string" && body.error.trim()
          ? body.error.trim()
          : `Codex runtime-auth returned HTTP ${response.status}`,
        normalizedErrorCode(body.code, response.status),
      );
    }
    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    const expiresAt = typeof body.expires_at === "string" ? body.expires_at.trim() : "";
    if (!accessToken || !accountId || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
      throw new CodexRuntimeAuthError("Codex runtime-auth returned malformed credentials", "needs_reconnect");
    }
    return { accessToken, accountId, expiresAt };
  };
}
