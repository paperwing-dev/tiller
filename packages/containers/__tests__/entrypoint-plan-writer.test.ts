import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const containerDir = path.resolve(import.meta.dirname, "..");
const entrypoint = readFileSync(
  path.join(containerDir, "entrypoint.sh"),
  "utf8",
);
const dockerfileBase = readFileSync(
  path.join(containerDir, "Dockerfile.base"),
  "utf8",
);
const dockerfile = readFileSync(path.join(containerDir, "Dockerfile"), "utf8");
const codexReviewerContract = readFileSync(
  path.join(containerDir, "verify-codex-reviewer-contract.sh"),
  "utf8",
);
const harnessPackage = JSON.parse(
  readFileSync(
    path.resolve(containerDir, "..", "harness", "package.json"),
    "utf8",
  ),
) as { bin?: Record<string, string> };

describe("isolated Plan Writer bootstrap", () => {
  it("uses exact provider pins and an early dedicated entrypoint branch", () => {
    expect(dockerfileBase).toContain("@anthropic-ai/claude-code@2.1.224");
    expect(dockerfileBase).toContain("@openai/codex@0.147.0");
    expect(dockerfileBase).toContain(
      "git curl unzip ca-certificates tini zstd bubblewrap",
    );
    expect(dockerfileBase).toContain("bubblewrap strace");
    expect(dockerfileBase).toContain("bwrap --version");
    expect(dockerfileBase).toContain(
      "codex app-server generate-ts --experimental",
    );
    expect(dockerfileBase).toContain('"method": "thread/inject_items"');
    expect(dockerfileBase).toContain("collaborationMode?: CollaborationMode");
    expect(dockerfileBase).toContain("collaborationMode: CollaborationMode");
    expect(dockerfileBase).toContain('"method": "thread/settings/updated"');
    expect(dockerfileBase).toContain(
      'export type ThreadHistoryMode = "legacy" | "paginated";',
    );
    expect(dockerfileBase).toContain(
      '{ "type": "plan", id: string, text: string',
    );
    expect(dockerfileBase).toContain('"method": "account/read"');
    const branch = entrypoint.indexOf(
      'TILLER_BOOTSTRAP_MODE:-}" = "plan-writer"',
    );
    const normalCredentials = entrypoint.indexOf(
      "configure_github_credential_helper\n",
      branch,
    );
    const plannerRun = entrypoint.indexOf(
      'TILLER_BOOTSTRAP_MODE:-}" = "planner-run"',
    );
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(normalCredentials);
    expect(branch).toBeLessThan(plannerRun);
    expect(entrypoint.slice(branch, normalCredentials)).toContain(
      "exec tiller-plan-writer",
    );
  });

  it("bakes the managed Plan Writer executables into the shared sandbox image", () => {
    expect(dockerfile).toContain("npm install -g /tmp/tiller-harness.tgz");
    expect(harnessPackage.bin?.["tiller-codex-auth-helper"]).toBe(
      "dist/codex-auth-helper-cli.js",
    );
    expect(harnessPackage.bin?.["tiller-plan-writer-plans-mcp"]).toBe(
      "dist/plan-writer/plans-mcp.js",
    );
  });

  it("validates the one-shot reviewer environment protocol in base and final images", () => {
    expect(dockerfileBase).toContain(
      "bash /tmp/verify-codex-reviewer-contract.sh /tmp/tiller-codex-app-server-bindings",
    );
    expect(dockerfile).toContain("bash /tmp/verify-codex-reviewer-contract.sh");
    expect(codexReviewerContract).toContain('"method": "environment/info"');
    expect(codexReviewerContract).toContain("v2/EnvironmentInfoParams.ts");
    expect(codexReviewerContract).toContain("v2/EnvironmentInfoResponse.ts");
    expect(codexReviewerContract).toContain("v2/EnvironmentShellInfo.ts");
    expect(codexReviewerContract).toContain("v2/TurnEnvironmentParams.ts");
    expect(codexReviewerContract).toContain("v2/ThreadStartParams.ts");
    expect(codexReviewerContract).toContain("v2/TurnStartParams.ts");
    expect(codexReviewerContract).toContain("v2/ThreadItem.ts");
    expect(codexReviewerContract).toContain("v2/CommandAction.ts");
  });

  it("materializes the frozen commit read-only and strips unrelated credentials", () => {
    const checkout = entrypoint.slice(
      entrypoint.indexOf("materialize_plan_writer_checkout()"),
      entrypoint.indexOf('if [ "${TILLER_BOOTSTRAP_MODE:-}" = "plan-writer" ]'),
    );
    expect(
      checkout.indexOf('chown root:root "$workspace_dir"'),
    ).toBeGreaterThan(0);
    expect(checkout.indexOf('chown root:root "$workspace_dir"')).toBeLessThan(
      checkout.indexOf('git -C "$workspace_dir" init -q'),
    );
    expect(checkout).toContain(
      'git config --file "$git_config_path" --add safe.directory "$workspace_dir"',
    );
    expect(checkout).toContain('export GIT_CONFIG_GLOBAL="$git_config_path"');
    expect(entrypoint).toContain(
      "trap report_plan_writer_bootstrap_failure ERR",
    );
    expect(entrypoint).toContain(
      '"startupError":"Plan Writer checkout bootstrap failed before supervisor startup."',
    );
    expect(entrypoint).toContain(
      'git -C "$workspace_dir" fetch --depth 1 origin "$TILLER_GITHUB_BASE_COMMIT_SHA"',
    );
    expect(checkout).toContain(
      '> "$workspace_dir/.git/tiller-opencode-read-denied"',
    );
    expect(entrypoint).toContain(
      'find "$workspace_dir" -type d -exec chmod 0555 {} +',
    );
    expect(entrypoint).toContain(
      'find "$workspace_dir" -type f -exec chmod 0444 {} +',
    );
    expect(entrypoint).toContain(
      "unset TILLER_GITHUB_BRIDGE_ID TILLER_GITHUB_BRIDGE_SECRET",
    );
    expect(entrypoint).toContain("unset TILLER_MCP_SERVERS_JSON");
  });
});
