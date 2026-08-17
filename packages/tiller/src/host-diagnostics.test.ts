import { describe, expect, it } from "vitest";
import type { HubSetupStatus } from "./codex-subscription.js";
import { collectHubHostChecks } from "./host-diagnostics.js";

function setupStatus(overrides: Partial<HubSetupStatus> = {}): HubSetupStatus {
  return {
    enabledHarnesses: ["codex"],
    hasChatGPTAuth: false,
    hasOpenAIKey: false,
    hostRegistered: true,
    hostConnected: true,
    ...overrides,
  };
}

describe("collectHubHostChecks", () => {
  it("reports a connected execution machine as healthy", () => {
    expect(collectHubHostChecks(setupStatus())).toEqual([
      expect.objectContaining({
        id: "hub-host-connection",
        level: "ok",
        detail: "connected",
      }),
    ]);
  });

  it("reports a registered but disconnected machine as failed", () => {
    const checks = collectHubHostChecks(
      setupStatus({
        hostConnected: false,
      }),
    );

    expect(checks).toEqual([
      expect.objectContaining({
        id: "hub-host-connection",
        level: "fail",
        detail: expect.stringContaining("live machine session disconnected"),
        fixHint: expect.stringContaining("restart"),
      }),
    ]);
  });

  it("reports a missing registration", () => {
    expect(
      collectHubHostChecks(
        setupStatus({
          hostRegistered: false,
          hostConnected: false,
        }),
      ),
    ).toEqual([
      expect.objectContaining({
        id: "hub-host-connection",
        level: "fail",
        detail: "no execution machine is registered with the Hub",
      }),
    ]);
  });
});
