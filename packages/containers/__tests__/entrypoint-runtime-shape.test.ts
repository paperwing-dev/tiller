import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTAINER_DIR = path.resolve(import.meta.dirname, "..");
const DEPLOY_SCRIPT_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "..",
  "scripts",
  "deploy-dev.sh",
);
const RELEASE_PLAN_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "..",
  "scripts",
  "release-plan.mjs",
);
const UPDATE_HOST_SCRIPT_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "..",
  "scripts",
  "update-self-host-dev.sh",
);
const ROOT_PACKAGE_JSON_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "..",
  "package.json",
);
const CONTAINER_WORKFLOW_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "..",
  ".github",
  "workflows",
  "container-image.yml",
);
const ENTRYPOINT_SOURCE = path.join(CONTAINER_DIR, "entrypoint.sh");
const OPENCODE_CONFIG_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "harness",
  "src",
  "opencode-config.ts",
);
const HARNESS_INDEX_SOURCE = path.resolve(
  CONTAINER_DIR,
  "..",
  "harness",
  "src",
  "index.ts",
);
const DOCKERFILE_BASE_SOURCE = path.join(CONTAINER_DIR, "Dockerfile.base");
const STOP_CONTROL_SOURCE = path.join(CONTAINER_DIR, "stop-control-server.mjs");
const DOCKERFILE_SOURCE = path.join(CONTAINER_DIR, "Dockerfile");

async function loadReleasePlanner() {
  return (await import(pathToFileURL(RELEASE_PLAN_SOURCE).href)) as {
    inferReleaseBump(input: {
      releaseVersion: string;
      versions: Record<string, string>;
    }): "patch" | "minor";
    resolveReleasePlan(input: {
      bump?: string;
      changedFiles?: string[];
      forceCli?: boolean;
      versions?: Record<string, string>;
    }): {
      releaseVersion: string;
      targetVersions: Record<string, string>;
      publishCli: boolean;
    };
  };
}

describe("release planner", () => {
  const versions = {
    hub: "0.2.54",
    tiller: "0.2.1",
    harness: "0.2.54",
    containers: "0.2.54",
    installer: "0.2.54",
  };

  it("defaults every coordinated workspace to the next patch", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    const plan = resolveReleasePlan({
      changedFiles: ["packages/hub/api/hub.ts"],
      versions,
    });

    expect(plan.releaseVersion).toBe("0.2.55");
    expect(plan.publishCli).toBe(false);
    expect(plan.targetVersions).toEqual({
      hub: "0.2.55",
      tiller: "0.2.1",
      harness: "0.2.55",
      containers: "0.2.55",
      installer: "0.2.55",
    });
  });

  it("supports an explicit minor bump but no major bump", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    expect(
      resolveReleasePlan({ bump: "minor", changedFiles: [], versions })
        .releaseVersion,
    ).toBe("0.3.0");
    expect(() =>
      resolveReleasePlan({
        bump: "major",
        changedFiles: [],
        versions,
      }),
    ).toThrow("patch or minor");
  });

  it("infers the original bump when resuming a release", async () => {
    const { inferReleaseBump } = await loadReleasePlanner();

    expect(inferReleaseBump({ releaseVersion: "0.2.55", versions })).toBe(
      "patch",
    );
    expect(inferReleaseBump({ releaseVersion: "0.3.0", versions })).toBe(
      "minor",
    );
  });

  it("publishes the CLI only when its shipped inputs changed", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    const cli = resolveReleasePlan({
      changedFiles: ["packages/tiller/src/index.ts"],
      versions,
    });
    const hub = resolveReleasePlan({
      changedFiles: ["packages/hub/api/hub.ts"],
      versions,
    });

    expect(cli.publishCli).toBe(true);
    expect(cli.targetVersions.tiller).toBe("0.2.55");
    expect(hub.publishCli).toBe(false);
    expect(hub.targetVersions.tiller).toBe("0.2.1");
  });

  it("does not treat monorepo package metadata as a CLI release", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    for (const changedFile of ["package.json", "package-lock.json"]) {
      const plan = resolveReleasePlan({
        changedFiles: [changedFile],
        versions,
      });
      expect(plan.publishCli).toBe(false);
    }
  });

  it("releases the CLI when shared compiler inputs change", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    const plan = resolveReleasePlan({
      changedFiles: ["configs/base.tsconfig.json"],
      versions,
    });

    expect(plan.publishCli).toBe(true);
  });

  it("can recover a deprecated CLI package without a source edit", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    const plan = resolveReleasePlan({
      changedFiles: [],
      forceCli: true,
      versions,
    });

    expect(plan.publishCli).toBe(true);
    expect(plan.targetVersions.tiller).toBe("0.2.55");
  });

  it("does not publish the CLI for documentation or tests", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    const plan = resolveReleasePlan({
      changedFiles: [
        "docs/release.md",
        "packages/hub/shared/harness-catalog.ts",
        "packages/tiller/src/index.test.ts",
        "packages/harness/README.md",
      ],
      versions,
    });

    expect(plan.publishCli).toBe(false);
  });

  it("allows the CLI to lag but rejects coordinated version-line drift", async () => {
    const { resolveReleasePlan } = await loadReleasePlanner();
    expect(() =>
      resolveReleasePlan({
        changedFiles: [],
        versions: { ...versions, tiller: "0.1.9" },
      }),
    ).not.toThrow();
    expect(() =>
      resolveReleasePlan({
        changedFiles: ["packages/hub/api/hub.ts"],
        versions: { ...versions, installer: "0.2.53" },
      }),
    ).toThrow("version drift");
  });
});

