import test from "node:test";
import assert from "node:assert/strict";
import {
  BULK_FLUSH_MS,
  BULK_OUTPUT_BYTES,
  INPUT_ECHO_FLUSH_MS,
  INTERACTIVE_FLUSH_MS,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_MS,
  decideOutputFlush,
  resolveBulkFlushWindow,
} from "../dist/output-flush-policy.js";

test("continuous autonomous output defaults to 16ms with explicit overrides", () => {
  assert.equal(resolveBulkFlushWindow(undefined), 16);
  assert.equal(resolveBulkFlushWindow("500"), 500);
  assert.equal(resolveBulkFlushWindow("250"), 250);
  assert.equal(resolveBulkFlushWindow("16"), 16);
  assert.equal(resolveBulkFlushWindow("8"), 8);
  assert.equal(resolveBulkFlushWindow("7"), 16);
});

test("decideOutputFlush publishes isolated autonomous chunks within 8ms", () => {
  assert.equal(INTERACTIVE_FLUSH_MS, 8);
  for (const chunkBytes of [12, 1024]) {
    assert.deepEqual(
      decideOutputFlush({
        bufferBytes: chunkBytes,
        chunkBytes,
        nowMs: 1000,
        bufferStartedAtMs: 1000,
        previousOutputAtMs: null,
      }),
      {
        flushNow: false,
        flushDelayMs: INTERACTIVE_FLUSH_MS,
      },
    );
  }
});

test("decideOutputFlush coalesces continuous tiny chunks for up to 16ms", () => {
  assert.equal(BULK_FLUSH_MS, 16);
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 120,
      chunkBytes: 12,
      nowMs: 1005,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1000,
    }),
    {
      flushNow: false,
      flushDelayMs: BULK_FLUSH_MS,
    },
  );
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 12,
      chunkBytes: 12,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: null,
      inputEchoActive: true,
    }),
    {
      flushNow: false,
      flushDelayMs: INPUT_ECHO_FLUSH_MS,
    },
  );
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 120,
      chunkBytes: 12,
      nowMs: 1005,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1000,
      inputEchoActive: true,
    }),
    {
      flushNow: false,
      flushDelayMs: INPUT_ECHO_FLUSH_MS,
    },
  );
});

test("decideOutputFlush flushes large buffers immediately", () => {
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: BULK_OUTPUT_BYTES,
      chunkBytes: BULK_OUTPUT_BYTES,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: null,
    }),
    { flushNow: true },
  );

  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: MAX_BUFFER_BYTES,
      chunkBytes: 1,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 999,
    }),
    { flushNow: true },
  );
});

test("a 1 MiB redraw is not split below the 32 KiB coalescing threshold", () => {
  const chunkBytes = 4 * 1024;
  let bufferBytes = 0;
  let immediateFlushes = 0;

  for (let offset = 0; offset < 1024 * 1024; offset += chunkBytes) {
    bufferBytes += chunkBytes;
    const decision = decideOutputFlush({
      bufferBytes,
      chunkBytes,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1000,
    });
    if (decision.flushNow) {
      immediateFlushes += 1;
      bufferBytes = 0;
    }
  }

  assert.equal(BULK_OUTPUT_BYTES, 32 * 1024);
  assert.equal(immediateFlushes, 32);
});

test("decideOutputFlush enforces the hard max-age ceiling", () => {
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 120,
      chunkBytes: 12,
      nowMs: 1000 + MAX_BUFFER_MS,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1000 + MAX_BUFFER_MS - 10,
    }),
    { flushNow: true },
  );

  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 120,
      chunkBytes: 12,
      nowMs: 1000 + MAX_BUFFER_MS - 10,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1000 + MAX_BUFFER_MS - 15,
    }),
    {
      flushNow: false,
      flushDelayMs: BULK_FLUSH_MS,
    },
  );
});

test("decideOutputFlush caps isolated output at faster maximum-age overrides", () => {
  for (const maxBufferMs of [8, 16]) {
    const policy = {
      interactiveFlushMs: 250,
      bulkFlushMs: maxBufferMs,
      bulkOutputBytes: 32 * 1024,
      maxBufferMs,
      maxBufferBytes: 64 * 1024,
      inputEchoFlushMs: 8,
      inputEchoWindowMs: 100,
    };
    assert.deepEqual(
      decideOutputFlush({
        bufferBytes: 1024,
        chunkBytes: 1024,
        nowMs: 1000,
        bufferStartedAtMs: 1000,
        previousOutputAtMs: null,
      }, policy),
      { flushNow: false, flushDelayMs: maxBufferMs },
    );
  }
});

test("decideOutputFlush accepts a slower durable terminal policy", () => {
  const policy = {
    interactiveFlushMs: 100,
    bulkFlushMs: 100,
    bulkOutputBytes: 32 * 1024,
    maxBufferMs: 100,
    maxBufferBytes: 64 * 1024,
    inputEchoFlushMs: 8,
    inputEchoWindowMs: 100,
  };
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 200,
      chunkBytes: 100,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: null,
    }, policy),
    { flushNow: false, flushDelayMs: 100 },
  );
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 500,
      chunkBytes: 500,
      nowMs: 1000,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 999,
      inputEchoActive: true,
    }, policy),
    { flushNow: false, flushDelayMs: 8 },
  );
  assert.deepEqual(
    decideOutputFlush({
      bufferBytes: 32 * 1024,
      chunkBytes: 100,
      nowMs: 1050,
      bufferStartedAtMs: 1000,
      previousOutputAtMs: 1040,
    }, policy),
    { flushNow: true },
  );
});
