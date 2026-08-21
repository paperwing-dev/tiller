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

const TEST_TERMINAL_PALETTE = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  selectionBackground: "#dbeafe",
  selectionForeground: "#24292f",
  ansi: Array.from({ length: 16 }, () => "#24292f"),
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

test("Agent answers palette probes without forwarding them as terminal output", async () => {
  const query = "\x1b]11;?\x07";
  const reply = "\x1b]11;#ffffff\x07";
  const script = `
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (!input.includes(${JSON.stringify(reply)})) return;
      process.stdout.write("palette-ready");
      process.exit(0);
    });
    process.stdout.write(${JSON.stringify(query)});
    setTimeout(() => process.exit(2), 2_000);
  `;
  const agent = new Agent(
    process.execPath,
    ["-e", script],
    process.cwd(),
    {},
    { inheritEnv: false, terminalPalette: TEST_TERMINAL_PALETTE },
  );
  let output = "";
  agent.on("output", (data) => {
    output += data;
  });

  const exitCode = await new Promise((resolve) => agent.on("exit", resolve));

  assert.equal(exitCode, 0);
  assert.equal(output, "palette-ready");
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
