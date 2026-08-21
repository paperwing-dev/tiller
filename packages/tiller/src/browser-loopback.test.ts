import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  browserLaunchCommand,
  exactBrowserHubOrigin,
  runBrowserLoopback,
  type BrowserLoopbackOptions,
} from "./browser-loopback.js";

function options(
  overrides: Partial<BrowserLoopbackOptions<string>> = {},
): BrowserLoopbackOptions<string> {
  return {
    hubUrl: "https://hub.example.com",
    callbackPath: "/test-callback",
    callbackTimeoutMs: 1_000,
    maxBodyBytes: 128,
    messages: {
      bodyTooLarge: "too large",
      bodyEmpty: "empty",
      bodyInvalid: "invalid JSON",
      alreadyConsumed: "already consumed",
      callbackFailed: "callback failed",
      listenFailed: "listen failed",
      timeout: "timed out",
      cancelled: "cancelled",
      opening: (hubUrl) => `opening ${hubUrl}\n`,
      browserFallback: "open manually\n",
      manualPrompt: "paste code\n",
      manualRetry: (error) => `${error}; retry\n`,
    },
    buildBrowserUrl: ({ hubUrl, port, state, encodedPublicKey }) => (
      `${hubUrl}/browser-flow?port=${port}&state=${encodeURIComponent(state)}&key=${encodeURIComponent(encodedPublicKey)}`
    ),
    decodeCallbackBody: (value, context) => {
      if (
        !value
        || typeof value !== "object"
        || (value as { state?: unknown }).state !== context.state
      ) throw new Error("state mismatch");
      return "approved";
    },
    decodeManualCode: (code) => code,
    ...overrides,
  };
}

