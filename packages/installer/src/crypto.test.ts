import { describe, expect, it } from "vitest";
import {
  decryptAccessServiceSecret,
  decryptOAuthToken,
  encryptAccessServiceSecret,
  encryptOAuthToken,
  randomInstallationId,
  TOKEN_LIFETIME_MS,
} from "./crypto";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("short-lived installer secrets", () => {
  it("generates a 128-bit lowercase base32 installation ID", () => {
    const values = new Set(Array.from({ length: 100 }, () => randomInstallationId()));
    expect(values.size).toBe(100);
    for (const value of values) expect(value).toMatch(/^[a-z2-7]{26}$/);
  });

  it("binds OAuth ciphertext to one job for no more than thirty minutes", async () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const encrypted = await encryptOAuthToken(KEY, "oauth-secret", {
      jobId: "job-1",
      jobExpiresAt: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
      now,
    });
    expect(Date.parse(encrypted.expiresAt) - now).toBe(TOKEN_LIFETIME_MS);
    await expect(decryptOAuthToken(KEY, encrypted, { jobId: "job-1", now })).resolves.toBe("oauth-secret");
    await expect(decryptOAuthToken(KEY, encrypted, { jobId: "job-2", now })).rejects.toThrow();
    await expect(decryptOAuthToken(KEY, encrypted, {
      jobId: "job-1",
      now: now + TOKEN_LIFETIME_MS,
    })).rejects.toThrow();
  });

  it("retains the one-time Access secret only through the active job", async () => {
    const expiresAt = "2026-07-30T00:30:00.000Z";
    const encrypted = await encryptAccessServiceSecret(KEY, "access-secret", {
      jobId: "job-1",
      jobExpiresAt: expiresAt,
    });
    await expect(decryptAccessServiceSecret(KEY, encrypted, {
      jobId: "job-1",
      now: Date.parse(expiresAt) - 1,
    })).resolves.toBe("access-secret");
    await expect(decryptAccessServiceSecret(KEY, encrypted, {
      jobId: "job-1",
      now: Date.parse(expiresAt),
    })).rejects.toThrow();
  });
});
