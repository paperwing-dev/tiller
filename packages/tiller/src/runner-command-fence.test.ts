import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RunnerCommandFenceError,
  RunnerCommandFenceStore,
} from "./runner-command-fence.js";

const tempDirs: string[] = [];

function makeStore(): RunnerCommandFenceStore {
  const dir = mkdtempSync(resolve(tmpdir(), "tiller-runner-fence-"));
  tempDirs.push(dir);
  return new RunnerCommandFenceStore(dir);
}

function expectFenceError(
  action: () => unknown,
  code: "runner_command_superseded_before_mutation" | "runner_command_superseded" | "runner_command_conflict",
): RunnerCommandFenceError {
  try {
    action();
    throw new Error("Expected runner command fence error");
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerCommandFenceError);
    expect((error as RunnerCommandFenceError).code).toBe(code);
    return error as RunnerCommandFenceError;
  }
}

describe("RunnerCommandFenceStore", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("persists the high-water mark and accepts only an exact retry", () => {
    const store = makeStore();
    const accepted = store.accept("demo-env", {
      commandGeneration: 3,
      operationId: "start-op-3",
      desiredState: "running",
    }, "running");

    expect(accepted).toMatchObject({ commandGeneration: 3, phase: "accepted" });
    expect(new RunnerCommandFenceStore(resolve(store.rootPath, "..")).read("demo-env"))
      .toMatchObject({ commandGeneration: 3, operationId: "start-op-3" });
    expect(store.accept("demo-env", {
      commandGeneration: 3,
      operationId: "start-op-3",
      desiredState: "running",
    }, "running")).toMatchObject(accepted!);

    expectFenceError(() => store.accept("demo-env", {
      commandGeneration: 3,
      operationId: "another-op",
      desiredState: "running",
    }, "running"), "runner_command_conflict");
    const superseded = expectFenceError(() => store.accept("demo-env", {
      commandGeneration: 2,
      operationId: "start-op-2",
      desiredState: "running",
    }, "running"), "runner_command_superseded_before_mutation");
    expect(superseded.currentCommandGeneration).toBe(3);
  });

  it("requires a complete command tuple for the first mutation", () => {
    const store = makeStore();

    expectFenceError(() => store.accept("demo-env", {}, "running"), "runner_command_conflict");
    expectFenceError(() => store.accept("demo-env", {
      commandGeneration: 1,
      operationId: "start-op-1",
    }, "running"), "runner_command_conflict");
    expect(store.read("demo-env")).toBeNull();
  });

  it("removes the running token before accepting Stop and preserves the tombstone", () => {
    const store = makeStore();
    store.accept("demo-env", {
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    }, "running");
    const token = resolve(store.directoryFor("demo-env"), "running-1");
    expect(existsSync(token)).toBe(true);

    const stopped = store.accept("demo-env", {
      commandGeneration: 2,
      operationId: "stop-op-2",
      desiredState: "stopped",
    }, "stopped");

    expect(existsSync(token)).toBe(false);
    expect(stopped).toMatchObject({ desiredState: "stopped", phase: "accepted" });
    store.markApplied(stopped!);
    expect(store.read("demo-env")).toMatchObject({
      commandGeneration: 2,
      operationId: "stop-op-2",
      desiredState: "stopped",
      phase: "applied",
    });
    expectFenceError(() => store.accept("demo-env", {}, "running"), "runner_command_conflict");
  });

  it("fails closed when persisted state is corrupt", () => {
    const store = makeStore();
    const directory = store.directoryFor("demo-env");
    // accept once to create the private directory, then corrupt only state.
    store.accept("demo-env", {
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    }, "running");
    writeFileSync(resolve(directory, "state.json"), "not-json");

    expectFenceError(() => store.accept("demo-env", {
      commandGeneration: 2,
      operationId: "stop-op-2",
      desiredState: "stopped",
    }, "stopped"), "runner_command_conflict");
  });

  it("records persistence proof only for the exact runner covered by Stop", () => {
    const store = makeStore();
    store.accept("demo-env", {
      commandGeneration: 4,
      operationId: "start-op-4",
      desiredState: "running",
    }, "running");
    const stop = store.accept("demo-env", {
      commandGeneration: 5,
      operationId: "stop-op-5",
      desiredState: "stopped",
    }, "stopped");

    expect(store.recordWorkspaceSyncedStop(stop, 4)).toMatchObject({
      slug: "demo-env",
      stopCommandGeneration: 5,
      stopOperationId: "stop-op-5",
      runnerCommandGeneration: 4,
    });
    expect(new RunnerCommandFenceStore(resolve(store.rootPath, "..")).readWorkspaceSyncedStop("demo-env"))
      .toMatchObject({ stopOperationId: "stop-op-5", runnerCommandGeneration: 4 });
    expectFenceError(
      () => store.recordWorkspaceSyncedStop(stop, 5),
      "runner_command_conflict",
    );
  });
});
