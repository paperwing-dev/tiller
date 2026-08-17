import { afterEach, describe, expect, it, vi } from "vitest";
import { readSetupStatusWithValidatedCredential } from "./host-auth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("noninteractive host credential validation", () => {
  it("fails a definitive Access rejection with host setup instructions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    await expect(readSetupStatusWithValidatedCredential(
      "https://demo.preview.workers.dev",
      {
        "CF-Access-Client-Id": "stale-id",
        "CF-Access-Client-Secret": "stale-secret",
      },
    )).rejects.toThrow(
      "tiller host setup --hub-url https://<exact-host>.workers.dev",
    );
  });

  it("does not misclassify a transient network failure as invalid credentials", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network offline"));

    await expect(readSetupStatusWithValidatedCredential(
      "https://demo.preview.workers.dev",
      {
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      },
    )).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("reads localhost setup status without requiring Access credentials", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        enabledHarnesses: ["codex"],
        hasChatGPTAuth: false,
        hasOpenAIKey: true,
        hostRegistered: false,
        hostConnected: false,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(readSetupStatusWithValidatedCredential(
      "http://127.0.0.1:8787",
      {},
    )).resolves.toMatchObject({
      enabledHarnesses: ["codex"],
      hasOpenAIKey: true,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
