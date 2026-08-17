import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONTAINER_DIR = path.resolve(import.meta.dirname, "..");
const STOP_FINALIZE_SOURCE = path.join(CONTAINER_DIR, "stop-finalize.sh");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function installExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, { mode: 0o755 });
}

interface StopFinalizeHarness {
  tempRoot: string;
  fakeBin: string;
  stopFinalizePath: string;
  workspaceSyncPath: string;
}

function prepareStopFinalizeHarness(workspaceSyncBody: string): StopFinalizeHarness {
  const tempRoot = makeTempDir("tiller-stop-finalize-test-");
  const fakeBin = path.join(tempRoot, "bin");
  mkdirSync(fakeBin, { recursive: true });

  const workspaceSyncPath = path.join(tempRoot, "workspace-sync.mjs");
  writeFileSync(workspaceSyncPath, workspaceSyncBody, { mode: 0o755 });

  const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
  writeFileSync(
    stopFinalizePath,
    readFileSync(STOP_FINALIZE_SOURCE, "utf8").replaceAll(
      "/workspace-sync.mjs",
      workspaceSyncPath,
    ),
    { mode: 0o755 },
  );

  installExecutable(
    path.join(fakeBin, "timeout"),
    `#!/bin/bash
set -euo pipefail
duration="$1"
shift
exec "$@"
`,
  );

  installExecutable(
    path.join(fakeBin, "flock"),
    `#!/bin/bash
set -euo pipefail
# flock is invoked as: flock -w <seconds> <lock-path> <command> [args...]
test "$1" = "-w"
if [ -n "\${TILLER_TEST_FLOCK_ARGS_FILE:-}" ]; then
  printf '%s\n' "$@" > "$TILLER_TEST_FLOCK_ARGS_FILE"
fi
shift 3
exec "$@"
`,
  );

  installExecutable(
    path.join(fakeBin, "node"),
    `#!/bin/bash
set -euo pipefail
# node is invoked as: node <script-path> <command>
# Forward to bash so tests can stub workspace-sync.mjs with bash bodies.
exec bash "$@"
`,
  );

  return {
    tempRoot,
    fakeBin,
    stopFinalizePath,
    workspaceSyncPath,
  };
}

function isolatedStopFinalizeEnv(harness: StopFinalizeHarness): NodeJS.ProcessEnv {
  const stopStateDir = path.join(harness.tempRoot, "stop-state");
  return {
    ...process.env,
    NODE_ENV: "test",
    PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
    HUB_URL: "",
    REPO_SLUG: "",
    STOP_FAILED_URL: "",
    CF_ACCESS_CLIENT_ID: "",
    CF_ACCESS_CLIENT_SECRET: "",
    TILLER_RUNTIME_CAPABILITY: "",
    TILLER_LIFECYCLE_OP_ID: "",
    TILLER_IDLE_STOP_PREPARE_ONLY: "0",
    TILLER_SKIP_WORKSPACE_SYNC_ACK: "0",
    TILLER_STOP_FINALIZE: "0",
    TILLER_STOP_TEST_STATE_OVERRIDES: "1",
    TILLER_STOP_STATE_DIR: stopStateDir,
    TILLER_STOP_PREPARED_FLAG_PATH: path.join(stopStateDir, "prepared"),
    TILLER_STOP_REQUESTED_FLAG_PATH: path.join(stopStateDir, "requested"),
    TILLER_STOP_OP_ID_PATH: path.join(stopStateDir, "lifecycle-operation-id"),
    TILLER_WORKSPACE_SYNC_LOCK_PATH: path.join(harness.tempRoot, "workspace-sync.lock"),
    TILLER_CHECKPOINT_RECEIPT_PATH: path.join(harness.tempRoot, "checkpoint-receipt.json"),
  };
}

