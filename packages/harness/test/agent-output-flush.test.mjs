import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../dist/agent.js";

const SLOW_OUTPUT_POLICY = {
  interactiveFlushMs: 10_000,
  bulkFlushMs: 10_000,
  bulkOutputBytes: 32 * 1024,
  maxBufferMs: 10_000,
  maxBufferBytes: 64 * 1024,
  inputEchoFlushMs: 8,
  inputEchoWindowMs: 100,
};

test("Agent flushes buffered terminal output before publishing process exit", async () => {
  const agent = new Agent(
    process.execPath,
    ["-e", "process.stdout.write('buffered-before-exit')"],
    process.cwd(),
    {},
    { inheritEnv: false, outputFlushPolicy: SLOW_OUTPUT_POLICY },
  );
  const events = [];
  agent.on("output", (data) => events.push({ type: "output", data }));

  const exitCode = await new Promise((resolve) => {
    agent.on("exit", (code) => {
      events.push({ type: "exit", code });
      resolve(code);
    });
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(events, [
    { type: "output", data: "buffered-before-exit" },
    { type: "exit", code: 0 },
  ]);
});

test("Agent applies the 100ms input-echo window to real input scheduling", async (t) => {
  const agent = new Agent(
    "/bin/sh",
    ["-c", "stty raw -echo; printf ready; exec sleep 30"],
    process.cwd(),
    {},
    { inheritEnv: false },
  );
  let exited = false;
  const exit = new Promise((resolve) => {
    agent.on("exit", (code) => {
      exited = true;
      resolve(code);
    });
  });
  t.after(() => {
    if (!exited) agent.kill("SIGKILL");
  });

  await new Promise((resolve) => {
    agent.on("output", (data) => {
      if (data.includes("ready")) resolve();
    });
  });

  const output = [];
  agent.on("output", (data) => output.push(data));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });

  await agent.writeInput([{ data: "x", delayMs: 0 }]);
  assert.equal(agent.inputEchoUntilMs, 1100);

  agent.handleFilteredOutput("echo");
  assert.equal(agent.flushTimerDueAtMs, 1001);
  t.mock.timers.tick(0);
  assert.deepEqual(output, []);
  t.mock.timers.tick(1);
  assert.deepEqual(output, ["echo"]);

  t.mock.timers.tick(99);
  agent.handleFilteredOutput("ordinary");
  assert.equal(agent.flushTimerDueAtMs, 1108);
  t.mock.timers.tick(7);
  assert.deepEqual(output, ["echo"]);
  t.mock.timers.tick(1);
  assert.deepEqual(output, ["echo", "ordinary"]);

  agent.kill();
  await exit;
});
