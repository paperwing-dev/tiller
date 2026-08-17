import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function buildEntrypointStopHarness(tempRoot: string) {
  const fakeBin = path.join(tempRoot, "bin");
  const argsFile = path.join(tempRoot, "curl-args.txt");
  const progressFile = path.join(tempRoot, "progress.txt");
  const waitFile = path.join(tempRoot, "waited.txt");
  const scriptPath = path.join(tempRoot, "entrypoint-stop-smoke.sh");
  mkdirSync(fakeBin, { recursive: true });

  installExecutable(
    path.join(fakeBin, "curl"),
    `#!/bin/bash
set -euo pipefail
args_file="${argsFile}"
response_file=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      response_file="$2"
      shift 2
      ;;
    -w|-X|-H|--max-time)
      shift 2
      ;;
    -s|-fsS)
      shift
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
printf '%s\\n' "$url" > "$args_file"
if [ -n "$response_file" ]; then
  printf '%s' '{"ok":true}' > "$response_file"
fi
printf '200'
`,
  );

  const functionPrefix = readFileSync(ENTRYPOINT_SOURCE, "utf8").split("# --- Git auth for private repos ---")[0];
  writeFileSync(
    scriptPath,
    `#!/bin/bash
set -eo pipefail
${functionPrefix}
report_progress() {
  printf '%s\\n' "$2" >> "${progressFile}"
}
wait() {
  printf '1\\n' >> "${waitFile}"
  return 0
}
wait_for_durable_stop_or_exit "lead exit"
`,
    { mode: 0o755 },
  );

  return { argsFile, progressFile, waitFile, scriptPath, fakeBin };
}

function extractCleanupFunction(stopFinalizePath: string): string {
  const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");
  const start = source.indexOf("cleanup() {");
  const end = source.indexOf("\non_exit()", start);
  if (start < 0 || end < 0) {
    throw new Error("Could not extract cleanup from entrypoint.sh");
  }
  return source.slice(start, end).replaceAll("/stop-finalize.sh", stopFinalizePath);
}

function buildCleanupHarness(tempRoot: string) {
  const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
  const scriptPath = path.join(tempRoot, "cleanup-smoke.sh");
  const syncModeFile = path.join(tempRoot, "sync-mode.txt");
  const reportFile = path.join(tempRoot, "runner-stopped.txt");
  const stopRequestedPath = path.join(tempRoot, "stop-requested");

  installExecutable(
    stopFinalizePath,
    `#!/bin/bash
set -euo pipefail
printf '%s\\n' "\${TILLER_IDLE_STOP_PREPARE_ONLY:-0}" > "${syncModeFile}"
`,
  );
  writeFileSync(
    scriptPath,
    `#!/bin/bash
set -e
CLEANING_UP=false
WATCHDOG_PID=""
PERIODIC_PID=""
TILLER_PID=""
STOP_CONTROL_PID=""
STOP_REQUESTED_FLAG_PATH="${stopRequestedPath}"
STOP_PREPARED_FLAG_PATH="${path.join(tempRoot, "stop-prepared")}"
resolve_stop_lifecycle_op_id() { printf '%s' "stop-op"; }
build_stop_cleanup_message() { printf 'intentional stop'; }
build_unexpected_cf_cleanup_message() { printf 'unexpected cf stop; sync rc %s' "$2"; }
report_runner_stopped() { printf '%s|%s\\n' "$1" "$2" > "${reportFile}"; }
${extractCleanupFunction(stopFinalizePath)}
cleanup
`,
    { mode: 0o755 },
  );

  return { reportFile, scriptPath, stopRequestedPath, syncModeFile };
}

describe("entrypoint stop smoke", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("requests a durable stop and reports saving changes before waiting for exit", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-stop-smoke-");
    const { argsFile, progressFile, waitFile, scriptPath, fakeBin } = buildEntrypointStopHarness(tempRoot);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, "utf8")).toContain("https://hub.test/api/envs/demo-env/stop");
    expect(readFileSync(progressFile, "utf8")).toContain("Saving workspace…");
    expect(existsSync(waitFile)).toBe(true);
  });

  it("runs a no-ack workspace sync and reports the Start op on unexpected Cloudflare SIGTERM", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-cf-cleanup-");
    const { reportFile, scriptPath, syncModeFile } = buildCleanupHarness(tempRoot);

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        RUNNER_BACKEND: "cf",
        TILLER_LIFECYCLE_START_OP_ID: "start-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(syncModeFile, "utf8").trim()).toBe("1");
    expect(readFileSync(reportFile, "utf8")).toContain(
      "unexpected cf stop; sync rc 0|start-op-42",
    );
  });

  it("keeps an intentional Cloudflare Stop on its lifecycle-owned finalize path", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-cf-intentional-cleanup-");
    const { reportFile, scriptPath, stopRequestedPath, syncModeFile } = buildCleanupHarness(tempRoot);
    writeFileSync(stopRequestedPath, "1");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        RUNNER_BACKEND: "cf",
        TILLER_LIFECYCLE_START_OP_ID: "start-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(syncModeFile, "utf8").trim()).toBe("0");
    expect(existsSync(reportFile)).toBe(false);
  });
});
