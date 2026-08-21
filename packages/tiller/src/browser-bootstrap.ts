import { compactDecrypt } from "jose";
import {
  exactBrowserHubOrigin,
  normalizeBrowserConnectionCode,
  runBrowserLoopback,
  type BrowserLoopbackContext,
} from "./browser-loopback.js";

const CALLBACK_PATH = "/bootstrap-callback";
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY_BYTES = 16 * 1_024;
const CONNECT_ENVELOPE_TTL_SECONDS = 5 * 60;

export interface BrowserBootstrapPublicConfig {
  hubUrl: string;
  protectionMode: "public";
}

export interface BrowserBootstrapProtectedConfig {
  hubUrl: string;
  protectionMode: "cf-access";
  clientId: string;
  clientSecret: string;
  controlSecret: string;
  tokenExpiresAt?: string;
}

export type BrowserBootstrapResult =
  | BrowserBootstrapPublicConfig
  | BrowserBootstrapProtectedConfig;

type BrowserBootstrapPayload = BrowserBootstrapPublicConfig & { state: string };

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseBootstrapPayload(value: unknown, expectedState: string): BrowserBootstrapPublicConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bootstrap callback payload must be an object.");
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = ["hubUrl", "protectionMode", "state"];
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Bootstrap callback payload is invalid.");
  }
  const state = typeof payload.state === "string" ? payload.state.trim() : "";
  if (!state || state !== expectedState) throw new Error("Bootstrap callback state did not match.");
  const hubUrl = typeof payload.hubUrl === "string" ? normalizeUrl(payload.hubUrl) : "";
  if (!hubUrl) throw new Error("Bootstrap callback did not include a hub URL.");
  if (payload.protectionMode === "public") return { hubUrl, protectionMode: "public" };
  throw new Error("Bootstrap callback returned an unsupported protection mode.");
}