describe("browser loopback transport", () => {
  it("passes complete multi-parameter URLs directly to the Windows protocol handler", () => {
    const url = "https://hub.example.com/flow?port=1234&state=state-value&key=public-key&providers=codex,claude";
    expect(browserLaunchCommand("win32", url)).toEqual({
      cmd: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("requires an exact HTTP(S) Hub origin", () => {
    expect(exactBrowserHubOrigin(" https://hub.example.com/ ")).toBe("https://hub.example.com");
    expect(() => exactBrowserHubOrigin("https://hub.example.com/path")).toThrow(/exact/i);
    expect(() => exactBrowserHubOrigin("https://user@hub.example.com")).toThrow(/exact/i);
    expect(() => exactBrowserHubOrigin("file:///tmp/hub")).toThrow(/exact/i);
  });

  it("enforces CORS and body bounds, exposes a P-256 key, and closes after one result", async () => {
    const stderr: string[] = [];
    let callbackUrl = "";
    let callbackWork: Promise<void> | undefined;

    const result = await runBrowserLoopback(options(), {
      interactive: false,
      writeStderr: (message) => stderr.push(message),
      openBrowser: async (browserUrl) => {
        const parsed = new URL(browserUrl);
        const port = parsed.searchParams.get("port");
        const state = parsed.searchParams.get("state");
        const encodedKey = parsed.searchParams.get("key");
        expect(parsed.origin).toBe("https://hub.example.com");
        expect(parsed.pathname).toBe("/browser-flow");
        expect(port).toMatch(/^\d+$/);
        expect(state).toMatch(/^[0-9a-f-]{36}$/i);
        const jwk = JSON.parse(Buffer.from(encodedKey ?? "", "base64url").toString("utf8")) as JsonWebKey;
        expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });

        callbackUrl = `http://127.0.0.1:${port}/test-callback`;
        callbackWork = (async () => {
          const rejectedPreflight = await fetch(callbackUrl, {
            method: "OPTIONS",
            headers: {
              Origin: "https://attacker.example.com",
              "Access-Control-Request-Method": "POST",
            },
          });
          expect(rejectedPreflight.status).toBe(403);
          expect(rejectedPreflight.headers.get("access-control-allow-origin")).toBeNull();

          const acceptedPreflight = await fetch(callbackUrl, {
            method: "OPTIONS",
            headers: {
              Origin: "https://hub.example.com",
              "Access-Control-Request-Method": "POST",
            },
          });
          expect(acceptedPreflight.status).toBe(204);
          expect(acceptedPreflight.headers.get("access-control-allow-origin"))
            .toBe("https://hub.example.com");

          const oversized = await fetch(callbackUrl, {
            method: "POST",
            headers: { Origin: "https://hub.example.com", "Content-Type": "application/json" },
            body: JSON.stringify({ value: "x".repeat(256) }),
          });
          expect(oversized.status).toBe(400);
          await expect(oversized.json()).resolves.toEqual({ error: "too large" });

          const accepted = await fetch(callbackUrl, {
            method: "POST",
            headers: { Origin: "https://hub.example.com", "Content-Type": "application/json" },
            body: JSON.stringify({ state }),
          });
          expect(accepted.status).toBe(200);
          await expect(accepted.json()).resolves.toEqual({ ok: true });
        })();
        return false;
      },
    });

    await callbackWork;
    expect(result).toBe("approved");
    expect(stderr.join(""))
      .toContain("open manually\nhttps://hub.example.com/browser-flow?");
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it("times out and deterministically closes the listener", async () => {
    let callbackUrl = "";
    await expect(runBrowserLoopback(options({ callbackTimeoutMs: 10 }), {
      interactive: false,
      writeStderr: () => undefined,
      openBrowser: async (browserUrl) => {
        const parsed = new URL(browserUrl);
        callbackUrl = `http://127.0.0.1:${parsed.searchParams.get("port")}/test-callback`;
        return await new Promise<boolean>(() => undefined);
      },
    })).rejects.toThrow("timed out");

    await expect(fetch(callbackUrl)).rejects.toThrow();
  });

  it("accepts a callback even when the browser launcher never settles", async () => {
    let callbackWork: Promise<Response> | undefined;
    const result = await runBrowserLoopback(options(), {
      interactive: false,
      writeStderr: () => undefined,
      openBrowser: async (browserUrl) => {
        const parsed = new URL(browserUrl);
        callbackWork = fetch(
          `http://127.0.0.1:${parsed.searchParams.get("port")}/test-callback`,
          {
            method: "POST",
            headers: {
              Origin: "https://hub.example.com",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ state: parsed.searchParams.get("state") }),
          },
        );
        return await new Promise<boolean>(() => undefined);
      },
    });

    expect(result).toBe("approved");
    await expect(callbackWork).resolves.toMatchObject({ status: 200 });
  });

  it("prints the fallback URL when an asynchronously launched browser fails", async () => {
    const stderr: string[] = [];
    await expect(runBrowserLoopback(options({ callbackTimeoutMs: 30 }), {
      interactive: false,
      writeStderr: (message) => stderr.push(message),
      openBrowser: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return false;
      },
    })).rejects.toThrow("timed out");

    expect(stderr.join(""))
      .toContain("open manually\nhttps://hub.example.com/browser-flow?");
  });

  it("cancels on SIGINT, closes the listener, and restores signal handlers", async () => {
    const signalSource = new EventEmitter();
    let callbackUrl = "";
    const connection = runBrowserLoopback(options(), {
      interactive: false,
      signalSource: signalSource as Pick<NodeJS.Process, "once" | "off">,
      writeStderr: () => undefined,
      openBrowser: async (browserUrl) => {
        const parsed = new URL(browserUrl);
        callbackUrl = `http://127.0.0.1:${parsed.searchParams.get("port")}/test-callback`;
        queueMicrotask(() => signalSource.emit("SIGINT"));
        return true;
      },
    });

    await expect(connection).rejects.toThrow("cancelled");
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    await expect(fetch(callbackUrl)).rejects.toThrow();
  });
});
