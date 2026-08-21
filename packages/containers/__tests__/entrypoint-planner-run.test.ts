import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Shape assertions for the planner-run bootstrap branch. Kept in its own file:
// entrypoint-runtime-shape.test.ts carries uncommitted parallel work.
const ENTRYPOINT_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "..", "entrypoint.sh"),
  "utf-8",
);

// The branch now contains nested ifs (the OpenCode seed copy), so slice from
// the branch opener to the interactive section instead of regex-matching to
// the first `fi`.
function plannerRunBranch(): string {
  const start = ENTRYPOINT_SOURCE.indexOf('if [ "${TILLER_BOOTSTRAP_MODE:-}" = "planner-run" ]; then');
  const end = ENTRYPOINT_SOURCE.indexOf("sync_down()");
  expect(start, "planner-run branch missing from entrypoint.sh").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return ENTRYPOINT_SOURCE.slice(start, end);
}

describe("entrypoint planner-run branch", () => {
  it("execs a privileged reviewer supervisor that drops only provider children", () => {
    const branch = plannerRunBranch();
    expect(branch).toContain("/etc/tiller-reviewer-isolation-protocol");
    expect(branch).toContain('if [ "$IMAGE_REVIEWER_ISOLATION_PROTOCOL" != "1" ]');
    expect(branch).toContain('if [ "${TILLER_REVIEWER_ISOLATION_PROTOCOL:-}" != "$IMAGE_REVIEWER_ISOLATION_PROTOCOL" ]');
    expect(branch).not.toContain("runuser -u tiller");
    expect(branch).toContain("exec");
    expect(branch).toContain("tiller-planner");
  });

  it("runs the planner branch before interactive workspace sync starts", () => {
    const plannerIndex = ENTRYPOINT_SOURCE.indexOf('= "planner-run" ]');
    const syncIndex = ENTRYPOINT_SOURCE.indexOf("sync_down()");
    expect(plannerIndex).toBeGreaterThan(0);
    expect(syncIndex).toBeGreaterThan(0);
    expect(plannerIndex).toBeLessThan(syncIndex);
  });

  it("keeps the planner branch after the GitHub publish bootstrap job branch", () => {
    const publishIndex = ENTRYPOINT_SOURCE.indexOf('= "github-env-publish" ]');
    const plannerIndex = ENTRYPOINT_SOURCE.indexOf('= "planner-run" ]');
    expect(publishIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeLessThan(plannerIndex);
  });

  // The interactive OpenCode seed block lives after the planner-run exec, so
  // planner containers must perform their own seed copy or OpenCode
  // cold-downloads its provider npm package on every run.
  it("seeds the OpenCode data/cache/state dirs for opencode planner runs", () => {
    const branch = plannerRunBranch();
    expect(branch).toContain('[ "${TILLER_HARNESS:-}" = "opencode" ]');
    expect(branch).toContain('OPENCODE_SEED_DIR="/opt/opencode-seed"');
    expect(branch).toContain('cp -R "$OPENCODE_SEED_DIR/data"/. "$OPENCODE_DATA_DIR"/');
    expect(branch).toContain('cp -R "$OPENCODE_SEED_DIR/cache"/. "$OPENCODE_CACHE_DIR"/');
    expect(branch).toContain('cp -R "$OPENCODE_SEED_DIR/state"/. "$OPENCODE_RUNTIME_STATE_DIR"/');
    expect(branch).toContain("chown -R tiller:tiller");
  });

  it("seeds OpenCode before exec'ing tiller-planner", () => {
    const branch = plannerRunBranch();
    const seedIndex = branch.indexOf("$OPENCODE_SEED_DIR/cache");
    const execIndex = branch.indexOf("exec tiller-planner");
    expect(seedIndex).toBeGreaterThan(0);
    expect(execIndex).toBeGreaterThan(seedIndex);
  });
});