describe("stop finalization helper", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("acks workspace-synced on the lifecycle op id when the sync succeeds", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 0
`);
    const curlArgsFile = path.join(harness.tempRoot, "curl-args.txt");
    installExecutable(
      path.join(harness.fakeBin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "${curlArgsFile}"
printf '200'
`,
    );

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_LIFECYCLE_OP_ID: "stop-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const curlArgs = readFileSync(curlArgsFile, "utf8");
    expect(curlArgs).toContain("https://hub.test/api/envs/demo-env/workspace-synced");
    expect(curlArgs).toContain("X-Tiller-Lifecycle-Op-Id: stop-op-42");
    expect(curlArgs).not.toContain("X-Tiller-Workspace-Dirty");
    expect(curlArgs).not.toContain("stop-failed");
  });

  it("lets the Cloudflare owner acknowledge after strict sync returns", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 0
`);

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        TILLER_LIFECYCLE_OP_ID: "stop-op-42",
        TILLER_SKIP_WORKSPACE_SYNC_ACK: "1",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "strict workspace sync complete; Hub owns the lifecycle acknowledgement",
    );
    expect(result.stdout).not.toContain("workspace-synced ack");
  });

  it("uses the shared lock and strict sync for an idle-stop preflight", () => {
    const argsFile = path.join(makeTempDir("tiller-stop-finalize-args-test-"), "sync-args.txt");
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" > "${argsFile}"
exit 0
`);
    const flockArgsFile = path.join(harness.tempRoot, "flock-args.txt");
    const lockPath = path.join(harness.tempRoot, "workspace-sync.lock");

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        TILLER_IDLE_STOP_PREPARE_ONLY: "1",
        TILLER_WORKSPACE_SYNC_LOCK_PATH: lockPath,
        TILLER_TEST_FLOCK_ARGS_FILE: flockArgsFile,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual(["up"]);
    expect(readFileSync(flockArgsFile, "utf8").trim().split("\n")).toEqual([
      "-w",
      "60",
      lockPath,
      "node",
      harness.workspaceSyncPath,
      "up",
    ]);
    expect(result.stdout).toContain("idle-stop workspace sync complete");
  });

  it("resolves the lifecycle op id from the op-id file when unset in env", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 0
`);
    const curlArgsFile = path.join(harness.tempRoot, "curl-args.txt");
    installExecutable(
      path.join(harness.fakeBin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "${curlArgsFile}"
printf '200'
`,
    );
    const stopOpIdPath = path.join(harness.tempRoot, "stop-op-id");
    writeFileSync(stopOpIdPath, "stop-op-from-file");

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_STOP_OP_ID_PATH: stopOpIdPath,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const curlArgs = readFileSync(curlArgsFile, "utf8");
    expect(curlArgs).toContain("X-Tiller-Lifecycle-Op-Id: stop-op-from-file");
  });

  it("skips work when stop was already prepared before SIGTERM", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
echo "should not run" >&2
exit 9
`);
    const preparedFlag = path.join(harness.tempRoot, "prepared");
    writeFileSync(preparedFlag, "1");

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_STOP_PREPARED_FLAG_PATH: preparedFlag,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already prepared");
  });

  it("fails early when no lifecycle op id is available", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
echo "should not run" >&2
exit 0
`);

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no lifecycle op id available");
  });

  it("reports stop-failed when workspace sync exits non-zero", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 7
`);
    const curlArgsFile = path.join(harness.tempRoot, "curl-args.txt");
    installExecutable(
      path.join(harness.fakeBin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "${curlArgsFile}"
printf '200'
`,
    );

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_LIFECYCLE_OP_ID: "stop-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(7);
    const curlArgs = readFileSync(curlArgsFile, "utf8");
    expect(curlArgs).toContain("https://hub.test/api/envs/demo-env/stop-failed");
    expect(curlArgs).toContain("workspace sync exited 7");
  });

  it("reports stop-failed when the workspace-synced ack is rejected", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 0
`);
    const curlArgsFile = path.join(harness.tempRoot, "curl-args.txt");
    installExecutable(
      path.join(harness.fakeBin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "${curlArgsFile}"
case " $* " in
  *workspace-synced*) printf '500' ;;
  *) printf '200' ;;
esac
`,
    );

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_LIFECYCLE_OP_ID: "stop-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    const curlArgs = readFileSync(curlArgsFile, "utf8");
    expect(curlArgs).toContain("https://hub.test/api/envs/demo-env/workspace-synced");
    expect(curlArgs).toContain("https://hub.test/api/envs/demo-env/stop-failed");
    expect(curlArgs).toContain("workspace ack failed");
  });

  it("reports save progress through boot-progress during a successful stop", () => {
    const harness = prepareStopFinalizeHarness(`#!/bin/bash
set -euo pipefail
exit 0
`);
    const curlArgsFile = path.join(harness.tempRoot, "curl-args.txt");
    installExecutable(
      path.join(harness.fakeBin, "curl"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$@" >> "${curlArgsFile}"
printf '200'
`,
    );

    const result = spawnSync("bash", [harness.stopFinalizePath], {
      env: {
        ...isolatedStopFinalizeEnv(harness),
        PATH: `${harness.fakeBin}:${process.env.PATH ?? ""}`,
        HUB_URL: "https://hub.test",
        REPO_SLUG: "demo-env",
        TILLER_LIFECYCLE_OP_ID: "stop-op-42",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const curlArgs = readFileSync(curlArgsFile, "utf8");
    expect(curlArgs.match(/https:\/\/hub\.test\/api\/envs\/demo-env\/boot-progress/g)).toHaveLength(3);
    expect(curlArgs).toContain("Checking workspace for changes...");
    expect(curlArgs).toContain("Confirming workspace saved...");
    expect(curlArgs).toContain("Workspace saved. Waiting for the container to stop...");
  });
});
