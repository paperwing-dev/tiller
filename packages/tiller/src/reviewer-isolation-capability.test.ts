import { describe, expect, it, vi } from "vitest";
import { resolveHostReviewerIsolationProtocol } from "./reviewer-isolation-capability.js";

describe("host reviewer isolation capability", () => {
  it("fails closed unless immutable image identity and image label agree", () => {
    const inspectLabel = vi.fn(() => "1");
    expect(resolveHostReviewerIsolationProtocol("sandbox:stable", null, {
      inspectLabel,
    })).toBeNull();
    expect(resolveHostReviewerIsolationProtocol("sandbox@sha256:abc", "sha256:abc", {
      inspectLabel: () => "0",
    })).toBeNull();
    expect(resolveHostReviewerIsolationProtocol("sandbox@sha256:abc", "sha256:abc", {
      inspectLabel,
    })).toBe(1);
    expect(inspectLabel).toHaveBeenCalledTimes(1);
  });
});
