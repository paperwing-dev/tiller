import { describe, expect, it } from "vitest";
import { CompactEncrypt, generateKeyPair } from "jose";
import {
  decryptBrowserConnectEnvelope,
  decodeBrowserBootstrapCode,
  encodeBrowserBootstrapCode,
} from "./browser-bootstrap.js";

const CONTROL_SECRET = "0123456789abcdef0123456789abcdef0123456789A"; // gitleaks:allow -- inert fixture secret

async function encryptedEnvelope(
  publicKey: CryptoKey,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const now = 1_800_000_000;
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
    hubUrl: "https://demo.preview.workers.dev",
    clientId: "client-id.access",
    clientSecret: "client-secret",
    controlSecret: CONTROL_SECRET,
    tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    state: "expected-state",
    iat: now,
    exp: now + 300,
    ...overrides,
  })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "tiller-connect+jwe" })
    .encrypt(publicKey);
}

describe("browser bootstrap connection codes", () => {
  it("rejects plaintext protected hub bootstrap payloads", () => {
    const code = Buffer.from(JSON.stringify({
      state: "test-state",
      hubUrl: "https://tiller.example.com",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
    }), "utf8").toString("base64url");

    expect(() => decodeBrowserBootstrapCode(code, "test-state")).toThrow(/invalid|unsupported/i);
  });

  it("accepts pasted codes with whitespace", () => {
    const code = encodeBrowserBootstrapCode({
      state: "state-2",
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "public",
    });

    const splitCode = `${code.slice(0, 12)}\n${code.slice(12)}`;

    expect(decodeBrowserBootstrapCode(splitCode, "state-2")).toEqual({
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "public",
    });
  });

  it("rejects state mismatches", () => {
    const code = encodeBrowserBootstrapCode({
      state: "good-state",
      hubUrl: "https://tiller.example.com",
      protectionMode: "public",
    });

    expect(() => decodeBrowserBootstrapCode(code, "wrong-state")).toThrow(
      "Bootstrap callback state did not match.",
    );
  });
});

describe("encrypted browser connection packages", () => {
  it("decrypts only for the CLI key, state, Hub, and validity window", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const envelope = await encryptedEnvelope(publicKey as CryptoKey);
    expect(envelope).not.toContain("client-secret");
    await expect(decryptBrowserConnectEnvelope(
      envelope,
      privateKey as CryptoKey,
      {
        state: "expected-state",
        hubUrl: "https://demo.preview.workers.dev",
        nowSeconds: 1_800_000_000,
      },
    )).resolves.toEqual({
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: CONTROL_SECRET,
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });
  });

  it("rejects state, Hub URL, and expiry mismatches", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const envelope = await encryptedEnvelope(publicKey as CryptoKey);
    await expect(decryptBrowserConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "wrong",
      hubUrl: "https://demo.preview.workers.dev",
      nowSeconds: 1_800_000_000,
    })).rejects.toThrow(/state/i);
    await expect(decryptBrowserConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://other.preview.workers.dev",
      nowSeconds: 1_800_000_000,
    })).rejects.toThrow(/Hub URL/i);
    await expect(decryptBrowserConnectEnvelope(envelope, privateKey as CryptoKey, {
      state: "expected-state",
      hubUrl: "https://demo.preview.workers.dev",
      nowSeconds: 1_800_000_301,
    })).rejects.toThrow(/expired/i);
  });
});
