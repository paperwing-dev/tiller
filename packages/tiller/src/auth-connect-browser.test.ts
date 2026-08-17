import { describe, expect, it } from "vitest";
import { CompactEncrypt, generateKeyPair } from "jose";
import {
  buildAuthConnectSettingsUrl,
  decryptAuthConnectEnvelope,
  type AuthConnectPackageV1,
} from "./auth-connect-browser.js";

const NOW = 1_800_000_000;

async function encryptedPackage(
  publicKey: CryptoKey,
  overrides: Partial<AuthConnectPackageV1> & Record<string, unknown> = {},
): Promise<string> {
  const value: AuthConnectPackageV1 & Record<string, unknown> = {
    version: 1,
    hubUrl: "https://demo.preview.workers.dev",
    state: "expected-state",
    iat: NOW,
    exp: NOW + 300,
    grants: { codex: "codex-grant", claude: "claude-grant" },
    ...overrides,
  };
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "tiller-auth-connect+jwe" })
    .encrypt(publicKey);
}

describe("encrypted subscription connection packages", () => {
  it("opens the owner handoff inside Tiller Settings", () => {
    expect(buildAuthConnectSettingsUrl(
      "https://demo.preview.workers.dev",
      1455,
      "state with spaces",
      "public/key+value",
      ["codex", "claude"],
    )).toBe(
      "https://demo.preview.workers.dev/settings?auth_connect=1&port=1455&state=state%20with%20spaces&key=public%2Fkey%2Bvalue&providers=codex%2Cclaude",
    );
  });

  it("accepts only the CLI key, requested providers, state, Hub, and validity window", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const envelope = await encryptedPackage(publicKey as CryptoKey);

    expect(envelope).not.toContain("codex-grant");
    await expect(decryptAuthConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://demo.preview.workers.dev",
      providers: ["codex", "claude"],
      nowSeconds: NOW,
    })).resolves.toEqual({
      version: 1,
      hubUrl: "https://demo.preview.workers.dev",
      grants: { codex: "codex-grant", claude: "claude-grant" },
    });
  });

  it("rejects state, provider scope, expiry, and unexpected fields", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const envelope = await encryptedPackage(publicKey as CryptoKey);

    await expect(decryptAuthConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "wrong-state",
      hubUrl: "https://demo.preview.workers.dev",
      providers: ["codex", "claude"],
      nowSeconds: NOW,
    })).rejects.toThrow(/expired|match/i);
    await expect(decryptAuthConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://demo.preview.workers.dev",
      providers: ["codex"],
      nowSeconds: NOW,
    })).rejects.toThrow(/providers/i);
    await expect(decryptAuthConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://demo.preview.workers.dev",
      providers: ["codex", "claude"],
      nowSeconds: NOW + 301,
    })).rejects.toThrow(/expired/i);

    const extraField = await encryptedPackage(publicKey as CryptoKey, { unexpected: true });
    await expect(decryptAuthConnectEnvelope(extraField, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://demo.preview.workers.dev",
      providers: ["codex", "claude"],
      nowSeconds: NOW,
    })).rejects.toThrow(/invalid/i);
  });
});