export function encodeBrowserBootstrapCode(payload: BrowserBootstrapPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeBrowserBootstrapCode(
  value: string,
  expectedState: string,
): BrowserBootstrapPublicConfig {
  const code = normalizeBrowserConnectionCode(value);
  if (!code) throw new Error("Connection code is empty.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {
    throw new Error("Connection code is not valid.");
  }
  return parseBootstrapPayload(decoded, expectedState);
}

export async function decryptBrowserConnectEnvelope(
  envelopeInput: string,
  privateKey: CryptoKey,
  expected: { state: string; hubUrl: string; nowSeconds?: number },
): Promise<BrowserBootstrapProtectedConfig> {
  const envelope = normalizeBrowserConnectionCode(envelopeInput);
  if (envelope.split(".").length !== 5) throw new Error("Connection code is not a valid encrypted package.");
  let decrypted;
  try {
    decrypted = await compactDecrypt(envelope, privateKey);
  } catch {
    throw new Error("Connection code could not be decrypted by this Tiller process.");
  }
  if (
    decrypted.protectedHeader.alg !== "ECDH-ES"
    || decrypted.protectedHeader.enc !== "A256GCM"
    || decrypted.protectedHeader.typ !== "tiller-connect+jwe"
  ) {
    throw new Error("Connection code used an unsupported encryption format.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(decrypted.plaintext)) as unknown;
  } catch {
    throw new Error("Connection package payload is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Connection package payload is invalid.");
  }
  const payload = value as Record<string, unknown>;
  const expectedKeys = ["clientId", "clientSecret", "controlSecret", "exp", "hubUrl", "iat", "state", "tokenExpiresAt"];
  const actualKeys = Object.keys(payload).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Connection package payload is invalid.");
  }
  const state = typeof payload.state === "string" ? payload.state : "";
  const hubUrl = typeof payload.hubUrl === "string" ? normalizeUrl(payload.hubUrl) : "";
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  const clientSecret = typeof payload.clientSecret === "string" ? payload.clientSecret.trim() : "";
  const controlSecret = typeof payload.controlSecret === "string" ? payload.controlSecret.trim() : "";
  const tokenExpiresAt = typeof payload.tokenExpiresAt === "string" ? payload.tokenExpiresAt.trim() : "";
  const iat = payload.iat;
  const exp = payload.exp;
  const now = expected.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (state !== expected.state) throw new Error("Connection package state did not match.");
  if (hubUrl !== exactBrowserHubOrigin(expected.hubUrl)) throw new Error("Connection package Hub URL did not match.");
  if (!clientId || !clientSecret || !/^[A-Za-z0-9_-]{43}$/.test(controlSecret) || !Number.isFinite(Date.parse(tokenExpiresAt))) {
    throw new Error("Connection package credentials are incomplete.");
  }
  if (
    !Number.isInteger(iat)
    || !Number.isInteger(exp)
    || (iat as number) > now + 30
    || (iat as number) < now - CONNECT_ENVELOPE_TTL_SECONDS
    || (exp as number) <= now
    || (exp as number) <= (iat as number)
    || (exp as number) - (iat as number) > CONNECT_ENVELOPE_TTL_SECONDS
  ) {
    throw new Error("Connection package has expired or has invalid timestamps.");
  }
  return {
    hubUrl,
    protectionMode: "cf-access",
    clientId,
    clientSecret,
    controlSecret,
    tokenExpiresAt,
  };
}

export async function runBrowserBootstrap(hubUrl: string): Promise<BrowserBootstrapResult> {
  const normalizedHubUrl = exactBrowserHubOrigin(normalizeUrl(hubUrl));
  const decodeConnectionCode = async (
    codeInput: string,
    context: BrowserLoopbackContext,
  ): Promise<BrowserBootstrapResult> => {
    const code = normalizeBrowserConnectionCode(codeInput);
    if (code.split(".").length === 5) {
      return decryptBrowserConnectEnvelope(code, context.privateKey, {
        state: context.state,
        hubUrl: context.hubUrl,
      });
    }
    const publicResult = decodeBrowserBootstrapCode(code, context.state);
    if (exactBrowserHubOrigin(publicResult.hubUrl) !== context.hubUrl) {
      throw new Error("Bootstrap callback Hub URL did not match.");
    }
    return publicResult;
  };
  return runBrowserLoopback({
    hubUrl: normalizedHubUrl,
    callbackPath: CALLBACK_PATH,
    callbackTimeoutMs: CALLBACK_TIMEOUT_MS,
    maxBodyBytes: MAX_BODY_BYTES,
    messages: {
      bodyTooLarge: "Bootstrap callback body is too large.",
      bodyEmpty: "Bootstrap callback body is empty.",
      bodyInvalid: "Bootstrap callback body is not valid JSON.",
      alreadyConsumed: "Bootstrap callback was already consumed.",
      callbackFailed: "Bootstrap callback failed.",
      listenFailed: "[tiller] Failed to start the local browser callback server.",
      timeout: "[tiller] Browser sign-in timed out after 5 minutes. Keep the browser open, confirm the Hub is reachable, then run `tiller` again.",
      cancelled: "[tiller] Browser sign-in cancelled.",
      opening: (origin) => `[tiller] Opening your browser to connect tiller to ${origin}\n`,
      browserFallback: "[tiller] Could not open a browser automatically. Open this URL manually:\n",
      manualPrompt: "[tiller] If the browser is on another machine, paste the connection code shown there.\n",
      manualRetry: (error) => `[tiller] ${error} Paste the full connection code and try again.\n`,
    },
    buildBrowserUrl: ({ hubUrl: origin, port, state, encodedPublicKey }) => (
      `${origin}/cli/bootstrap?port=${port}&state=${encodeURIComponent(state)}&key=${encodeURIComponent(encodedPublicKey)}`
    ),
    decodeCallbackBody: async (value, context) => {
      if (
        value
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).join(",") === "envelope"
        && typeof (value as { envelope?: unknown }).envelope === "string"
      ) {
        return decryptBrowserConnectEnvelope(
          (value as { envelope: string }).envelope,
          context.privateKey,
          { state: context.state, hubUrl: context.hubUrl },
        );
      }
      const result = parseBootstrapPayload(value, context.state);
      if (exactBrowserHubOrigin(result.hubUrl) !== context.hubUrl) {
        throw new Error("Bootstrap callback Hub URL did not match.");
      }
      return result;
    },
    decodeManualCode: decodeConnectionCode,
  });
}
