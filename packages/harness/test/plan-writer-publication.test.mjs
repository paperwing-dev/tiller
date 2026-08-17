import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PlanPublicationCoordinator } from "../dist/plan-writer/publication.js";

const signal = new AbortController().signal;

function digest(markdown) {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function cursor(sequence, providerEventId, markdown, artifactVersion = sequence) {
  return {
    sequence,
    providerEventId,
    bodyDigest: digest(markdown),
    artifactVersion,
    result: "updated",
  };
}

function context(publicationCursor) {
  return { writer: { publicationCursor } };
}

function harness(overrides = {}) {
  const calls = { posts: [], reads: 0, refreshes: 0, errors: [], delays: [] };
  const coordinator = new PlanPublicationCoordinator({
    initialCursor: overrides.initialCursor ?? null,
    async post(payload, nextSignal) {
      calls.posts.push({ payload, signal: nextSignal });
      return overrides.post?.(payload, calls.posts.length, nextSignal) ?? { status: 500, error: "temporary" };
    },
    async readContext() {
      calls.reads += 1;
      return overrides.readContext?.(calls.reads) ?? context(null);
    },
    async refreshManagedContext() {
      calls.refreshes += 1;
      if (overrides.refreshError) throw new Error(overrides.refreshError);
    },
    async recordSynchronizationError(error) {
      calls.errors.push(error);
    },
    async sleep(delay) {
      calls.delays.push(delay);
    },
    ...(overrides.attemptTimeoutMs ? { attemptTimeoutMs: overrides.attemptTimeoutMs } : {}),
  });
  return { coordinator, calls };
}

test("publication freezes one payload across three retryable attempts and fixed delays", async () => {
  const markdown = "# Plan\n";
  const expected = cursor(1, "event-1", markdown);
  const { coordinator, calls } = harness({
    post: (_payload, attempt) => attempt < 3
      ? { status: attempt === 1 ? 429 : 503, error: "retry" }
      : { status: 200, cursor: expected },
  });

  await coordinator.publish("# Plan", "event-1", "conversation-1", signal);

  assert.equal(calls.posts.length, 3);
  assert.deepEqual(calls.delays, [1_000, 2_000]);
  assert.equal(calls.reads, 2);
  assert.deepEqual(calls.posts.map(({ payload }) => payload), [
    calls.posts[0].payload,
    calls.posts[0].payload,
    calls.posts[0].payload,
  ]);
  assert.deepEqual(coordinator.publicationCursor, expected);
});

test("a publication attempt timeout is treated as an ambiguous transport failure", async () => {
  const { coordinator, calls } = harness({
    attemptTimeoutMs: 5,
    post: (_payload, _attempt, nextSignal) => new Promise((_resolve, reject) => {
      nextSignal.addEventListener("abort", () => reject(nextSignal.reason), { once: true });
    }),
  });

  await assert.rejects(
    coordinator.publish("# Plan", "event-timeout", "conversation-1", signal),
    /could not be confirmed after at most three attempts: transport failure:.*timed out/i,
  );
  assert.equal(calls.posts.length, 3);
  assert.equal(calls.reads, 3);
  assert.deepEqual(calls.delays, [1_000, 2_000]);
  assert.equal(calls.errors.length, 1);
});

test("a lost success response adopts the matching canonical cursor without republishing", async () => {
  const committed = cursor(1, "event-lost", "# Plan\n");
  const { coordinator, calls } = harness({
    post: () => { throw new Error("connection reset after commit"); },
    readContext: () => context(committed),
  });

  await coordinator.publish("# Plan", "event-lost", "conversation-1", signal);

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.reads, 1);
  assert.equal(calls.refreshes, 1);
});

test("canonical event identity is adopted even when the Hub reports a different committed sequence", async () => {
  const committed = cursor(7, "event-lost", "# Plan\n", 12);
  const { coordinator, calls } = harness({
    post: () => { throw new Error("response lost after the canonical commit"); },
    readContext: () => context(committed),
  });

  await coordinator.publish("# Plan", "event-lost", "conversation-1", signal);

  assert.equal(calls.posts.length, 1);
  assert.equal(calls.reads, 1);
  assert.deepEqual(coordinator.publicationCursor, committed);
});

test("a conflicting canonical cursor records the exact error and latches later events", async () => {
  const conflicting = cursor(1, "another-event", "# Other\n");
  const { coordinator, calls } = harness({
    post: () => ({ status: 500, error: "unknown commit" }),
    readContext: () => context(conflicting),
  });

  await assert.rejects(
    coordinator.publish("# Plan", "event-1", "conversation-1", signal),
    /cursor conflict.*another-event/,
  );
  await assert.rejects(
    coordinator.publish("# Later", "event-2", "conversation-1", signal),
    /latched after synchronization failure/,
  );
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.errors.length, 1);
  assert.match(calls.errors[0], /canonical sequence 1/);
});

test("a successful response with a mismatched digest latches without retrying", async () => {
  const mismatched = cursor(1, "event-1", "# Different plan\n");
  const { coordinator, calls } = harness({
    post: () => ({ status: 200, cursor: mismatched }),
  });

  await assert.rejects(
    coordinator.publish("# Plan", "event-1", "conversation-1", signal),
    /returned a conflicting cursor.*event-1.*digest/,
  );
  await assert.rejects(
    coordinator.publish("# Later", "event-2", "conversation-1", signal),
    /latched after synchronization failure/,
  );
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.reads, 0);
  assert.equal(calls.delays.length, 0);
  assert.equal(calls.errors.length, 1);
});

test("non-retryable publication rejection is not retried or refetched", async () => {
  const { coordinator, calls } = harness({ post: () => ({ status: 409, error: "sequence_mismatch" }) });

  await assert.rejects(
    coordinator.publish("# Plan", "event-1", "conversation-1", signal),
    /HTTP 409: sequence_mismatch/,
  );
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.reads, 0);
  assert.equal(calls.delays.length, 0);
});

test("HTTP 408 is retried and an unresolved final attempt records one synchronization error", async () => {
  const { coordinator, calls } = harness({
    post: () => ({ status: 408, error: "request timeout" }),
  });

  await assert.rejects(
    coordinator.publish("# Plan", "event-1", "conversation-1", signal),
    /could not be confirmed after at most three attempts: HTTP 408: request timeout/,
  );
  assert.equal(calls.posts.length, 3);
  assert.equal(calls.reads, 3);
  assert.deepEqual(calls.delays, [1_000, 2_000]);
  assert.equal(calls.errors.length, 1);
});

test("confirmed commits with failed context refresh block later publication without reposting", async () => {
  const committed = cursor(1, "event-1", "# Plan\n");
  const { coordinator, calls } = harness({
    post: () => ({ status: 200, cursor: committed }),
    refreshError: "context unavailable",
  });

  await assert.rejects(
    coordinator.publish("# Plan", "event-1", "conversation-1", signal),
    /committed, but managed context refresh failed/,
  );
  await assert.rejects(
    coordinator.publish("# Later", "event-2", "conversation-1", signal),
    /latched after synchronization failure/,
  );
  assert.equal(calls.posts.length, 1);
});

test("process restart adopts an identical stored cursor without posting again", async () => {
  const stored = cursor(4, "event-4", "# Stable\n", 9);
  const { coordinator, calls } = harness({ initialCursor: stored });

  await coordinator.publish("# Stable", "event-4", "conversation-1", signal);

  assert.equal(calls.posts.length, 0);
  assert.equal(calls.refreshes, 1);
  assert.deepEqual(coordinator.publicationCursor, stored);
});
