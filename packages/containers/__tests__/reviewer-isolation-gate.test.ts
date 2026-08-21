import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

describe("reviewer isolation image gate", () => {
  it("defaults new images to disabled and exposes image-originated capability evidence", () => {
    const dockerfile = readFileSync(path.resolve(import.meta.dirname, "..", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG TILLER_REVIEWER_ISOLATION_PROTOCOL=0");
    expect(dockerfile).toContain('LABEL dev.tiller.reviewer-isolation-protocol="$TILLER_REVIEWER_ISOLATION_PROTOCOL"');
    expect(dockerfile).toContain("/etc/tiller-reviewer-isolation-protocol");
  });

  it("enables and verifies reviewer isolation in both managed image builds", () => {
    const workflow = readFileSync(
      path.join(repoRoot, ".github", "workflows", "container-image.yml"),
      "utf8",
    );
    expect(workflow.match(/^\s+TILLER_REVIEWER_ISOLATION_PROTOCOL=1$/gm)).toHaveLength(2);
    expect(workflow.match(/cat \/etc\/tiller-reviewer-isolation-protocol/g)).toHaveLength(2);
    expect(workflow.match(/dev\.tiller\.reviewer-isolation-protocol/g)).toHaveLength(2);
    expect(workflow.match(/TILLER_BOOTSTRAP_MODE=planner-run/g)).toHaveLength(2);
    expect(workflow.match(/reviewer-entrypoint-smoke\.mjs:\/usr\/local\/bin\/tiller-planner:ro/g)).toHaveLength(2);
    expect(workflow.match(/for reviewer_harness in claude-code codex opencode/g)).toHaveLength(2);
    expect(workflow.match(/TILLER_HARNESS="\$reviewer_harness"/g)).toHaveLength(2);
    expect(workflow.match(/timeout-minutes: 10/g)).toHaveLength(2);
    expect(workflow.match(/Smoke testing reviewer entrypoint:/g)).toHaveLength(2);

    const smoke = readFileSync(
      path.join(repoRoot, "packages", "containers", "reviewer-entrypoint-smoke.mjs"),
      "utf8",
    );
    expect(smoke).toContain("process.umask(0o077)");
    expect(smoke).toContain("unrelated configured parent");
    expect(smoke).toContain('harness: "claude-code"');
    expect(smoke).toContain('harness: "codex"');
    expect(smoke).toContain('harness: "opencode"');
    expect(smoke).toContain('"app-server"');
    expect(smoke.match(/timeout: subprocessTimeoutMs/g)).toHaveLength(2);
  });
});
