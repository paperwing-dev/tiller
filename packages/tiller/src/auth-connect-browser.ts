import { compactDecrypt } from "jose";
import {
  exactBrowserHubOrigin,
  normalizeBrowserConnectionCode,
  runBrowserLoopback,
} from "./browser-loopback.js";

export type AuthConnectProvider = "codex" | "claude";

export interface AuthConnectPackageV1 {
  version: 1;
  hubUrl: string;
  state: string;
  iat: number;
  exp: number;
  grants: Partial<Record<AuthConnectProvider, string>>;
}

export interface AuthConnectApproval {
  version: 1;
  hubUrl: string;
  grants: Partial<Record<AuthConnectProvider, string>>;
}

const CALLBACK_PATH = "/auth-connect-callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY_BYTES = 32 * 1_024;
const PACKAGE_TTL_SECONDS = 5 * 60;

export function buildAuthConnectSettingsUrl(
  hubUrl: string,
  port: number,
  state: string,
  encodedPublicKey: string,
  providers: AuthConnectProvider[],
): string {
  return `${hubUrl}/settings?auth_connect=1&port=${port}&state=${encodeURIComponent(state)}&key=${encodeURIComponent(encodedPublicKey)}&providers=${encodeURIComponent(providers.join(","))}`;
}

export async function decryptAuthConnectEnvelope(
  inputEnvelope: string,
  privateKey: CryptoKey,
  expected: {
    state: string;
    hubUrl: string;
    providers: AuthConnectProvider[];
    nowSeconds?: number;
  },
): Promise<AuthConnectApproval> {
  const envelope = normalizeBrowserConnectionCode(inputEnvelope);
  if (envelope.split(".").length !== 5) throw new Error("Connection code is not a valid encrypted package.");
  let decrypted;
  try { decrypted = await compactDecrypt(envelope, privateKey); } catch {
    throw new Error("Connection code could not be decrypted by this Tiller process.");
  }
  if (
    decrypted.protectedHeader.alg !== "ECDH-ES"
    || decrypted.protectedHeader.enc !== "A256GCM"
    || decrypted.protectedHeader.typ !== "tiller-auth-connect+jwe"
  ) throw new Error("Connection code used an unsupported encryption format.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(decrypted.plaintext)) as unknown; } catch {
    throw new Error("Authentication connection package is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Authentication connection package is invalid.");
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = ["exp", "grants", "hubUrl", "iat", "state", "version"];
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Authentication connection package is invalid.");
  }
  if (!payload.grants || typeof payload.grants !== "object" || Array.isArray(payload.grants)) {
    throw new Error("Authentication connection package is invalid.");
  }
  const grants = payload.grants as Record<string, unknown>;
  const expectedProviders = [...expected.providers].sort();
  const actualProviders = Object.keys(grants).sort();
  if (
    actualProviders.length !== expectedProviders.length
    || actualProviders.some((provider, index) => provider !== expectedProviders[index])
  ) throw new Error("Authentication connection package providers did not match.");
  const normalizedGrants: Partial<Record<AuthConnectProvider, string>> = {};
  for (const provider of expected.providers) {
    const grant = grants[provider];
    if (typeof grant !== "string" || !grant.trim() || grant.length > 256) {
      throw new Error("Authentication connection package grant is invalid.");
    }
    normalizedGrants[provider] = grant.trim();
  }
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1_000);
  const iat = payload.iat;
  const exp = payload.exp;
  if (
    payload.version !== 1
    || payload.state !== expected.state
    || exactBrowserHubOrigin(String(payload.hubUrl ?? "")) !== exactBrowserHubOrigin(expected.hubUrl)
    || !Number.isInteger(iat)
    || !Number.isInteger(exp)
    || (iat as number) > now + 30
    || (iat as number) < now - PACKAGE_TTL_SECONDS
    || (exp as number) <= now
    || (exp as number) <= (iat as number)
    || (exp as number) - (iat as number) > PACKAGE_TTL_SECONDS
  ) throw new Error("Authentication connection package has expired or does not match this request.");
  return {
    version: 1,
    hubUrl: exactBrowserHubOrigin(expected.hubUrl),
    grants: normalizedGrants,
  };
}

export async function runAuthConnectApproval(
  hubUrl: string,
  providers: AuthConnectProvider[],
): Promise<AuthConnectApproval> {
  const normalizedHubUrl = exactBrowserHubOrigin(hubUrl);
  return runBrowserLoopback({
    hubUrl: normalizedHubUrl,
    callbackPath: CALLBACK_PATH,
    callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
    maxBodyBytes: MAX_BODY_BYTES,
    messages: {
      bodyTooLarge: "Authentication callback body is too large.",
      bodyEmpty: "Authentication callback body is empty.",
      bodyInvalid: "Authentication callback body is invalid.",
      alreadyConsumed: "Authentication callback was already consumed.",
      callbackFailed: "Authentication callback failed.",
      listenFailed: "Failed to start the local authentication callback server.",
      timeout: "Browser approval timed out after 5 minutes.",
      cancelled: "Subscription connection cancelled.",
      opening: () => "[tiller] Opening your browser for one Tiller owner approval.\n",
      browserFallback: "[tiller] Could not open a browser automatically. Open this URL manually:\n",
      manualPrompt: "[tiller] If the browser is on another machine, paste its connection code here.\n",
      manualRetry: (error) => `[tiller] ${error} Try the full code again.\n`,
    },
    buildBrowserUrl: ({ hubUrl: origin, port, state, encodedPublicKey }) => (
      buildAuthConnectSettingsUrl(origin, port, state, encodedPublicKey, providers)
    ),
    decodeCallbackBody: async (value, context) => {
      if (
        !value
        || typeof value !== "object"
        || Array.isArray(value)
        || Object.keys(value).join(",") !== "envelope"
        || typeof (value as { envelope?: unknown }).envelope !== "string"
      ) throw new Error("Authentication callback payload is invalid.");
      return decryptAuthConnectEnvelope(
        (value as { envelope: string }).envelope,
        context.privateKey,
        { state: context.state, hubUrl: context.hubUrl, providers },
      );
    },
    decodeManualCode: (code, context) => decryptAuthConnectEnvelope(
      code,
      context.privateKey,
      { state: context.state, hubUrl: context.hubUrl, providers },
    ),
  });
}
