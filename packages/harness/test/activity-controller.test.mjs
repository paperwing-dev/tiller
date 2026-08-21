import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HarnessInputFencedError,
  InteractiveActivityController,
} from "../dist/activity-controller.js";
import {
  CodexForegroundActivityTracker,
  reportRuntimeDiagnostic,
  runtimeActivityForCodexNotification,
} from "../dist/activity-reporter.js";
import { writeHarnessDiagnostic } from "../dist/runtime-diagnostics.js";

function postHarnessControl(socketPath, path, body) {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(encoded),
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(responseBody),
      }));
    });
    request.on("error", reject);
    request.end(encoded);
  });
}

test("startup and a new generation remain conservatively working", async () => {
  const controller = new InteractiveActivityController();

  assert.deepEqual(controller.snapshot(), { status: "working", idleSince: null });
  await controller.beginGeneration("generation-1");
  assert.deepEqual(await controller.claimIdleStop(60_000), {
    status: "working",
    idleSince: null,
    eligible: false,
    remainingIdleMs: 60_000,
    reason: "working",
  });
});

test("idle-stop claims require the complete timeout and fence later input", async () => {
  let now = 1_000;
  const controller = new InteractiveActivityController({ now: () => now });
  await controller.beginGeneration("generation-1");
  await controller.reportActivity("working", "generation-1");
  assert.equal(await controller.reportActivity("idle", "generation-1"), true);

  now += 59_999;
  const early = await controller.claimIdleStop(60_000);
  assert.equal(early.eligible, false);
  assert.equal(early.remainingIdleMs, 1);
  assert.equal(early.reason, "insufficient_idle");

  now += 1;
  const claimed = await controller.claimIdleStop(60_000);
  assert.equal(claimed.eligible, true);
  assert.equal(typeof claimed.claimId, "string");
  assert.deepEqual(await controller.claimIdleStop(60_000), claimed);

  let delivered = false;
  await assert.rejects(
    controller.deliverInput(() => { delivered = true; }),
    HarnessInputFencedError,
  );
  assert.equal(delivered, false);

  await controller.releaseIdleStop(claimed.claimId);
  await controller.deliverInput(() => { delivered = true; });
  assert.equal(delivered, true);
  assert.deepEqual(controller.snapshot(), { status: "working", idleSince: null });
});

test("input and idle-stop races serialize without losing accepted input", async () => {
  let now = 100_000;
  const inputFirst = new InteractiveActivityController({ now: () => now });
  await inputFirst.beginGeneration("generation-1");
  await inputFirst.reportActivity("working", "generation-1");
  await inputFirst.reportActivity("idle", "generation-1");
  now += 60_000;

  const deliveries = [];
  const delivered = inputFirst.deliverInput(() => { deliveries.push("accepted"); });
  const rejectedClaim = inputFirst.claimIdleStop(60_000);
  await delivered;
  assert.equal((await rejectedClaim).eligible, false);
  assert.deepEqual(deliveries, ["accepted"]);

  const claimFirst = new InteractiveActivityController({ now: () => now });
  await claimFirst.beginGeneration("generation-2");
  await claimFirst.reportActivity("working", "generation-2");
  await claimFirst.reportActivity("idle", "generation-2");
  now += 60_000;
  const acceptedClaim = await claimFirst.claimIdleStop(60_000);
  assert.equal(acceptedClaim.eligible, true);
  await assert.rejects(
    claimFirst.deliverInput(() => { deliveries.push("lost"); }),
    HarnessInputFencedError,
  );
  assert.deepEqual(deliveries, ["accepted"]);
});

