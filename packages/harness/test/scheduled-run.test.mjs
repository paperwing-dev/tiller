import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScheduledRunReplacementPrompt,
  reportPlanExecutionCompleteWithRetry,
  reportScheduledRunIdleWithRetry,
  shouldArmScheduledRunIdleTimer,
} from "../dist/scheduled-run.js";

test("replacement prompts resume the pinned plan from the existing workspace", () => {
  const prompt = buildScheduledRunReplacementPrompt("Implement the approved change.\nVerify it.");

  assert.match(prompt, /replacing an agent process/i);
  assert.match(prompt, /Inspect the existing workspace first/);
  assert.match(prompt, /tiller-plan complete/);
  assert.match(prompt, /Implement the approved change\.\nVerify it\./);
});

test("idle timing is scoped to a delivered Scheduled Run prompt", () => {
  assert.equal(shouldArmScheduledRunIdleTimer("scheduled", false), false);
  assert.equal(shouldArmScheduledRunIdleTimer("scheduled", true), true);
  assert.equal(shouldArmScheduledRunIdleTimer("ordinary", true), false);
});

test("completion reports the exact lifecycle operation", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const result = await reportPlanExecutionCompleteWithRetry({
      repoSlug: "demo env",
      lifecycleOpId: "start-op-1",
    });
    assert.equal(result, "accepted");
    assert.match(String(request.url), /\/api\/envs\/demo%20env\/plan-execution\/complete$/);
    assert.equal(request.init.headers["X-Tiller-Lifecycle-Op-Id"], "start-op-1");
    assert.equal(request.init.body, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("idle reports Interrupted through the Scheduled Run endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(await reportScheduledRunIdleWithRetry({
      repoSlug: "demo-env",
      lifecycleOpId: "start-op-2",
    }), "accepted");
    assert.match(String(request.url), /\/api\/envs\/demo-env\/scheduled-run\/idle$/);
    assert.equal(request.init.headers["X-Tiller-Lifecycle-Op-Id"], "start-op-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lifecycle reporting retries transient failures and stops on permanent rejection", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let attempts = 0;
  globalThis.setTimeout = (callback) => {
    queueMicrotask(callback);
    return 0;
  };
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("rate limited", { status: 429 });
    if (attempts === 2) return new Response("temporary", { status: 503 });
    return new Response("stale operation", { status: 409 });
  };
  try {
    const result = await reportPlanExecutionCompleteWithRetry({
      repoSlug: "demo-env",
      lifecycleOpId: "start-op-1",
    });
    assert.equal(result, "rejected");
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});
