import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const ENTRYPOINT_SOURCE = path.resolve(import.meta.dirname, "..", "entrypoint.sh");
const tempDirs: string[] = [];

function makeHarness(): { scriptPath: string; fenceDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "tiller-entrypoint-fence-"));
  tempDirs.push(root);
  const fenceDir = path.join(root, "fence");
  mkdirSync(fenceDir);

  const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");
  const start = source.indexOf("verify_host_command_fence() {");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("Host command fence function not found");
  const functionSource = source.slice(start, end + 3);
  const scriptPath = path.join(root, "verify-fence.sh");
  writeFileSync(scriptPath, `#!/bin/bash\nset -e\n${functionSource}\nif verify_host_command_fence; then exit 0; else exit 42; fi\n`, {
    mode: 0o755,
  });
  return { scriptPath, fenceDir };
}

describe("host command entrypoint fence", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("allows only the mounted token for its own running generation", () => {
    const { scriptPath, fenceDir } = makeHarness();
    writeFileSync(path.join(fenceDir, "running-8"), "start-op-8\n");

    const accepted = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        TILLER_HOST_COMMAND_FENCE_REQUIRED: "1",
        TILLER_HOST_COMMAND_GENERATION: "8",
        TILLER_HOST_COMMAND_FENCE_PATH: fenceDir,
      },
    });
    const superseded = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        TILLER_HOST_COMMAND_FENCE_REQUIRED: "1",
        TILLER_HOST_COMMAND_GENERATION: "7",
        TILLER_HOST_COMMAND_FENCE_PATH: fenceDir,
      },
    });

    expect(accepted.status).toBe(0);
    expect(superseded.status).toBe(42);
  });

  it("fails closed when generation or mounted state is missing", () => {
    const { scriptPath, fenceDir } = makeHarness();
    const invalidGeneration = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        TILLER_HOST_COMMAND_FENCE_REQUIRED: "1",
        TILLER_HOST_COMMAND_GENERATION: "not-a-number",
        TILLER_HOST_COMMAND_FENCE_PATH: fenceDir,
      },
    });
    const missingToken = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        TILLER_HOST_COMMAND_FENCE_REQUIRED: "1",
        TILLER_HOST_COMMAND_GENERATION: "9",
        TILLER_HOST_COMMAND_FENCE_PATH: fenceDir,
      },
    });

    expect(invalidGeneration.status).toBe(42);
    expect(missingToken.status).toBe(42);
  });

  it("uses the dedicated pre-workspace rejection exit code before Git or harness setup", () => {
    const source = readFileSync(ENTRYPOINT_SOURCE, "utf8");
    const fenceCheck = source.indexOf("if ! verify_host_command_fence; then");
    const fencedExit = source.indexOf("exit 75", fenceCheck);
    const gitSetup = source.indexOf("configure_github_credential_helper_for_file()", fenceCheck);

    expect(fenceCheck).toBeGreaterThanOrEqual(0);
    expect(fencedExit).toBeGreaterThan(fenceCheck);
    expect(gitSetup).toBeGreaterThan(fencedExit);
  });
});
