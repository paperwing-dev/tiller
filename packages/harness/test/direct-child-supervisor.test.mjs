import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  DIRECT_CHILD_DEADLINE_MS,
  DIRECT_CHILD_KILL_GRACE_MS,
  DIRECT_CHILD_STATUS_POLL_MS,
  superviseDirectChild,
} from "../dist/planner/direct-child-supervisor.js";

class FakeChild extends EventEmitter {
  pid = 12345;
  stdout = null;
  stderr = null;

  kill() {
    return true;
  }

  close(code = 0, signal = null) {
    this.emit("close", code, signal);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("supervisor production limits are exactly 60 minutes, 15 seconds, and 5 seconds", () => {
  assert.equal(DIRECT_CHILD_DEADLINE_MS, 60 * 60_000);
  assert.equal(DIRECT_CHILD_STATUS_POLL_MS, 15_000);
  assert.equal(DIRECT_CHILD_KILL_GRACE_MS, 5_000);
});

test("supervisor returns normal completion and clears polling/deadline timers", async () => {
  const child = new FakeChild();
  let polls = 0;
  const outcomePromise = superviseDirectChild({
    spawnChild: () => child,
    isCancelled: async () => {
      polls += 1;
      return false;
    },
    statusPollMs: 10,
    deadlineMs: 25,
    killChild: () => assert.fail("completed child must not be killed"),
  });
  child.close(0);

  assert.deepEqual(await outcomePromise, { kind: "completed", exitCode: 0, signal: null });
  await wait(40);
  assert.equal(polls, 0);
});

test("supervisor reports synchronous and asynchronous spawn failures once", async () => {
  const sync = await superviseDirectChild({
    spawnChild: () => {
      throw new Error("sync spawn failure");
    },
    isCancelled: async () => false,
    deadlineMs: 20,
  });
  assert.equal(sync.kind, "spawn_failed");
  assert.match(sync.error.message, /sync spawn failure/);

  const child = new FakeChild();
  const asyncOutcome = superviseDirectChild({
    spawnChild: () => child,
    isCancelled: async () => false,
    deadlineMs: 20,
  });
  child.emit("error", new Error("async spawn failure"));
  child.close(1);
  const result = await asyncOutcome;
  assert.equal(result.kind, "spawn_failed");
  assert.match(result.error.message, /async spawn failure/);
});

test("post-spawn setup failures retain kill escalation until the child closes", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const child = new FakeChild();
  const signals = [];
  const outcome = superviseDirectChild({
    spawnChild: () => child,
    onSpawn: () => {
      throw new Error("stream setup failed");
    },
    isCancelled: async () => false,
    deadlineMs: 200,
    killGraceMs: 10,
    killChild: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") child.close(null, "SIGKILL");
    },
  });

  try {
    const result = await outcome;
    assert.equal(result.kind, "spawn_failed");
    assert.match(result.error.message, /stream setup failed/);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("supervisor ignores transient poll errors and cancels with SIGTERM", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const child = new FakeChild();
  const signals = [];
  let polls = 0;
  const outcome = superviseDirectChild({
    spawnChild: () => child,
    isCancelled: async () => {
      polls += 1;
      if (polls === 1) throw new Error("temporary callback failure");
      return true;
    },
    statusPollMs: 5,
    deadlineMs: 200,
    killGraceMs: 30,
    killChild: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.close(null, "SIGTERM"));
    },
  });

  try {
    assert.deepEqual(await outcome, { kind: "cancelled" });
    assert.ok(polls >= 2);
    assert.deepEqual(signals, ["SIGTERM"]);
    await wait(40);
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("deadline wins a cancellation race and escalates to SIGKILL after grace", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const child = new FakeChild();
  const signals = [];
  let releasePoll;
  const delayedCancellation = new Promise((resolve) => {
    releasePoll = resolve;
  });
  const outcome = superviseDirectChild({
    spawnChild: () => child,
    isCancelled: async () => await delayedCancellation,
    statusPollMs: 2,
    deadlineMs: 15,
    killGraceMs: 15,
    killChild: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") releasePoll(true);
      if (signal === "SIGKILL") child.close(null, "SIGKILL");
    },
  });

  try {
    assert.deepEqual(await outcome, { kind: "timed_out" });
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    child.emit("error", new Error("late event"));
    child.close(1);
    await wait(20);
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("child close during the grace period clears the pending kill escalation", async () => {
  const keepAlive = setTimeout(() => {}, 1_000);
  const child = new FakeChild();
  const signals = [];
  const outcome = superviseDirectChild({
    spawnChild: () => child,
    isCancelled: async () => false,
    statusPollMs: 100,
    deadlineMs: 10,
    killGraceMs: 30,
    killChild: (_child, signal) => {
      signals.push(signal);
      if (signal === "SIGTERM") queueMicrotask(() => child.close(null, "SIGTERM"));
    },
  });

  try {
    assert.deepEqual(await outcome, { kind: "timed_out" });
    await wait(45);
    assert.deepEqual(signals, ["SIGTERM"]);
  } finally {
    clearTimeout(keepAlive);
  }
});
