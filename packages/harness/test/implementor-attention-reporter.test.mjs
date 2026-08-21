import test from "node:test";
import assert from "node:assert/strict";
import { ImplementorAttentionReporter } from "../dist/implementor-attention-reporter.js";

function createReporter(fetch, retryDelaysMs = [0]) {
  return new ImplementorAttentionReporter({
    repoSlug: "owner/repo",
    lifecycleOpId: "start-op",
    hubUrl: "https://hub.example.test",
    headers: { "CF-Access-Client-Id": "test-id" },
    fetch,
    retryDelaysMs,
  });
}

test("completion reports retry transient failures with the same sequence", async () => {
  const calls = [];
  const reporter = createReporter(async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) throw new Error("ambiguous network failure");
    return new Response(null, { status: 204 });
  });

  assert.equal(await reporter.report(7), "accepted");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(
      call.url,
      "https://hub.example.test/api/envs/owner%2Frepo/implementor-attention/completions",
    );
    assert.equal(call.init.headers["X-Tiller-Lifecycle-Op-Id"], "start-op");
    assert.equal(call.init.headers["CF-Access-Client-Id"], "test-id");
    assert.equal(call.init.body, JSON.stringify({ sequence: 7 }));
  }

  await reporter.shutdown();
});

test("completion reports are serialized in sequence order", async () => {
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const started = [];
  const reporter = createReporter(async (_url, init) => {
    const { sequence } = JSON.parse(init.body);
    started.push(sequence);
    if (sequence === 1) await firstResponse;
    return new Response(null, { status: 204 });
  });

  const first = reporter.report(1);
  const second = reporter.report(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["accepted", "accepted"]);
  assert.deepEqual(started, [1, 2]);

  await reporter.shutdown();
});

test("forced abort cancels pending retries and rejects later reports", async () => {
  let signalAttempt;
  const attempted = new Promise((resolve) => { signalAttempt = resolve; });
  const reporter = createReporter(async () => {
    signalAttempt();
    return new Response(null, { status: 503 });
  }, [60_000]);

  const pending = reporter.report(1);
  await attempted;
  await reporter.abort();
  assert.equal(await pending, "aborted");
  assert.equal(await reporter.report(2), "aborted");
});

test("graceful shutdown drains an in-flight completion without abandoning it", async () => {
  let releaseResponse;
  let signalAttempt;
  const response = new Promise((resolve) => { releaseResponse = resolve; });
  const attempted = new Promise((resolve) => { signalAttempt = resolve; });
  const reporter = new ImplementorAttentionReporter({
    repoSlug: "demo-env",
    lifecycleOpId: "start-op",
    hubUrl: "https://hub.example.test",
    fetch: async () => {
      signalAttempt();
      await response;
      return new Response(null, { status: 204 });
    },
  });

  const pending = reporter.report(1);
  await attempted;
  const shutdown = reporter.shutdown();
  assert.equal(await Promise.race([
    shutdown.then(() => "settled"),
    new Promise((resolve) => setImmediate(() => resolve("pending"))),
  ]), "pending");
  releaseResponse();

  assert.equal(await pending, "accepted");
  await shutdown;
  assert.equal(await reporter.report(2), "aborted");
});
