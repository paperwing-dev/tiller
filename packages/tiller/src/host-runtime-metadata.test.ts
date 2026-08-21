import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchHostUpdateCheck,
  resolveHostUpdateTargetImage,
} from "./host-runtime-metadata.js";

const DIGEST = "1".repeat(64);
const IMAGE = `docker.io/jamieatlason/tiller-sandbox@sha256:${DIGEST}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("execution-machine runtime metadata", () => {
  it("pins the exact Hub-advertised runtime image", () => {
    expect(resolveHostUpdateTargetImage({
      schemaVersion: 1,
      channel: "release",
      hubVersion: "0.2.54",
      releaseId: "a".repeat(40),
      selfHostRuntimeImage: IMAGE,
    })).toBe(IMAGE);
  });

  it("rejects mismatched Hub runtime metadata", () => {
    expect(() => resolveHostUpdateTargetImage({
      schemaVersion: 1,
      channel: "release",
      hubVersion: "0.2.54",
      selfHostRuntimeImage: "docker.io/jamieatlason/tiller-sandbox:stable",
    })).toThrow("sha256");
  });

  it.each([
    new Response("forbidden", {
      status: 403,
      headers: { "Content-Type": "text/plain" },
    }),
    new Response("<html>Cloudflare Access</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }),
  ])("fails invalid noninteractive credentials with setup instructions", async (response) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(fetchHostUpdateCheck(
      "https://demo.preview.workers.dev",
      {
        "CF-Access-Client-Id": "stale-id",
        "CF-Access-Client-Secret": "stale-secret",
      },
    )).rejects.toThrow(
      "tiller host setup --hub-url https://<exact-host>.workers.dev",
    );
  });
});
