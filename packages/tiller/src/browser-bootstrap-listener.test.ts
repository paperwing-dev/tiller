import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import { CompactEncrypt, importJWK } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { runBrowserBootstrap } from "./browser-bootstrap.js";

const CONTROL_SECRET = "0123456789abcdef0123456789abcdef0123456789A"; // gitleaks:allow -- inert fixture secret

async function waitForBootstrapUrl(output: () => string): Promise<URL> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = output().match(/https:\/\/demo\.preview\.workers\.dev\/cli\/bootstrap\?[^\s]+/);
    if (match) return new URL(match[0]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("CLI bootstrap URL was not written.");
}

async function encryptedEnvelope(url: URL): Promise<string> {
  const state = url.searchParams.get("state");
  const encodedKey = url.searchParams.get("key");
  if (!state || !encodedKey) throw new Error("Bootstrap URL is incomplete.");
  const publicKeyJwk = JSON.parse(
    Buffer.from(encodedKey, "base64url").toString("utf8"),
  ) as JsonWebKey;
  const publicKey = await importJWK(publicKeyJwk, "ECDH-ES");
  const now = Math.floor(Date.now() / 1_000);
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify({
    hubUrl: "https://demo.preview.workers.dev",
    clientId: "client-id.access",
    clientSecret: "client-secret",
    controlSecret: CONTROL_SECRET,
    tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    state,
    iat: now,
    exp: now + 300,
  })))
    .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "tiller-connect+jwe" })
    .encrypt(publicKey);
}

describe("browser bootstrap loopback listener", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushes the accepted response and closes an extra idle browser connection", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    });
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);

    const resultPromise = runBrowserBootstrap("https://demo.preview.workers.dev");
    const bootstrapUrl = await waitForBootstrapUrl(() => stderr);
    const port = Number(bootstrapUrl.searchParams.get("port"));
    expect(Number.isInteger(port) && port > 0).toBe(true);

    const idleSocket = connect(port, "127.0.0.1");
    await once(idleSocket, "connect");
    const idleSocketClosed = once(idleSocket, "close");

    const invalid = await fetch(`http://127.0.0.1:${port}/wrong`, {
      headers: { Origin: "https://demo.preview.workers.dev" },
    });
    expect(invalid.status).toBe(404);

    const envelope = await encryptedEnvelope(bootstrapUrl);
    const accepted = await fetch(`http://127.0.0.1:${port}/bootstrap-callback`, {
      method: "POST",
      headers: {
        Origin: "https://demo.preview.workers.dev",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ envelope }),
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ ok: true });
    await expect(resultPromise).resolves.toEqual({
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: CONTROL_SECRET,
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });
    await idleSocketClosed;
    expect(idleSocket.destroyed).toBe(true);
  }, 10_000);
});
