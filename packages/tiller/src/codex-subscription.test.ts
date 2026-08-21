import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchHubSetupStatus,
  HubSetupStatusError,
  isHubSetupStatusAuthError,
} from "./codex-subscription.js";

describe("fetchHubSetupStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a Cloudflare Access HTML response as an auth refresh problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<!DOCTYPE html><html><title>Sign in ・ Cloudflare Access</title></html>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        }),
      ),
    );

    await expect(fetchHubSetupStatus("https://tiller.example.com")).rejects.toMatchObject({
      name: "HubSetupStatusError",
      code: "auth-required",
    } satisfies Partial<HubSetupStatusError>);
  });

  it("recognizes auth-refresh errors", () => {
    expect(isHubSetupStatusAuthError(new HubSetupStatusError("auth-required", "refresh me"))).toBe(true);
    expect(isHubSetupStatusAuthError(new HubSetupStatusError("invalid-response", "bad json"))).toBe(false);
    expect(isHubSetupStatusAuthError(new Error("nope"))).toBe(false);
  });
});
