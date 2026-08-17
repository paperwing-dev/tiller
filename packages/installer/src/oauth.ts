import type { Env } from "./types";
import {
  readBoundedResponseJson,
  readBoundedResponseText,
  withAbortDeadline,
} from "./outbound";

const AUTHORIZATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_ENDPOINT = "https://dash.cloudflare.com/oauth2/token";
const REVOCATION_ENDPOINT = "https://dash.cloudflare.com/oauth2/revoke";
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

// These are the fine-grained OAuth permissions configured on the confidential
// installer client. The disposable-account release gate must prove this exact
// list before the client is promoted to production.
export const REQUIRED_CLOUDFLARE_OAUTH_SCOPES = [
  "user-details.read",
  "account-settings.read",
  "workers-scripts.write",
  "workers-kv-storage.write",
  "workers-r2.write",
  "containers.write",
  "access.write",
  "access-acct.write",
  "access-service-token.write",
] as const;

const SAFE_TOKEN_ERRORS = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

export class OAuthExchangeError extends Error {
  readonly status: number;
  readonly oauthError: string | null;

  constructor(status = 0, oauthError: unknown = null) {
    super("Cloudflare authorization could not be exchanged");
    this.name = "OAuthExchangeError";
    this.status = Number.isSafeInteger(status) && status >= 0 ? status : 0;
    this.oauthError = typeof oauthError === "string" && SAFE_TOKEN_ERRORS.has(oauthError)
      ? oauthError
      : null;
  }
}

export class OAuthScopeError extends Error {
  constructor() {
    super("Cloudflare authorization is missing required permissions");
    this.name = "OAuthScopeError";
  }
}

function configuredClient(env: Env): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.CLOUDFLARE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.OAUTH_REDIRECT_URI?.trim();
  if (
    !clientId
    || !clientSecret
    || redirectUri !== "https://install.paperwing.dev/oauth/callback"
  ) {
    throw new Error("Installer OAuth client is not configured");
  }
  return { clientId, clientSecret, redirectUri };
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

export function buildAuthorizationUrl(
  env: Env,
  args: { state: string; challenge: string },
): string {
  const client = configuredClient(env);
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", REQUIRED_CLOUDFLARE_OAUTH_SCOPES.join(" "));
  return url.toString();
}

export async function exchangeAuthorizationCode(
  env: Env,
  args: { code: string; verifier: string },
): Promise<{ accessToken: string; grantedScopes: string[] }> {
  const client = configuredClient(env);
  let status = 0;
  let completed: { response: Response; body: Record<string, unknown> | null };
  try {
    completed = await withAbortDeadline(async (signal) => {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        signal,
        redirect: "manual",
        headers: {
          Authorization: basicAuthorization(client.clientId, client.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: args.code,
          redirect_uri: client.redirectUri,
          code_verifier: args.verifier,
        }),
      });
      status = response.status;
      return {
        response,
        body: await readBoundedResponseJson<Record<string, unknown>>(
          response,
          MAX_OAUTH_RESPONSE_BYTES,
        ),
      };
    });
  } catch {
    throw new OAuthExchangeError(status);
  }

  const token = typeof completed.body?.access_token === "string"
    ? completed.body.access_token.trim()
    : "";
  if (!completed.response.ok || !token) {
    throw new OAuthExchangeError(completed.response.status, completed.body?.error);
  }
  const rawScope = typeof completed.body?.scope === "string" ? completed.body.scope : "";
  // RFC 6749 permits omission only when the granted scope is identical to the
  // request. Normalize that case here so the validator itself remains strict.
  const grantedScopes = rawScope.trim()
    ? rawScope.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean)
    : [...REQUIRED_CLOUDFLARE_OAUTH_SCOPES];
  return { accessToken: token, grantedScopes };
}

export function assertRequiredScopes(grantedScopes: readonly string[]): void {
  const granted = new Set(grantedScopes);
  const missing = REQUIRED_CLOUDFLARE_OAUTH_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) throw new OAuthScopeError();
}

export async function revokeAccessToken(
  env: Env,
  accessToken: string,
  timeoutMs?: number,
): Promise<void> {
  const client = configuredClient(env);
  let response: Response;
  try {
    response = await withAbortDeadline(async (signal) => {
      const result = await fetch(REVOCATION_ENDPOINT, {
        method: "POST",
        signal,
        redirect: "manual",
        headers: {
          Authorization: basicAuthorization(client.clientId, client.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ token: accessToken }),
      });
      await readBoundedResponseText(result, MAX_OAUTH_RESPONSE_BYTES);
      return result;
    }, timeoutMs);
  } catch {
    throw new Error("Cloudflare authorization revocation failed");
  }
  if (!response.ok) throw new Error("Cloudflare authorization revocation failed");
}
