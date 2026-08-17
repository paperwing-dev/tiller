import { describe, expect, it } from "vitest";
import { parseManagedLocalRunnerImageSourceId } from "./managed-runner-image.js";
import { parseRunnerSessionSignature, runnerSessionSignature } from "./local-stack.js";

describe("local stack runtime image reporting", () => {
  it("extracts source ids only from canonical SHA-pinned managed sandbox images", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";

    expect(parseManagedLocalRunnerImageSourceId(`docker.io/jamieatlason/tiller-sandbox:${sha}`)).toBe(sha);
    expect(parseManagedLocalRunnerImageSourceId("docker.io/jamieatlason/tiller-sandbox:stable")).toBeNull();
    expect(parseManagedLocalRunnerImageSourceId(`jamieatlason/tiller-sandbox:${sha}`)).toBeNull();
    expect(parseManagedLocalRunnerImageSourceId(`ghcr.io/example/tiller-sandbox:${sha}`)).toBeNull();
  });

  it("includes runner, Codex runtime-auth, and reviewer-isolation protocols in registration signatures", () => {
    const current = runnerSessionSignature(
      "machine-1",
      "sandbox-image",
      null,
      1,
      1,
      1,
    );
    const legacy = runnerSessionSignature(
      "machine-1",
      "sandbox-image",
      null,
      null,
      null,
      null,
    );

    expect(JSON.parse(current)).toMatchObject({
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      reviewerIsolationProtocol: 1,
    });
    expect(JSON.parse(legacy)).not.toHaveProperty("runnerCommandProtocol");
    expect(JSON.parse(legacy)).not.toHaveProperty("codexRuntimeAuthProtocol");
    expect(JSON.parse(legacy)).not.toHaveProperty("reviewerIsolationProtocol");
    const parsedLegacy = parseRunnerSessionSignature({
      id: "machine-1",
      runner_state_version: 1,
      runner_state: JSON.stringify({
        host: {
          machineId: "machine-1",
          localRunnerImage: "sandbox-image",
        },
      }),
    });
    expect(parsedLegacy).not.toBe(legacy);
    expect(JSON.parse(parsedLegacy!)).toMatchObject({
      dockerAvailable: false,
      runnerAvailable: false,
    });
    expect(current).not.toBe(legacy);
  });
});
