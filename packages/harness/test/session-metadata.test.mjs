import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionMetadata } from "../dist/session-metadata.js";

test("buildSessionMetadata uses REPO_SLUG as the env slug source", () => {
  const metadata = buildSessionMetadata({
    cwd: "/workspace/repo",
    host: "host-1",
    platform: "darwin",
    harness: "codex",
    repoSlug: "demo-env",
    backend: "host",
    runnerId: "runner-1",
    repoUrl: "https://github.com/example/repo",
  });

  assert.equal(metadata.envSlug, "demo-env");
  assert.equal(metadata.backend, "host");
  assert.equal(metadata.runnerId, "runner-1");
});