test("accepted input ignores a delayed completion until the provider starts the new turn", async () => {
  let now = 1_000;
  const controller = new InteractiveActivityController({ now: () => now });
  await controller.beginGeneration("generation-1");
  assert.equal(await controller.reportActivity("working", "generation-1"), true);
  assert.equal(await controller.reportActivity("idle", "generation-1"), true);

  now += 1_000;
  await controller.deliverInput(() => undefined);
  assert.equal(await controller.reportActivity("idle", "generation-1"), true);
  assert.deepEqual(controller.snapshot(), { status: "working", idleSince: null });
  assert.equal((await controller.claimIdleStop(60_000)).reason, "working");

  assert.equal(await controller.reportActivity("working", "generation-1"), true);
  assert.equal(await controller.reportActivity("idle", "generation-1"), true);
  assert.deepEqual(controller.snapshot(), { status: "idle", idleSince: now });
});

test("respawn preparation clears an expired idle window before the retry delay", async () => {
  let now = 0;
  const controller = new InteractiveActivityController({ now: () => now });
  await controller.beginGeneration("exited-generation");
  await controller.reportActivity("working", "exited-generation");
  await controller.reportActivity("idle", "exited-generation");
  now = 60_000;

  await controller.beginGeneration("pending-respawn-generation");
  assert.deepEqual(controller.snapshot(), { status: "working", idleSince: null });
  assert.equal((await controller.claimIdleStop(60_000)).eligible, false);
  assert.equal(await controller.reportActivity("idle", "exited-generation"), false);

  assert.equal(await controller.reportProcessExit("pending-respawn-generation"), true);
  assert.deepEqual(controller.snapshot(), { status: "idle", idleSince: now });
});

test("stale provider completion cannot idle a respawned process", async () => {
  const controller = new InteractiveActivityController();
  await controller.beginGeneration("old-generation");
  await controller.beginGeneration("new-generation");

  assert.equal(await controller.reportActivity("idle", "old-generation"), false);
  assert.deepEqual(controller.snapshot(), { status: "working", idleSince: null });
  assert.equal(await controller.reportActivity("working", "new-generation"), true);
  assert.equal(await controller.reportActivity("idle", "new-generation"), true);
  assert.equal(controller.snapshot().status, "idle");
});

test("only armed successful turns allocate completion sequences across provider respawns", async () => {
  const controller = new InteractiveActivityController();
  const completions = [];
  controller.on("completion", (sequence) => completions.push(sequence));

  await controller.beginGeneration("generation-1");
  assert.equal(await controller.reportActivity("idle", "generation-1"), true);
  assert.deepEqual(completions, []);

  await controller.reportActivity("working", "generation-1");
  await controller.reportActivity("idle", "generation-1");
  assert.deepEqual(completions, []);

  await controller.reportActivity("working", "generation-1");
  await controller.reportActivity("completed", "generation-1");
  await controller.reportActivity("completed", "generation-1");
  assert.deepEqual(completions, [1]);

  await controller.beginGeneration("generation-2");
  await controller.reportActivity("working", "generation-2");
  await controller.reportActivity("completed", "generation-2");
  await controller.reportProcessExit("generation-2");
  assert.deepEqual(completions, [1, 2]);
});

