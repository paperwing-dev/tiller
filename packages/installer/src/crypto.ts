import type { EncryptedAccessSecretV1, EncryptedTokenV1 } from "./types";

const TOKEN_MAX_LIFETIME_MS = 30 * 60 * 1_000;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytes;
}

export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function randomInstallationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let accumulator = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

export async function sha256Bytes(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : ownedBytes(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return [...await sha256Bytes(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256Bytes(verifier));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlDecode(secret.trim());
  } catch {
    throw new Error("Installer token encryption key is invalid");
  }
  if (bytes.byteLength !== 32) {
    throw new Error("Installer token encryption key must contain exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function sensitiveAad(
  purpose: "oauth-token" | "access-service-secret",
  jobId: string,
  expiresAt: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`tiller-installer-${purpose}:v1\0${jobId}\0${expiresAt}`);
}

async function encryptSensitiveValue(
  secret: string,
  value: string,
  args: {
    purpose: "oauth-token" | "access-service-secret";
    jobId: string;
    expiresAt: string;
  },
): Promise<EncryptedTokenV1> {
  const normalized = value.trim();
  if (!normalized) throw new Error("Sensitive value is empty");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: sensitiveAad(args.purpose, args.jobId, args.expiresAt),
    },
    await encryptionKey(secret),
    new TextEncoder().encode(normalized),
  );
  return {
    version: 1,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    expiresAt: args.expiresAt,
  };
}

async function decryptSensitiveValue(
  secret: string,
  encrypted: EncryptedTokenV1,
  args: {
    purpose: "oauth-token" | "access-service-secret";
    jobId: string;
    now?: number;
  },
): Promise<string> {
  const now = args.now ?? Date.now();
  if (encrypted.version !== 1 || now >= Date.parse(encrypted.expiresAt)) {
    throw new Error("Sensitive value expired");
  }
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlDecode(encrypted.iv),
        additionalData: sensitiveAad(
          args.purpose,
          args.jobId,
          encrypted.expiresAt,
        ),
      },
      await encryptionKey(secret),
      base64UrlDecode(encrypted.ciphertext),
    );
  } catch {
    throw new Error("Sensitive value could not be decrypted");
  }
  const value = new TextDecoder().decode(plaintext).trim();
  if (!value) throw new Error("Sensitive value is empty");
  return value;
}

export async function encryptOAuthToken(
  secret: string,
  token: string,
  args: { jobId: string; jobExpiresAt: string; now?: number },
): Promise<EncryptedTokenV1> {
  const now = args.now ?? Date.now();
  const expiresAtMs = Math.min(now + TOKEN_MAX_LIFETIME_MS, Date.parse(args.jobExpiresAt));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) throw new Error("OAuth token lifetime is invalid");
  const expiresAt = new Date(expiresAtMs).toISOString();
  return encryptSensitiveValue(secret, token, {
    purpose: "oauth-token",
    jobId: args.jobId,
    expiresAt,
  });
}

export async function decryptOAuthToken(
  secret: string,
  encrypted: EncryptedTokenV1,
  args: { jobId: string; now?: number },
): Promise<string> {
  try {
    return await decryptSensitiveValue(secret, encrypted, {
      purpose: "oauth-token",
      jobId: args.jobId,
      now: args.now,
    });
  } catch {
    throw new Error("OAuth authorization could not be decrypted");
  }
}

export async function encryptAccessServiceSecret(
  secret: string,
  value: string,
  args: { jobId: string; jobExpiresAt: string },
): Promise<EncryptedAccessSecretV1> {
  return encryptSensitiveValue(secret, value, {
    purpose: "access-service-secret",
    jobId: args.jobId,
    expiresAt: args.jobExpiresAt,
  });
}

export async function decryptAccessServiceSecret(
  secret: string,
  encrypted: EncryptedAccessSecretV1,
  args: { jobId: string; now?: number },
): Promise<string> {
  return decryptSensitiveValue(secret, encrypted, {
    purpose: "access-service-secret",
    jobId: args.jobId,
    now: args.now,
  });
}

export const TOKEN_LIFETIME_MS = TOKEN_MAX_LIFETIME_MS;
