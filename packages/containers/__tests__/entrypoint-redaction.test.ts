import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("entrypoint redaction", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts short session env values and glob metacharacters in diagnostics and log tails", () => {
    const tempRoot = makeTempDir("tiller-entrypoint-redaction-");
    const scriptPath = path.join(tempRoot, "entrypoint-redaction.sh");
    const logPath = path.join(tempRoot, "boot.log");
    const functionPrefix = readFileSync(ENTRYPOINT_SOURCE, "utf8").split("# --- Git auth for private repos ---")[0];

    writeFileSync(
      scriptPath,
      `#!/bin/bash
set -e
${functionPrefix}
printf 'harness emitted %s and %s and %s\\n' "$PIN" "$GLOB_SECRET" "$COMMON_LONG" > "${logPath}"
printf 'diagnostic=%s\\n' "$(redact_managed_env_values "pin=$PIN glob=$GLOB_SECRET short=$COMMON_SHORT common=$COMMON_LONG")"
printf 'summary=%s\\n' "$(summarize_recent_output "${logPath}")"
`,
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        TILLER_SESSION_ENV_NAMES: "PIN,GLOB_SECRET",
        TILLER_MANAGED_ENV_NAMES: "PIN,GLOB_SECRET,COMMON_SHORT,COMMON_LONG",
        PIN: "abc",
        GLOB_SECRET: "a*b?[c]\\d",
        COMMON_SHORT: "ok",
        COMMON_LONG: "common-secret",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("diagnostic=pin=[redacted] glob=[redacted] short=ok common=[redacted]");
    expect(result.stdout).toContain("summary=harness emitted [redacted] and [redacted] and [redacted]");
    expect(result.stdout).not.toContain("abc");
    expect(result.stdout).not.toContain("a*b?[c]\\d");
    expect(result.stdout).not.toContain("common-secret");
  });
});
