import test from "node:test";
import assert from "node:assert/strict";
import { reportRunnerReadyWithRetry } from "../dist/runner-ready.js";

test("reportRunnerReadyWithRetry retries until the callback succeeds", async () => {
  const messages = [];
  let attempts = 0;

  const ok = await reportRunnerReadyWithRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`boom-${attempts}`);
      }
    },
    {
      attempts: 4,
      onLog: (message) => messages.push(message),
      reportBootProgress: async (message) => messages.push(`boot:${message}`),
      sleepFn: async () => {},
    },
  );

  assert.equal(ok, true);
  assert.equal(attempts, 3);
  assert.ok(messages.some((message) => message.includes("failed (1/4): boom-1")));
  assert.ok(messages.some((message) => message.includes("failed (2/4): boom-2")));
  assert.ok(messages.some((message) => message.includes("succeeded after retry 3/4")));
});

test("reportRunnerReadyWithRetry aborts cleanly when startup context is no longer current", async () => {
  let attempts = 0;

  const ok = await reportRunnerReadyWithRetry(
    async () => {
      attempts += 1;
      throw new Error("boom");
    },
    {
      attempts: 4,
      shouldAbort: () => attempts >= 1,
      sleepFn: async () => {},
    },
  );

  assert.equal(ok, false);
  assert.equal(attempts, 1);
});
