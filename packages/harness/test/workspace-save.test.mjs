import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceSaveCoordinator } from "../dist/workspace-save.js";

test("routine workspace saves retry with capped backoff", async () => {
  let attempts = 0;
  const delays = [];
  const coordinator = new WorkspaceSaveCoordinator({
    execute: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient upload failure");
    },
    retryDelaysMs: [2, 4],
    sleep: async (delayMs) => { delays.push(delayMs); },
  });

  await coordinator.requestSave("idle");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [2, 4]);
});

test("a save request arriving during a scan gets a second converging pass", async () => {
  let releaseFirst;
  let passes = 0;
  const coordinator = new WorkspaceSaveCoordinator({
    execute: async () => {
      passes += 1;
      if (passes === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    },
    retryDelaysMs: [],
  });

  const idleSave = coordinator.requestSave("idle");
  await new Promise((resolve) => setImmediate(resolve));
  const explicitSave = coordinator.requestSave("explicit");
  releaseFirst();
  await Promise.all([idleSave, explicitSave]);
  assert.equal(passes, 2);
});

test("routine workspace saves reject after the capped retry budget", async () => {
  let attempts = 0;
  const coordinator = new WorkspaceSaveCoordinator({
    execute: async () => {
      attempts += 1;
      throw new Error("persistent failure");
    },
    retryDelaysMs: [1, 1],
    sleep: async () => undefined,
  });

  await assert.rejects(coordinator.requestSave("explicit"), /persistent failure/);
  assert.equal(attempts, 3);
});
