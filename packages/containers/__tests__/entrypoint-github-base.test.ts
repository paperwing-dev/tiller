import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONTAINER_DIR = path.resolve(import.meta.dirname, "..");
const ENTRYPOINT_SOURCE = path.join(CONTAINER_DIR, "entrypoint.sh");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o755 });
}

function extractMaterializeGitHubBase(): string {
  const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");
  const start = source.indexOf("materialize_github_base() {");
  const end = source.indexOf("\nwrite_startup_plan_document()", start);
  if (start < 0 || end < 0) {
    throw new Error("Could not extract materialize_github_base from entrypoint.sh");
  }
  return source.slice(start, end);
}

function extractReportStartupFailure(): string {
  const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");
  const start = source.indexOf("report_startup_failure_and_exit() {");
  const end = source.indexOf("\nrequest_durable_stop()", start);
  if (start < 0 || end < 0) {
    throw new Error("Could not extract report_startup_failure_and_exit from entrypoint.sh");
  }
  return source.slice(start, end);
}

function prepareHarness(tempRoot: string): {
  fakeBin: string;
  progressFile: string;
  baseCommitFile: string;
  gitArgsFile: string;
  scriptPath: string;
  workspace: string;
} {
  const fakeBin = path.join(tempRoot, "bin");
  const workspace = path.join(tempRoot, "workspace");
  const progressFile = path.join(tempRoot, "progress.txt");
  const baseCommitFile = path.join(tempRoot, "base-commit.txt");
  const gitArgsFile = path.join(tempRoot, "git-args.txt");
  const scriptPath = path.join(tempRoot, "entrypoint-github-base.sh");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  installExecutable(
    path.join(fakeBin, "git"),
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${gitArgsFile}"
subcommand=""
case " $* " in
  *" init "*) subcommand="init" ;;
  *" remote add "*) subcommand="remote-add" ;;
  *" fetch "*) subcommand="fetch" ;;
  *" checkout "*) subcommand="checkout" ;;
esac
if [ -n "\${FAIL_GIT_SUBCOMMAND:-}" ] && [ "$subcommand" = "\${FAIL_GIT_SUBCOMMAND}" ]; then
  exit 128
fi
exit 0
`,
  );
  installExecutable(
    path.join(fakeBin, "timeout"),
    `#!/bin/bash
set -euo pipefail
if [ "\${1:-}" = "--foreground" ]; then shift; fi
shift
exec "$@"
`,
  );

  writeFileSync(
    scriptPath,
    `#!/bin/bash
set -e
${extractMaterializeGitHubBase()}
report_progress() {
  printf '%s|%s|%s\\n' "$1" "$2" "\${3:-info}" >> "${progressFile}"
}
remaining_startup_seconds() { printf '30\\n'; }
if [ -n "\${TILLER_GITHUB_BASE_COMMIT_SHA:-}" ]; then
  report_progress "workspace-sync" "Checking out GitHub base..."
  if ! materialize_github_base; then
    report_progress "workspace-sync" "Workspace startup preparation failed." "error"
    exit 1
  fi
fi
printf '%s\\n' "\${TILLER_GITHUB_BASE_COMMIT_SHA:-}" > "${baseCommitFile}"
`,
    { mode: 0o755 },
  );

  return { fakeBin, progressFile, baseCommitFile, gitArgsFile, scriptPath, workspace };
}

describe("entrypoint GitHub base checkout", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it.each(["init", "remote-add", "fetch", "checkout"])("fails startup when git %s fails under set -e", (subcommand) => {
    const tempRoot = makeTempDir("tiller-entrypoint-github-base-");
    const { fakeBin, progressFile, baseCommitFile, scriptPath, workspace } = prepareHarness(tempRoot);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAIL_GIT_SUBCOMMAND: subcommand,
        REPO_URL: "https://github.com/test/repo.git",
        TILLER_GITHUB_BASE_COMMIT_SHA: "base-sha",
        TILLER_GITHUB_WORKSPACE_DRAFT_FULL: "0",
        TILLER_WORKSPACE_SYNC_WORKSPACE: workspace,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(readFileSync(progressFile, "utf8")).toContain(
      "workspace-sync|Workspace startup preparation failed.|error",
    );
    expect(() => readFileSync(baseCommitFile, "utf8")).toThrow();
  });

  it("marks the workspace as a safe Git directory before checkout", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-github-base-");
    const { fakeBin, gitArgsFile, scriptPath, workspace } = prepareHarness(tempRoot);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        REPO_URL: "https://github.com/test/repo.git",
        TILLER_GITHUB_BASE_COMMIT_SHA: "base-sha",
        TILLER_GITHUB_WORKSPACE_DRAFT_FULL: "0",
        TILLER_WORKSPACE_SYNC_WORKSPACE: workspace,
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const gitArgs = readFileSync(gitArgsFile, "utf8").trim().split("\n");
    const safeIndex = gitArgs.indexOf(`config --global --add safe.directory ${workspace}`);
    const initIndex = gitArgs.findIndex((line) => line.endsWith(" init -q"));
    expect(safeIndex, gitArgs.join("\n")).toBeGreaterThanOrEqual(0);
    expect(initIndex, gitArgs.join("\n")).toBeGreaterThanOrEqual(0);
    expect(safeIndex).toBeLessThan(initIndex);
  });

  it("uses a dedicated host exit proof only before harness launch", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-pre-harness-");
    const scriptPath = path.join(tempRoot, "pre-harness-failure.sh");
    writeFileSync(scriptPath, `#!/bin/bash
set -e
PRE_HARNESS_STARTUP_FAILURE_EXIT_CODE=76
RUNNER_STOP_REPORTED=0
TILLER_LOG=/tmp/unused-harness-log
STOP_CONTROL_LOG=/tmp/unused-stop-log
BOOTSTRAP_LOG=/tmp/unused-bootstrap-log
redact_managed_env_values() { printf '%s' "$1"; }
build_startup_log_tails_json() { printf '{"harness":null,"stopControl":null,"bootstrap":null}'; }
json_escape() { printf '%s' "$1"; }
json_string_or_null() { printf 'null'; }
post_startup_diagnostics() { return 0; }
${extractReportStartupFailure()}
HARNESS_LAUNCHED="$1"
report_startup_failure_and_exit "workspace-sync" "startup failed"
`, { mode: 0o755 });

    const beforeHarness = spawnSync("bash", [scriptPath, "false"], {
      env: { ...process.env, RUNNER_BACKEND: "host" },
      encoding: "utf8",
    });
    const afterHarness = spawnSync("bash", [scriptPath, "true"], {
      env: { ...process.env, RUNNER_BACKEND: "host" },
      encoding: "utf8",
    });
    const cloudflare = spawnSync("bash", [scriptPath, "false"], {
      env: { ...process.env, RUNNER_BACKEND: "cf" },
      encoding: "utf8",
    });

    expect(beforeHarness.status).toBe(76);
    expect(afterHarness.status).toBe(1);
    expect(cloudflare.status).toBe(1);
  });
});
