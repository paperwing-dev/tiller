import test from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_REQUEST_TIMEOUT_MS,
  MAX_MODEL_ACTIVITY_EVENTS_PER_RUN,
  ModelActivityPublisher,
  PlannerHubCallback,
} from "../dist/planner/hub-callback.js";
import { EnvReviewHubCallback } from "../dist/planner/env-review-callback.js";

function abortingFetch(signals) {
  return async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    signals.push(signal);
    return await new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

function bodyStallingFetch(signals) {
  return async (_url, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    signals.push(signal);
    const body = new ReadableStream({
      start(controller) {
        const fail = () => controller.error(signal.reason ?? new Error("aborted"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

test("reviewer callback attempts use a fixed ten-second production timeout", () => {
  assert.equal(CALLBACK_REQUEST_TIMEOUT_MS, 10_000);
});

test("planner callback bounds every retry attempt with a request timeout", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const signals = [];
  const callback = new PlannerHubCallback({
    baseUrl: "https://hub.test/runtime",
    runToken: "token",
    fetchImpl: abortingFetch(signals),
    retryDelayMs: 1,
    requestTimeoutMs: 8,
  });

  try {
    await assert.rejects(callback.fetchContext(), /timeout|aborted/i);
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    clearTimeout(keepAlive);
  }
});

test("environment-review callback bounds every retry attempt with a request timeout", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const signals = [];
  const callback = new EnvReviewHubCallback({
    baseUrl: "https://hub.test/runtime",
    runToken: "token",
    fetchImpl: abortingFetch(signals),
    retryDelayMs: 1,
    requestTimeoutMs: 8,
  });

  try {
    await assert.rejects(callback.fetchContext(), /timeout|aborted/i);
    assert.equal(signals.length, 3);
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    clearTimeout(keepAlive);
  }
});

test("callback retries include stalled response bodies and workspace downloads", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    const plannerSignals = [];
    const planner = new PlannerHubCallback({
      baseUrl: "https://hub.test/runtime",
      runToken: "token",
      fetchImpl: bodyStallingFetch(plannerSignals),
      retryDelayMs: 1,
      requestTimeoutMs: 8,
    });
    await assert.rejects(planner.fetchContext(), /timeout|aborted/i);
    assert.equal(plannerSignals.length, 3);

    const envJsonSignals = [];
    const envJson = new EnvReviewHubCallback({
      baseUrl: "https://hub.test/runtime",
      runToken: "token",
      fetchImpl: bodyStallingFetch(envJsonSignals),
      retryDelayMs: 1,
      requestTimeoutMs: 8,
    });
    await assert.rejects(envJson.fetchContext(), /timeout|aborted/i);
    assert.equal(envJsonSignals.length, 3);

    const workspaceSignals = [];
    const workspace = new EnvReviewHubCallback({
      baseUrl: "https://hub.test/runtime",
      runToken: "token",
      fetchImpl: bodyStallingFetch(workspaceSignals),
      retryDelayMs: 1,
      requestTimeoutMs: 8,
    });
    await assert.rejects(workspace.fetchWorkspaceTar(), /timeout|aborted/i);
    assert.equal(workspaceSignals.length, 3);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("model activity publisher serializes requests, coalesces backlog, and flushes", async () => {
  const sent = [];
  const releases = [];
  const publisher = new ModelActivityPublisher(async (message) => {
    sent.push(message);
    await new Promise((resolve) => releases.push(resolve));
  });

  publisher.publish("Thinking");
  publisher.publish("Reading: first.ts");
  publisher.publish("Reading: latest.ts");
  assert.deepEqual(sent, ["Thinking"]);

  releases.shift()();
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent, ["Thinking", "Reading: latest.ts"]);

  let flushed = false;
  const flush = publisher.flush().then(() => {
    flushed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(flushed, false);
  releases.shift()();
  await flush;
  assert.equal(flushed, true);
});

test("model activity publisher retains commentary while coalescing noisy tools", async () => {
  const sent = [];
  const releases = [];
  const publisher = new ModelActivityPublisher(async (message, type) => {
    sent.push({ message, type });
    await new Promise((resolve) => releases.push(resolve));
  });

  publisher.publish("Thinking");
  publisher.publish("I’m tracing the event path.", "model_commentary");
  publisher.publish("Running: rg first");
  publisher.publish("Running: rg latest");
  assert.deepEqual(sent, [{ message: "Thinking", type: "model_activity" }]);

  releases.shift()();
  await waitFor(() => sent.length === 2);
  assert.deepEqual(sent[1], {
    message: "I’m tracing the event path.",
    type: "model_commentary",
  });
  releases.shift()();
  await waitFor(() => sent.length === 3);
  assert.deepEqual(sent[2], { message: "Running: rg latest", type: "model_activity" });
  releases.shift()();
  await publisher.flush();
});

test("callbacks send startup, model activity, commentary, and empty cancellation polls", async () => {
  const payloads = [];
  const fetchImpl = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, runStatus: "running" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const planner = new PlannerHubCallback({
    baseUrl: "https://hub.test/runtime",
    runToken: "token",
    fetchImpl,
  });
  const envReview = new EnvReviewHubCallback({
    baseUrl: "https://hub.test/runtime",
    runToken: "token",
    fetchImpl,
  });

  await planner.postEvent({ type: "runtime_startup" });
  await planner.postEvent({ type: "model_activity", message: "Running: rg reviewer" });
  await planner.postEvent({ type: "model_commentary", message: "I’m checking the reviewer path." });
  await planner.pollRunStatus();
  await envReview.postEvent({ type: "runtime_startup" });
  await envReview.postEvent({ type: "model_activity", message: "Read: src/index.ts" });
  await envReview.pollRunStatus();

  assert.deepEqual(payloads, [
    { events: [{ type: "runtime_startup" }] },
    { events: [{ type: "model_activity", message: "Running: rg reviewer" }] },
    { events: [{ type: "model_commentary", message: "I’m checking the reviewer path." }] },
    { events: [] },
    { events: [{ type: "runtime_startup" }] },
    { events: [{ type: "model_activity", message: "Read: src/index.ts" }] },
    { events: [] },
  ]);
});

test("reviewer callbacks bound model activity without affecting status polls", async () => {
  for (const Callback of [PlannerHubCallback, EnvReviewHubCallback]) {
    const payloads = [];
    const callback = new Callback({
      baseUrl: "https://hub.test/runtime",
      runToken: "token",
      fetchImpl: async (_url, init) => {
        payloads.push(JSON.parse(init.body));
        return Response.json({ ok: true, runStatus: "running" });
      },
    });

    for (let index = 0; index < MAX_MODEL_ACTIVITY_EVENTS_PER_RUN + 2; index += 1) {
      await callback.postEvent({ type: "model_activity", message: `Action ${index}` });
    }
    await callback.pollRunStatus();

    assert.equal(payloads.length, MAX_MODEL_ACTIVITY_EVENTS_PER_RUN + 1);
    assert.deepEqual(payloads.at(-1), { events: [] });
  }
});
