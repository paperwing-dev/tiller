import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRequiredScopes,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  OAuthScopeError,
  REQUIRED_CLOUDFLARE_OAUTH_SCOPES,
} from "./oauth";
import type { Env } from "./types";

const env = {
  CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
  CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
  OAUTH_REDIRECT_URI: "https://install.paperwing.dev/oauth/callback",
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe("Cloudflare OAuth", () => {
  it("uses state, S256 PKCE, the exact callback, and no offline scope", () => {
    const url = new URL(buildAuthorizationUrl(env, { state: "one-time-state", challenge: "pkce-value" }));
    expect(url.origin + url.pathname).toBe("https://dash.cloudflare.com/oauth2/auth");
    expect(url.searchParams.get("state")).toBe("one-time-state");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://install.paperwing.dev/oauth/callback");
    const expectedClientScopes = [
      "user-details.read",
      "account-settings.read",
      "workers-scripts.write",
      "workers-kv-storage.write",
      "workers-r2.write",
      "containers.write",
      "access.write",
      "access-acct.write",
      "access-service-token.write",
    ];
    expect(REQUIRED_CLOUDFLARE_OAUTH_SCOPES).toEqual(expectedClientScopes);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(expectedClientScopes);
    expect(url.searchParams.get("scope")).not.toContain("offline");
  });

  it("rejects an omitted or partial grant", () => {
    expect(() => assertRequiredScopes([])).toThrow(OAuthScopeError);
    expect(() => assertRequiredScopes(REQUIRED_CLOUDFLARE_OAUTH_SCOPES)).not.toThrow();
    expect(() => assertRequiredScopes(["user-details.read"])).toThrow(OAuthScopeError);
  });

  it("normalizes an omitted token-response scope to the requested grant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "oauth-token" })));
    await expect(exchangeAuthorizationCode(env, { code: "code", verifier: "verifier" }))
      .resolves.toEqual({
        accessToken: "oauth-token",
        grantedScopes: [...REQUIRED_CLOUDFLARE_OAUTH_SCOPES],
      });
  });
});