test("accepted harness activity transitions log only generation and state metadata", async () => {
  let now = 1_000;
  const diagnostics = [];
  const controller = new InteractiveActivityController({
    now: () => now,
    diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
    diagnosticTimestamp: () => "2026-08-14T12:00:00.000Z",
  });

  await controller.beginGeneration("generation-1");
  assert.equal(await controller.reportActivity("working", "stale-generation"), false);
  await controller.reportActivity("working", "generation-1");
  now = 2_000;
  await controller.reportActivity("completed", "generation-1");
  await controller.reportActivity("completed", "generation-1");
  await controller.deliverInput(() => undefined);

  assert.deepEqual(diagnostics.map(({ source, generation, previous, current, timestamp }) => ({
    source,
    generation,
    previous,
    current,
    timestamp,
  })), [
    {
      source: "generation_started",
      generation: "generation-1",
      previous: { status: "working", idleSince: null },
      current: { status: "working", idleSince: null },
      timestamp: "2026-08-14T12:00:00.000Z",
    },
    {
      source: "provider_working",
      generation: "generation-1",
      previous: { status: "working", idleSince: null },
      current: { status: "working", idleSince: null },
      timestamp: "2026-08-14T12:00:00.000Z",
    },
    {
      source: "provider_completed",
      generation: "generation-1",
      previous: { status: "working", idleSince: null },
      current: { status: "idle", idleSince: 2_000 },
      timestamp: "2026-08-14T12:00:00.000Z",
    },
    {
      source: "input_accepted",
      generation: "generation-1",
      previous: { status: "idle", idleSince: 2_000 },
      current: { status: "working", idleSince: null },
      timestamp: "2026-08-14T12:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(diagnostics).includes("stale-generation"), false);
});

test("Codex diagnostics use the private control socket instead of stderr", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tiller-diagnostic-control-test-"));
  const socketPath = join(tempRoot, "control.sock");
  const diagnostics = [];
  const controller = new InteractiveActivityController({
    socketPath,
    diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
  });
  t.after(async () => {
    await controller.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });
  await controller.start();
  await controller.beginGeneration("generation-1");
  diagnostics.length = 0;

  const sensitive = "PROMPT_OUTPUT_CREDENTIAL_TOKEN";
  const diagnostic = {
    component: "codex_lifecycle",
    event: "turn_completed",
    threadId: "root-thread",
    turnId: "turn-1",
    status: "completed",
    classification: "root",
    activity: "completed",
    timestamp: "2026-08-14T12:00:00.000Z",
    prompt: sensitive,
  };
  const originalConsoleError = console.error;
  const stderrWrites = [];
  console.error = (...values) => { stderrWrites.push(values); };
  try {
    assert.equal(await reportRuntimeDiagnostic(diagnostic, {
      socketPath,
      generation: "generation-1",
    }), true);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(stderrWrites, []);
  assert.deepEqual(diagnostics, [{
    component: "codex_lifecycle",
    event: "turn_completed",
    threadId: "root-thread",
    turnId: "turn-1",
    status: "completed",
    classification: "root",
    activity: "completed",
    timestamp: "2026-08-14T12:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(diagnostics).includes(sensitive), false);
  assert.equal(await reportRuntimeDiagnostic(diagnostic, {
    socketPath,
    generation: "stale-generation",
  }), false);
  assert.equal(diagnostics.length, 1);

  const invalid = await postHarnessControl(socketPath, "/diagnostic", {
    generation: "generation-1",
    diagnostic: { ...diagnostic, status: sensitive },
  });
  assert.equal(invalid.status, 400);
  assert.equal(diagnostics.length, 1);
});

test("a working provider signal supersedes an in-flight idle claim", async () => {
  let now = 0;
  const controller = new InteractiveActivityController({ now: () => now });
  await controller.beginGeneration("generation-1");
  await controller.reportActivity("working", "generation-1");
  await controller.reportActivity("idle", "generation-1");
  now = 60_000;
  const claim = await controller.claimIdleStop(60_000);
  assert.equal(claim.eligible, true);

  await controller.reportActivity("working", "generation-1");
  const confirmation = await controller.confirmIdleStop(claim.claimId);
  assert.equal(confirmation.eligible, false);
  assert.equal(confirmation.reason, "claim_superseded");
});

test("manual Stop fences input and only an exact owner comparison can replace its operation", async () => {
  const controller = new InteractiveActivityController();
  let releaseQuiescence;
  const calls = [];
  controller.setManualQuiesceHandler((opId) => {
    calls.push(opId);
    return new Promise((resolve) => { releaseQuiescence = resolve; });
  });

  const preparation = controller.prepareManualStop("stop-op-1");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    controller.deliverInput(() => undefined),
    HarnessInputFencedError,
  );
  await assert.rejects(
    controller.prepareManualStop("stop-op-2"),
    /different Stop operation/i,
  );
  await assert.rejects(
    controller.prepareManualStop("stop-op-2", "stale-owner"),
    /different Stop operation/i,
  );
  const replacement = controller.prepareManualStop("stop-op-2", "stop-op-1");

  releaseQuiescence();
  assert.deepEqual(await preparation, {
    status: "working",
    idleSince: null,
    opId: "stop-op-1",
  });
  assert.deepEqual(await replacement, {
    status: "working",
    idleSince: null,
    opId: "stop-op-2",
  });
  assert.deepEqual(calls, ["stop-op-1"]);
});

test("manual Stop conflicts expose only the exact owner needed for replacement", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "tiller-activity-controller-test-"));
  const socketPath = join(tempRoot, "control.sock");
  const controller = new InteractiveActivityController({ socketPath });
  controller.setManualQuiesceHandler(() => undefined);
  t.after(async () => {
    await controller.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });
  await controller.start();

  assert.equal((await postHarnessControl(socketPath, "/prepare-stop", {
    opId: "stop-op-1",
  })).status, 200);
  assert.deepEqual(await postHarnessControl(socketPath, "/prepare-stop", {
    opId: "stop-op-2",
  }), {
    status: 409,
    body: {
      ok: false,
      code: "manual_stop_conflict",
      ownerOpId: "stop-op-1",
      error: "A different Stop operation already owns the input fence.",
    },
  });
  assert.equal((await postHarnessControl(socketPath, "/prepare-stop", {
    opId: "stop-op-2",
    replaceOpId: "stop-op-1",
  })).status, 200);
});

test("manual Stop can wait for provider idle or process exit", async () => {
  const controller = new InteractiveActivityController();
  await controller.beginGeneration("generation-1");
  const idle = controller.waitForIdle(1_000);
  await controller.reportProcessExit("generation-1");
  await idle;
  assert.equal(controller.snapshot().status, "idle");
});

test("manual Stop terminates an agent turn that ignores graceful abort", async () => {
  const controller = new InteractiveActivityController();
  await controller.beginGeneration("generation-1");
  let terminationCount = 0;

  await controller.quiesceForManualStop({
    gracefulTimeoutMs: 1,
    terminationTimeoutMs: 100,
    terminate: async () => {
      terminationCount += 1;
      await controller.reportProcessExit("generation-1");
    },
  });

  assert.equal(terminationCount, 1);
  assert.equal(controller.snapshot().status, "idle");
});

test("Codex uses only authoritative turn lifecycle notifications", () => {
  assert.equal(runtimeActivityForCodexNotification("turn/started", {}), "working");
  assert.equal(
    runtimeActivityForCodexNotification("turn/completed", { turn: { status: "completed" } }),
    "completed",
  );
  for (const status of ["interrupted", "failed"]) {
    assert.equal(
      runtimeActivityForCodexNotification("turn/completed", { turn: { status } }),
      "idle",
    );
  }
  assert.equal(
    runtimeActivityForCodexNotification("turn/completed", { turn: { status: "inProgress" } }),
    null,
  );
  assert.equal(runtimeActivityForCodexNotification("item/completed", {}), null);
});

test("Codex completion follows sequential foreground roots and excludes child threads", () => {
  const tracker = new CodexForegroundActivityTracker();

  assert.equal(tracker.handleNotification("turn/started", { threadId: "unknown" }), null);

  assert.equal(tracker.handleNotification("thread/started", {
    thread: { id: "lead", parentThreadId: null },
  }), null);
  assert.equal(tracker.handleNotification("thread/started", {
    thread: { id: "child", parentThreadId: "lead" },
  }), null);
  assert.equal(tracker.handleNotification("turn/started", { threadId: "lead" }), "working");
  assert.equal(tracker.handleNotification("turn/started", { threadId: "child" }), null);
  assert.equal(
    tracker.handleNotification("turn/completed", {
      threadId: "child",
      turn: { status: "completed" },
    }),
    null,
  );
  assert.equal(
    tracker.handleNotification("turn/completed", {
      threadId: "lead",
      turn: { status: "completed" },
    }),
    "completed",
  );

  assert.equal(tracker.handleNotification("thread/started", {
    thread: { id: "next-lead", parentThreadId: null },
  }), null);
  assert.equal(
    tracker.handleNotification("turn/started", { threadId: "next-lead" }),
    "working",
  );
  assert.equal(
    tracker.handleNotification("turn/completed", {
      threadId: "next-lead",
      turn: { status: "failed" },
    }),
    "idle",
  );
});

test("Codex lifecycle diagnostics serialize selected fields without notification payloads", () => {
  const diagnostics = [];
  const tracker = new CodexForegroundActivityTracker({
    diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
    diagnosticTimestamp: () => "2026-08-14T12:00:00.000Z",
  });
  const sensitive = "PROMPT_OUTPUT_CREDENTIAL_TOKEN";

  tracker.handleNotification("thread/started", {
    thread: { id: "root-thread", parentThreadId: null, status: { type: "active" } },
    prompt: sensitive,
    terminalOutput: sensitive,
  });
  tracker.handleNotification("turn/started", {
    threadId: "root-thread",
    turn: {
      id: "turn-1",
      status: "inProgress",
      items: [{ text: sensitive }],
    },
    credentials: sensitive,
  });
  tracker.handleNotification("turn/completed", {
    threadId: "root-thread",
    turn: {
      id: "turn-1",
      status: "completed",
      items: [{ text: sensitive }],
    },
    token: sensitive,
  });

  assert.deepEqual(diagnostics.map((diagnostic) => ({
    event: diagnostic.event,
    threadId: diagnostic.threadId,
    status: diagnostic.status,
    classification: diagnostic.classification,
    activity: diagnostic.activity,
  })), [
    {
      event: "thread_started",
      threadId: "root-thread",
      status: "active",
      classification: "root",
      activity: "ignored",
    },
    {
      event: "thread_classified",
      threadId: "root-thread",
      status: "active",
      classification: "root",
      activity: "ignored",
    },
    {
      event: "turn_started",
      threadId: "root-thread",
      status: "inProgress",
      classification: "root",
      activity: "working",
    },
    {
      event: "turn_completed",
      threadId: "root-thread",
      status: "completed",
      classification: "root",
      activity: "completed",
    },
  ]);

  const originalConsoleError = console.error;
  let serialized = "";
  console.error = (value) => { serialized = String(value); };
  try {
    writeHarnessDiagnostic(diagnostics.at(-1));
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(JSON.parse(serialized), diagnostics.at(-1));
  assert.equal(JSON.stringify(diagnostics).includes(sensitive), false);
});

test("Codex lifecycle diagnostics cannot interrupt activity tracking", () => {
  const diagnostics = [];
  const fallbackClockTracker = new CodexForegroundActivityTracker({
    diagnosticSink: (diagnostic) => diagnostics.push(diagnostic),
    diagnosticTimestamp: () => { throw new Error("clock unavailable"); },
  });
  assert.equal(fallbackClockTracker.registerThread({
    id: "root-thread",
    parentThreadId: null,
  }), "root");
  assert.equal(
    fallbackClockTracker.handleNotification("turn/started", { threadId: "root-thread" }),
    "working",
  );
  assert.equal(
    fallbackClockTracker.handleNotification("turn/completed", {
      threadId: "root-thread",
      turn: { status: "completed" },
    }),
    "completed",
  );
  assert.equal(diagnostics.length, 3);
  assert.ok(diagnostics.every((diagnostic) => !Number.isNaN(Date.parse(diagnostic.timestamp))));

  const throwingSinkTracker = new CodexForegroundActivityTracker({
    diagnosticSink: () => { throw new Error("sink unavailable"); },
  });
  assert.equal(throwingSinkTracker.registerThread({
    id: "next-root",
    parentThreadId: null,
  }), "root");
  assert.equal(
    throwingSinkTracker.handleNotification("turn/started", { threadId: "next-root" }),
    "working",
  );
  assert.equal(
    throwingSinkTracker.handleNotification("turn/completed", {
      threadId: "next-root",
      turn: { status: "failed" },
    }),
    "idle",
  );
});
