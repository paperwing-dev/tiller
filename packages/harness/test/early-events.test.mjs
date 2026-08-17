import test from "node:test";
import assert from "node:assert/strict";
import {
  bufferOrEmitExit,
  bufferOrEmitOutput,
  createEarlyAgentEventState,
  flushBufferedExit,
  flushBufferedOutput,
} from "../dist/early-events.js";

test("bufferOrEmitOutput buffers until a listener is available", () => {
  const state = createEarlyAgentEventState();
  const emitted = [];

  bufferOrEmitOutput(state, "hello", false, (data) => emitted.push(data));
  assert.equal(state.pendingOutput, "hello");
  assert.deepEqual(emitted, []);

  flushBufferedOutput(state, true, (data) => emitted.push(data));
  assert.equal(state.pendingOutput, "");
  assert.deepEqual(emitted, ["hello"]);
});

test("bufferOrEmitOutput emits immediately when a listener already exists", () => {
  const state = createEarlyAgentEventState();
  const emitted = [];

  bufferOrEmitOutput(state, "hello", true, (data) => emitted.push(data));
  assert.equal(state.pendingOutput, "");
  assert.deepEqual(emitted, ["hello"]);
});

test("bufferOrEmitExit buffers until a listener is available", () => {
  const state = createEarlyAgentEventState();
  const emitted = [];

  bufferOrEmitExit(state, 7, false, (code) => emitted.push(code));
  assert.equal(state.pendingExitCode, 7);
  assert.deepEqual(emitted, []);

  flushBufferedExit(state, true, (code) => emitted.push(code));
  assert.equal(state.pendingExitCode, null);
  assert.deepEqual(emitted, [7]);
});

test("bufferOrEmitExit emits immediately when a listener already exists", () => {
  const state = createEarlyAgentEventState();
  const emitted = [];

  bufferOrEmitExit(state, 3, true, (code) => emitted.push(code));
  assert.equal(state.pendingExitCode, null);
  assert.deepEqual(emitted, [3]);
});