describe("entrypoint runtime shape", () => {
  it("launches tiller-harness as a direct child without tmux lifecycle wiring", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain(
      'install -o tiller -g tiller -m 0644 /dev/null "$TILLER_LOG"',
    );
    expect(source).toContain('if [ -z "${TILLER_HARNESS:-}" ]; then');
    expect(source).toContain('TILLER_HARNESS_ARGS=("$REPO_SLUG")');
    expect(source).toContain('exec "$@" >> "$TILLER_LOG" 2>&1');
    expect(source).toContain(
      '\' bash tiller-harness "${TILLER_HARNESS_ARGS[@]}" &',
    );
    expect(source).toContain('wait "$TILLER_PID" || TILLER_EXIT_CODE=$?');
    expect(source).not.toContain('HARNESS="${TILLER_HARNESS:-claude-code}"');

    expect(source).not.toContain("tmux new-session -d -s agent -n shell");
    expect(source).not.toContain("ttyd -p 7681");
    expect(source).not.toContain("tmux wait-for tiller-exit");
    expect(source).not.toContain("tmux send-keys -t agent:main");
    expect(source).not.toContain(
      "tmux list-windows -t agent -F '#{window_name}'",
    );
    expect(source).not.toContain("teammate window(s) still running");
  });

  it("smoke tests both published architectures and every pinned agent dependency", () => {
    const workflow = readFileSync(CONTAINER_WORKFLOW_SOURCE, "utf8");

    expect(workflow).toContain("Smoke test sandbox image (amd64)");
    expect(workflow).toContain("Smoke test sandbox image (arm64)");
    expect(workflow.match(/set -euo pipefail/g)).toHaveLength(5);
    expect(workflow).toContain('test "$(uname -m)" = "x86_64"');
    expect(workflow).toContain('test "$(uname -m)" = "aarch64"');
    expect(workflow.match(/codex-reviewer-smoke\.mjs/g)).toHaveLength(6);
    expect(
      workflow.match(
        /--network none --user tiller --env RUNNER_BACKEND=host --entrypoint node/g,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(/TILLER_OPENCODE_TRACE_BIN=\/usr\/bin\/strace/g),
    ).toHaveLength(2);
    for (const version of ["2.1.224", "0.147.0", "1.18.18"]) {
      expect(workflow).toContain(version);
    }
  });

  it("keeps Claude model and effort transport in the harness instead of wrapper flags", () => {
    const entrypoint = readFileSync(ENTRYPOINT_SOURCE, "utf8");
    const harness = readFileSync(HARNESS_INDEX_SOURCE, "utf8");

    expect(entrypoint).not.toContain(
      'TILLER_HARNESS_ARGS+=(--model "$TILLER_CLAUDE_MODEL")',
    );
    expect(entrypoint).not.toContain(
      'TILLER_HARNESS_ARGS+=(--effort "$TILLER_CLAUDE_EFFORT")',
    );
    expect(harness).toContain(
      "harnessArgs.push(...resolveClaudeModelEffortArgs())",
    );
  });

  it("keeps the environment capability out of specialized review snapshot uploads", () => {
    const harness = readFileSync(HARNESS_INDEX_SOURCE, "utf8");
    const uploadFunction = harness.slice(
      harness.indexOf("async function uploadEnvReviewSnapshot"),
      harness.indexOf("// ── Main"),
    );

    expect(uploadFunction).toContain("...cfTransportHeaders");
    expect(uploadFunction).not.toContain("environmentRuntimeHeaders");
  });

  it("keeps retired teammate scripts out of the active image", () => {
    const dockerfile = readFileSync(DOCKERFILE_SOURCE, "utf8");

    expect(dockerfile).toContain("/etc/tiller-harness-version");
    expect(dockerfile).toContain("/etc/tiller-image-commit");
    expect(dockerfile).toContain("COPY tiller-harness.tgz");
    expect(dockerfile).not.toContain("@paperwing-dev/tiller-harness@");
    expect(dockerfile).not.toContain("COPY spawn-teammate.sh");
    expect(dockerfile).not.toContain("COPY send-to-teammate.sh");
  });

  it("does not include unrecognized config keys for OpenCode", () => {
    const source = readFileSync(OPENCODE_CONFIG_SOURCE, "utf8");

    // OpenCode rejects unknown config keys; "data" is not part of its schema.
    expect(source).not.toContain('"data":');
    expect(source).toContain("enabled_providers: [selection.providerAlias]");
    expect(source).toContain("permission: {");
    expect(source).toContain('edit: "allow"');
    expect(source).toContain('bash: "allow"');
    expect(source).toContain('webfetch: "allow"');
    expect(source).not.toContain('permission: "allow"');
    expect(source).toContain("npm: selection.providerPackage");
  });

  it("prepares OpenCode data, cache, and state directories before launch", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain('OPENCODE_LOCAL_DIR="/home/tiller/.local"');
    expect(source).toContain(
      'OPENCODE_DATA_DIR="/home/tiller/.local/share/opencode"',
    );
    expect(source).toContain(
      'OPENCODE_CACHE_DIR="/home/tiller/.cache/opencode"',
    );
    expect(source).toContain(
      'OPENCODE_RUNTIME_STATE_DIR="/home/tiller/.local/state/opencode"',
    );
    expect(source).toContain('OPENCODE_SEED_DIR="/opt/opencode-seed"');
    expect(source).toContain(
      'OPENCODE_CONFIG_DIR="/home/tiller/.config/opencode"',
    );
    expect(source).toContain(
      'OPENCODE_THEME_DIR="${OPENCODE_CONFIG_DIR}/themes"',
    );
    expect(source).toContain('OPENCODE_THEME_ID="tiller-light"');
    expect(source).toContain(
      'OPENCODE_TUI_CONFIG_FILE="${OPENCODE_CONFIG_DIR}/tui.json"',
    );
    expect(source).toContain(
      'OPENCODE_TUI_STATE_FILE="${OPENCODE_RUNTIME_STATE_DIR}/tui"',
    );
    expect(source).not.toContain("OPENCODE_PROVIDER_VERSION");
    expect(source).not.toContain("OPENCODE_PROVIDER_MODULE_DIR");
    expect(source).not.toContain("OPENCODE_PROVIDER_ALIAS_DIR");
    expect(source).toContain('export COLORTERM="${COLORTERM:-truecolor}"');
    expect(source).toContain(
      'OPENCODE_CONFIG_CONTENT="$(tiller-opencode-config)"',
    );
    expect(readFileSync(DOCKERFILE_SOURCE, "utf8")).not.toContain(
      "opencode-config.mjs",
    );
    expect(source).toContain(
      "install -d -o tiller -g tiller -m 0755 /home/tiller/.config",
    );
    expect(
      source.indexOf(
        "install -d -o tiller -g tiller -m 0755 /home/tiller/.config",
      ),
    ).toBeLessThan(
      source.indexOf('mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_THEME_DIR"'),
    );
    expect(source).toContain('mkdir -p "$OPENCODE_LOCAL_DIR/state"');
    expect(source).toContain(
      'mkdir -p "$OPENCODE_DATA_DIR" "$OPENCODE_CACHE_DIR" "$OPENCODE_RUNTIME_STATE_DIR"',
    );
    expect(source).toContain(
      'mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_THEME_DIR"',
    );
    expect(source).toContain(
      'if ! directory_has_files "$OPENCODE_DATA_DIR" && directory_has_files "$OPENCODE_SEED_DIR/data"; then',
    );
    expect(source).toContain(
      'cp -R "$OPENCODE_SEED_DIR/data"/. "$OPENCODE_DATA_DIR"/',
    );
    expect(source).toContain(
      'if ! directory_has_files "$OPENCODE_CACHE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/cache"; then',
    );
    expect(source).toContain(
      'cp -R "$OPENCODE_SEED_DIR/cache"/. "$OPENCODE_CACHE_DIR"/',
    );
    expect(source).toContain(
      'if ! directory_has_files "$OPENCODE_RUNTIME_STATE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/state"; then',
    );
    expect(source).toContain(
      'cp -R "$OPENCODE_SEED_DIR/state"/. "$OPENCODE_RUNTIME_STATE_DIR"/',
    );
    expect(source).not.toContain("OPENCODE_PROVIDER_CACHE_OK");
    expect(source).not.toContain('rm -rf "$OPENCODE_CACHE_DIR"');
    expect(source).toContain(
      "if grep -q '^theme = ' \"$OPENCODE_TUI_STATE_FILE\"; then",
    );
    expect(source).toContain(
      'sed -i "s/^theme = .*/theme = \\"${OPENCODE_THEME_ID}\\"/" "$OPENCODE_TUI_STATE_FILE"',
    );
    expect(source).toContain(
      'printf \'theme = "%s"\\n\' "$OPENCODE_THEME_ID" > "$OPENCODE_TUI_STATE_FILE"',
    );
    expect(source).toContain(
      'cat > "${OPENCODE_THEME_DIR}/${OPENCODE_THEME_ID}.json"',
    );
    expect(source).toContain('"$schema": "https://opencode.ai/theme.json"');
    expect(source).toContain('"background": "#f8fafc"');
    expect(source).toContain('cat > "$OPENCODE_TUI_CONFIG_FILE"');
    expect(source).toContain('"\\$schema": "https://opencode.ai/tui.json"');
    expect(source).toContain('"theme": "${OPENCODE_THEME_ID}"');
    expect(source).toContain('&& [ -f "$OPENCODE_DATA_DIR/opencode.db" ]');
    expect(source).toContain(
      "printf '1' > \"$OPENCODE_DATA_DIR/storage/migration\"",
    );
    expect(source).toContain('chown -R tiller:tiller "$OPENCODE_LOCAL_DIR"');
    expect(source).toContain('chown -R tiller:tiller "/home/tiller/.cache"');
  });

  it("makes the shared agent configuration root writable by tiller", () => {
    const dockerfile = readFileSync(DOCKERFILE_BASE_SOURCE, "utf8");

    expect(dockerfile).toContain(
      "mkdir -p /home/tiller/.config /home/tiller/.claude",
    );
    expect(dockerfile).toContain("chown -R tiller:tiller /home/tiller/.config");
  });

  it("fails OpenCode startup before launch when catalog model limits are absent", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain(
      '[ -z "$TILLER_OPENCODE_MODEL_CONTEXT_LIMIT" ] && missing="$missing TILLER_OPENCODE_MODEL_CONTEXT_LIMIT"',
    );
    expect(source).toContain(
      '[ -z "$TILLER_OPENCODE_MODEL_OUTPUT_LIMIT" ] && missing="$missing TILLER_OPENCODE_MODEL_OUTPUT_LIMIT"',
    );
  });

  it("seeds Codex defaults and trusts the workspace in the base image", () => {
    const dockerfile = readFileSync(DOCKERFILE_BASE_SOURCE, "utf8");

    expect(dockerfile).toContain("mkdir -p /home/tiller/.codex");
    expect(dockerfile).toContain("'model = \"gpt-5.6-sol\"'");
    expect(dockerfile).toContain("'model_reasoning_effort = \"xhigh\"'");
    expect(dockerfile).toContain(
      "'# BEGIN TILLER MANAGED CODEX PROJECT TRUST'",
    );
    expect(dockerfile).toContain("'[projects.\"/workspace\"]'");
    expect(dockerfile).toContain("'trust_level = \"trusted\"'");
    expect(dockerfile).toContain("/home/tiller/.codex");
  });

  it("pins and prewarms OpenCode in the base image", () => {
    const source = readFileSync(DOCKERFILE_BASE_SOURCE, "utf8");

    expect(source).toContain("ARG OPENCODE_VERSION=1.18.18");
    expect(source).toContain("@anthropic-ai/claude-code@2.1.224");
    expect(source).toContain("@openai/codex@0.147.0");
    expect(source).not.toContain("OPENAI_COMPATIBLE_VERSION");
    expect(source).not.toContain("TILLER_OPENCODE_PROVIDER_PACKAGE");
    expect(source).not.toContain("TILLER_OPENCODE_PROVIDER_VERSION");
    expect(source).toContain("opencode-ai@${OPENCODE_VERSION}");
    expect(source).toContain("bubblewrap strace");
    expect(source).toContain(
      'test "$(opencode --version)" = "${OPENCODE_VERSION}"',
    );
    expect(source).toContain(
      'opencode run --help 2>&1 | grep -q -- "--format"',
    );
    expect(source).toContain("SEED_ROOT=/opt/opencode-seed");
    expect(source).toContain(
      'mkdir -p "$SEED_HOME" "$SEED_HOME/workspace" "$SEED_ROOT/data" "$SEED_ROOT/cache" "$SEED_ROOT/state"',
    );
    expect(source).not.toContain(
      'npm install --prefix "$SEED_HOME/.cache/opencode"',
    );
    expect(source).toContain("opencode debug paths");
    expect(source).not.toContain('opencode run --format json "prewarm"');
    expect(source).not.toContain("ln -sfn openai-compatible");
    expect(source).toContain(
      "printf '1' > \"$SEED_HOME/.local/share/opencode/storage/migration\"",
    );
    expect(source).toContain(
      'rm -rf "$SEED_HOME/.local/share/opencode/log" "$SEED_HOME/.local/share/opencode/storage/project" "$SEED_HOME/workspace"',
    );
    expect(source).toContain(
      'cp -R "$SEED_HOME/.local/share/opencode/." "$SEED_ROOT/data/"',
    );
    expect(source).toContain(
      'cp -R "$SEED_HOME/.cache/opencode/." "$SEED_ROOT/cache/"',
    );
    expect(source).toContain(
      'cp -R "$SEED_HOME/.local/state/opencode/." "$SEED_ROOT/state/"',
    );
    expect(source).not.toContain("opencode session list --format json");
    expect(source).not.toContain("opencode stats");
  });

  it("uses the deploy marker tag for base image rebuild decisions", () => {
    const source = readFileSync(DEPLOY_SCRIPT_SOURCE, "utf8");

    expect(source).toContain('DEPLOY_TAG_NAME="tiller-deploy/dev"');
    expect(source).toContain(
      'git -C "$REPO_ROOT" fetch --force origin "$DEPLOY_TAG_REF:$DEPLOY_TAG_REF"',
    );
    expect(source).toContain(
      'git -C "$REPO_ROOT" merge-base --is-ancestor "$DEPLOY_TAG_NAME" "$commit_sha"',
    );
    expect(source).toContain(
      'git -C "$REPO_ROOT" diff --quiet "$DEPLOY_TAG_NAME" "$commit_sha" -- packages/containers/Dockerfile.base',
    );
    expect(source).toContain("packages/containers/Dockerfile.base");
    expect(source).toContain('VALIDATION_WORKFLOW="validate-deploy.yml"');
    expect(source).toContain("-f image_tag=deploy");
    expect(source).toContain('-f rebuild_base="$rebuild_base"');
    expect(source).toContain('-f upstream_ref="$UPSTREAM_REF"');
    expect(source).toContain('-f request_id="$request_id"');
    expect(source).toContain("for-each-ref --format='%(contents)'");
    expect(source).toContain(
      'sync-tag "$SELF_HOST_DEPLOY_RECORD" "$DEPLOY_MARKER_COMMIT"',
    );
    expect(source).toContain(
      'tag -a -f --cleanup=verbatim -F "$SELF_HOST_DEPLOY_RECORD" "$DEPLOY_TAG_NAME" "$commit_sha"',
    );
    expect(source).toContain(
      'git -C "$REPO_ROOT" push --force origin "$DEPLOY_TAG_REF"',
    );
    expect(source).toContain("classify_deploy_mode()");
    expect(source).toContain('validate_deploy_arguments "$@"');
    expect(source).toContain('[[ "$#" == "1" && "$1" == "--full" ]]');
    expect(source).toContain('if [[ "$FORCE_FULL_DEPLOY" == "true" ]]');
    expect(source).not.toContain(["DEPLOY", "MODE"].join("_"));
    expect(source).toContain("deploy_hub_only()");
    expect(source).toContain('CONTAINER_IMAGE_TAG="$previous_sandbox_image"');
    expect(source).toContain(
      'GITHUB_JOB_IMAGE_TAG="$previous_github_job_image"',
    );
    expect(source).toContain('previous_hub_commit" != "$DEPLOY_MARKER_COMMIT"');
    expect(source).toContain(
      "deploy record hubCommitSha does not match deploy marker",
    );
    expect(source).toContain(
      'write_deploy_record "$commit_sha" "$previous_image_commit"',
    );
    expect(source).toContain("write_deploy_record \\");
    expect(source).toContain('"$commit_sha" \\');
    expect(source).toContain("deploy_tiller_only()");
    expect(source).toContain(
      "Only packages/tiller changed. No Cloudflare deploy is needed.",
    );
    expect(source).toContain(
      "reseed the deploy record before updating the host",
    );
    expect(source).toContain("sync_developer_self_host_after_deploy()");
    expect(source).toContain(
      'sync_developer_self_host_after_deploy "$DEPLOY_CLASSIFICATION"',
    );
    expect(source).toContain("TILLER_SKIP_SELF_HOST_UPDATE:-");
    expect(source).toContain('if [[ "$deploy_classification" == "hub-only" ]]');
    expect(source).toContain(
      "Self Host runtime image is unchanged; skipping developer host update.",
    );
    expect(source).toContain(
      "Synchronizing the configured developer self-host target...",
    );
    expect(
      source.lastIndexOf(
        'sync_developer_self_host_after_deploy "$DEPLOY_CLASSIFICATION"',
      ),
    ).toBeGreaterThan(source.lastIndexOf('case "$DEPLOY_CLASSIFICATION" in'));
    expect(source).toContain("require('./packages/hub/package.json').version");
    expect(source).not.toContain(
      "require('./packages/tiller/package.json').version",
    );
    expect(source).not.toContain("PREVIOUS_DEPLOY_COMMIT");
    expect(source).not.toContain("npm version");
    expect(source).not.toContain("npm publish");
  });

  it.each([
    ["packages/hub/api/index.ts", "hub-only"],
    ["packages/tiller/src/index.ts", "tiller-only"],
    ["packages/hub/api/index.ts\npackages/tiller/src/index.ts", "full"],
    ["packages/harness/src/index.ts", "full"],
  ])("classifies development changes %s as %s", (changedPaths, expected) => {
    const output = execFileSync(
      "bash",
      [
        "-c",
        `
      source "$1"
      git() {
        if [[ "$*" == *"diff --name-only"* ]]; then
          printf '%s\\n' "$TEST_CHANGED_PATHS"
          return 0
        fi
        command git "$@"
      }
      DEPLOY_MARKER_COMMIT=marker
      DEPLOY_MARKER_IS_ANCESTOR=true
      classify_deploy_mode head
    `,
        "deploy-classifier",
        DEPLOY_SCRIPT_SOURCE,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TEST_CHANGED_PATHS: changedPaths },
      },
    );
    expect(output.trim()).toBe(expected);
  });

  it("accepts only the optional --full recovery override", () => {
    const accepted = execFileSync(
      "bash",
      [
        "-c",
        `
      source "$1"
      shift
      validate_deploy_arguments "$@"
      printf '%s\\n' "$FORCE_FULL_DEPLOY"
    `,
        "deploy-arguments",
        DEPLOY_SCRIPT_SOURCE,
        "--full",
      ],
      { encoding: "utf8" },
    );
    expect(accepted.trim()).toBe("true");
    const automatic = execFileSync(
      "bash",
      [
        "-c",
        `
      source "$1"
      shift
      validate_deploy_arguments "$@"
      printf '%s\\n' "$FORCE_FULL_DEPLOY"
    `,
        "deploy-arguments",
        DEPLOY_SCRIPT_SOURCE,
      ],
      { encoding: "utf8" },
    );
    expect(automatic.trim()).toBe("false");

    for (const args of [["--unknown"], ["--full", "--full"], ["--full=1"]]) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
        source "$1"
        shift
        validate_deploy_arguments "$@"
      `,
          "deploy-arguments",
          DEPLOY_SCRIPT_SOURCE,
          ...args,
        ],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Usage: npm run deploy:dev -- [--full]");
    }
  });

  it("lets the deploy script decide base rebuild history in the container workflow", () => {
    const source = readFileSync(CONTAINER_WORKFLOW_SOURCE, "utf8");

    expect(source).toContain("workflow_call:");
    expect(source).toContain("Build and pack tiller-harness from this commit");
    expect(source).toContain("npm pack --workspace packages/harness");
    expect(source).toContain("TILLER_IMAGE_COMMIT=${{ github.sha }}");
    expect(source).not.toContain("harness_version");
    expect(source).toContain(
      'if [[ "${{ inputs.rebuild_base }}" == "true" ]]; then',
    );
    expect(source).toContain(
      'elif ! docker buildx imagetools inspect "$base_channel_tag" >/dev/null 2>&1; then',
    );
    expect(source).not.toContain("smoke_sandbox_image:");
    expect(source).not.toContain('opencode run "smoke"');
    expect(
      source.match(/TILLER_PINNED_OPENCODE_BIN=\/usr\/bin\/opencode/g),
    ).toHaveLength(2);
    expect(source.match(/smoke\/opencode-image-smoke\.mjs/g)).toHaveLength(2);
    expect(source).not.toContain("test/plan-writer.test.mjs");
    expect(source).not.toContain("HEAD^");
    expect(source).not.toContain(
      "git diff --quiet HEAD^ HEAD -- packages/containers/Dockerfile.base",
    );
  });

  it("self-host local-env pins to the validation image instead of building on the target", () => {
    const source = readFileSync(UPDATE_HOST_SCRIPT_SOURCE, "utf8");

    expect(source).toContain("validate_local_runner_inputs_match_deploy");
    expect(source).toContain("deploy-record.mjs");
    expect(source).toContain("IMAGE_SHA=\"${remaining%%$'\\n'*}\"");
    expect(source).toContain(
      'git -C "$REPO_ROOT" diff --quiet "$IMAGE_SHA" -- packages/harness packages/containers',
    );
    expect(source).toContain("npm pack --pack-destination");
    expect(source).toContain("docker pull '$IMAGE'");
    expect(source).not.toContain("tiller-deploy/release");
    expect(source).not.toContain("@paperwing-dev/tiller@latest");
    expect(source).toContain(
      "Existing tiller workload containers were left unchanged.",
    );
    expect(source).toContain("They can Stop and save on their current image");
    expect(source).not.toContain("reset_existing_envs");
    expect(source).not.toContain("docker rm -f");
    expect(source).not.toContain("RESET_ENVS_AFTER_UPDATE");
    expect(source).not.toContain("PUBLISHED_TILLER_VERSION");
    expect(source).not.toContain("docker build");
    expect(source).not.toContain("runnerInputsFingerprint");
    expect(source).not.toContain(".update-self-host-local-cache.json");
  });

  it("keeps the development deploy-and-update command on the conditional root deploy path", () => {
    const packageJson = JSON.parse(
      readFileSync(ROOT_PACKAGE_JSON_SOURCE, "utf8"),
    );

    expect(packageJson.scripts.deploy).toBeUndefined();
    expect(packageJson.scripts["deploy:dev"]).toBe(
      "bash scripts/deploy-dev.sh",
    );
    expect(packageJson.scripts["deploy:dev:update-host"]).toBe(
      "npm run deploy:dev",
    );
  });

  it("uses the runner-ready marker before falling back to log activity", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain(
      'RUNNER_READY_MARKER_WAIT_SECONDS="${TILLER_RUNNER_READY_MARKER_WAIT_SECONDS:-15}"',
    );
    expect(source).toContain(
      'RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS="${TILLER_RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS:-45}"',
    );
    expect(source).toMatch(
      /grep -q "\\\[tiller\\\] Hub WebSocket connected" "\$TILLER_LOG"[\s\S]+?\[ -f "\$RUNNER_READY_MARKER_PATH" \][\s\S]+?wc -c < "\$TILLER_LOG"/,
    );
  });

  it("does not let Claude subscription launches fall back to API auth", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain("use_claude_subscription_auth()");
    expect(source).toContain("clear_claude_api_auth_env()");
    expect(source).toContain(
      '[ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "subscription" ]',
    );
    expect(source).toContain(
      '[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && missing="$missing CLAUDE_CODE_OAUTH_TOKEN"',
    );
    expect(source).toContain("unset ANTHROPIC_API_KEY");
    expect(source).toContain("unset ANTHROPIC_AUTH_TOKEN");
    expect(source).toContain(
      'report_progress "harness-launch" "Claude auth via subscription token, flag=${TILLER_HARNESS_AUTH_FLAG}"',
    );
  });

  it("removes internal workspace files after sync down", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");

    expect(source).toContain("Removing runtime core dump from workspace");
    expect(source).toContain("rm -f /workspace/core || true");
    expect(source).toContain("Removing workspace-local Claude settings");
    expect(source).toContain(
      "rm -f /workspace/.claude/settings.local.json || true",
    );
  });
});

describe("harness failure vs env lifecycle separation", () => {
  const entrypoint = readFileSync(ENTRYPOINT_SOURCE, "utf8");
  const stopControl = readFileSync(STOP_CONTROL_SOURCE, "utf8");

  it("entrypoint checks stop-requested before deciding exit behavior", () => {
    // The lead-process exit handler must check for the stop-requested marker
    // to distinguish intentional stops from unexpected harness failures.
    expect(entrypoint).toContain("STOP_REQUESTED_FLAG_PATH");
    expect(entrypoint).toContain('if [ -f "$STOP_REQUESTED_FLAG_PATH" ]');
  });

  it("entrypoint does not call durable stop on unexpected harness exit", () => {
    // When stop-requested is absent, the entrypoint should report harness
    // failure and wait — not call request_durable_stop.
    expect(entrypoint).toContain("report_harness_failure");
    expect(entrypoint).toContain("/harness-failed");
    expect(entrypoint).toContain(
      "X-Tiller-Lifecycle-Op-Id: ${TILLER_LIFECYCLE_START_OP_ID}",
    );
  });

  it("entrypoint reports host runner exits back to the hub on process exit", () => {
    expect(entrypoint).toContain("report_runner_stopped");
    expect(entrypoint).toContain("/runner-stopped");
    expect(entrypoint).toContain("trap on_exit EXIT");
  });

  it("entrypoint reports runner-stopped from cleanup on intentional host stop", () => {
    // cleanup() calls report_runner_stopped via the host-stop message builder,
    // setting RUNNER_STOP_REPORTED=1 so on_exit short-circuits.
    expect(entrypoint).toContain("build_stop_cleanup_message");
    expect(entrypoint).toContain(
      'if [ "${RUNNER_BACKEND:-}" = "host" ] && [ -f "$STOP_REQUESTED_FLAG_PATH" ]; then',
    );
  });

  it("entrypoint saves and reports an unexpected Cloudflare shutdown", () => {
    expect(entrypoint).toContain("unexpected_cf_shutdown=true");
    expect(entrypoint).toContain(
      "TILLER_IDLE_STOP_PREPARE_ONLY=1 /stop-finalize.sh",
    );
    expect(entrypoint).toContain("build_unexpected_cf_cleanup_message");
    expect(entrypoint).toContain('"${TILLER_LIFECYCLE_START_OP_ID:-}" || true');
  });

  it("entrypoint cleanup disables set -e so wait $PID failures don't abort the trap", () => {
    // Under `set -e`, `kill $PID && wait $PID` exits the script when wait
    // returns 143 (SIGTERM exit code). That would skip stop-finalize and the
    // runner-stopped callback.
    expect(entrypoint).toMatch(/cleanup\(\)[\s\S]+?set \+e/);
  });

  it("entrypoint on_exit acts as backstop if cleanup exits before reporting", () => {
    // If cleanup() is interrupted before report_runner_stopped runs, on_exit
    // must still send the callback — the deferring short-circuit is gone.
    expect(entrypoint).not.toContain(
      "deferring runner-stopped callback until cleanup completes",
    );
    expect(entrypoint).toMatch(
      /on_exit\(\)[\s\S]+?STOP_REQUESTED_FLAG_PATH[\s\S]+?report_runner_stopped/,
    );
  });

  it("entrypoint reports host infra readiness separately from runtime readiness", () => {
    expect(entrypoint).toContain("report_runner_infra_ready");
    expect(entrypoint).toContain("/infra-ready");
    expect(entrypoint).toContain("TILLER_LIFECYCLE_START_OP_ID");
  });

  it("entrypoint still uses durable stop for intentional stop path", () => {
    // When stop-requested IS present, the intentional stop path remains.
    expect(entrypoint).toContain("wait_for_durable_stop_or_exit");
  });

  it("entrypoint clears both stop markers on boot", () => {
    // All stop markers must be cleared at container start so stale state from a
    // prior run doesn't affect the current boot.
    expect(entrypoint).toContain(
      'rm -f "$STOP_PREPARED_FLAG_PATH" "$STOP_REQUESTED_FLAG_PATH" "$STOP_OP_ID_PATH"',
    );
  });

  it("entrypoint records a reaped harness exit for safe stop recovery", () => {
    expect(entrypoint).toContain("HARNESS_EXITED_MARKER_PATH");
    expect(entrypoint).toMatch(
      /wait \"\$TILLER_PID\"[\s\S]+?HARNESS_EXITED_MARKER_PATH/,
    );
    expect(stopControl).toContain("confirmedExitedHarnessCode");
    expect(stopControl).toContain("runnerReadyMarkerPath");
  });

  it("entrypoint reports the baked harness version without reinstalling", () => {
    expect(entrypoint).toContain("resolve_baked_tiller_harness_version");
    expect(entrypoint).toContain("report_baked_tiller_harness");
    expect(entrypoint).toContain(
      "Using baked tiller-harness $baked_tiller_harness_version",
    );
    expect(entrypoint).not.toContain("npm install -g");
  });

  it("stop-control-server writes stop-requested immediately on /prepare-stop", () => {
    // The stop-requested marker must be written before snapshot work starts,
    // so the entrypoint can detect an in-flight intentional stop even if
    // tiller-harness exits before SIGTERM arrives.
    expect(stopControl).toContain("stopRequestedPath");
    expect(stopControl).toContain("tiller-stop-requested");
  });

  it("stop-control-server still writes stop-prepared after snapshot success", () => {
    // The existing stop-prepared flow must remain intact.
    expect(stopControl).toContain("flagPath");
    expect(stopControl).toContain("tiller-stop-prepared");
  });

  it("stop-control-server persists the stop lifecycle op id for shutdown callbacks", () => {
    expect(stopControl).toContain("stopOpIdPath");
    expect(stopControl).toContain("tiller-lifecycle-stop-op-id");
    expect(stopControl).toContain("writeFileSync(stopOpIdPath, stopOpId)");
  });
});
