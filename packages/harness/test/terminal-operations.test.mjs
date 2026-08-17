import test from "node:test";
import assert from "node:assert/strict";
import HeadlessPackage from "@xterm/headless";
import {
  DSR_DEADLINE_MS,
  MAX_PARSER_ITEM_BYTES,
  PARSER_PAUSE_BYTES,
  TerminalOperationQueue,
  parseWhitelistedCprReplies,
  splitParserItems,
} from "../dist/terminal-operations.js";
import { CursorPositionDsrFilter } from "../dist/vt-dsr-filter.js";

class FakeHeadless {
  callbacks = [];
  dataHandler = () => {};
  events = [];

  onData(handler) {
    this.dataHandler = handler;
    return { dispose() {} };
  }

  write(data, callback) {
    this.events.push(["write", data]);
    this.callbacks.push(callback);
  }

  resize(cols, rows) {
    this.events.push(["resize", cols, rows]);
  }

  release(reply) {
    if (reply) this.dataHandler(reply);
    this.callbacks.shift()?.();
  }

  dispose() {}
}

function createQueue() {
  const headless = new FakeHeadless();
  const events = [];
  const queue = new TerminalOperationQueue(
    {
      write: (data) => events.push(["pty-write", data]),
      resize: (cols, rows) => events.push(["pty-resize", cols, rows]),
      pauseOutput: () => events.push(["pty-pause"]),
      resumeOutput: () => events.push(["pty-resume"]),
    },
    { cols: 80, rows: 24 },
    {
      createHeadless: () => headless,
      onFilteredOutput: (data) => events.push(["output", data]),
    },
  );
  return { queue, headless, events };
}

async function runRealHeadless(output, dimensions = { cols: 20, rows: 4 }) {
  const events = [];
  const queue = new TerminalOperationQueue(
    {
      write: (data) => events.push(["pty-write", data]),
      resize: () => {},
    },
    dimensions,
    { onFilteredOutput: (data) => events.push(["output", data]) },
  );
  queue.enqueueOutput(output);
  await queue.whenIdle();
  await queue.close();
  return events;
}

function writeHeadless(terminal, data) {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function snapshotHeadless(terminal) {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    type: buffer.type,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      return {
        text: line?.translateToString(false) ?? "",
        wrapped: line?.isWrapped ?? false,
      };
    }),
  };
}

function seededOutputChunks(value, initialSeed) {
  const chunks = [];
  let seed = initialSeed >>> 0;
  let offset = 0;
  while (offset < value.length) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    let end = Math.min(value.length, offset + 1 + (seed % 23));
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (
      end < value.length &&
      previous >= 0xd800 && previous <= 0xdbff &&
      next >= 0xdc00 && next <= 0xdfff
    ) {
      end += 1;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function randomizeOutputBoundaries(operations, seed) {
  return operations.flatMap((operation, index) => operation.type === "output"
    ? seededOutputChunks(operation.data, seed + index).map((data) => ({ type: "output", data }))
    : [operation]);
}

async function runSerializedReference(operations, initialDimensions) {
  const terminal = new HeadlessPackage.Terminal({
    ...initialDimensions,
    scrollback: 0,
    allowProposedApi: true,
  });
  const filter = new CursorPositionDsrFilter();
  const replies = [];
  const filtered = [];
  terminal.onData((data) => replies.push(...parseWhitelistedCprReplies(data)));
  try {
    for (const operation of operations) {
      if (operation.type === "resize") {
        terminal.resize(operation.cols, operation.rows);
        continue;
      }
      const beforeReplies = replies.length;
      const result = filter.pushWithReport(operation.data);
      filtered.push(result.output);
      await writeHeadless(terminal, operation.data);
      assert.equal(replies.length - beforeReplies, result.removedCount);
    }
    filtered.push(filter.end());
    return {
      screen: snapshotHeadless(terminal),
      replies,
      filtered: filtered.join(""),
    };
  } finally {
    terminal.dispose();
  }
}

async function runTwoLaneHeadless(operations, initialDimensions) {
  const terminal = new HeadlessPackage.Terminal({
    ...initialDimensions,
    scrollback: 0,
    allowProposedApi: true,
  });
  const replies = [];
  const filtered = [];
  const queue = new TerminalOperationQueue(
    {
      write: (data) => replies.push(data),
      resize: () => {},
    },
    initialDimensions,
    {
      createHeadless: () => terminal,
      onFilteredOutput: (data) => filtered.push(data),
    },
  );
  for (const operation of operations) {
    if (operation.type === "resize") {
      await queue.enqueueResize(operation.cols, operation.rows);
    } else {
      queue.enqueueOutput(operation.data);
    }
  }
  await queue.whenIdle();
  const result = {
    screen: snapshotHeadless(terminal),
    replies,
    filtered: filtered.join(""),
  };
  await queue.close();
  return result;
}

test("DSR blocks later controls while filtered output is delivered immediately", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("hello\x1b[6n");
  const resized = queue.enqueueResize(100, 40);
  const input = queue.enqueueInput([{ data: "x", delayMs: 0 }]);

  assert.deepEqual(headless.events, [["write", "hello\x1b[6n"]]);
  assert.deepEqual(events, [["output", "hello"]]);

  headless.release("\x1b[4;6R");
  await Promise.all([resized, input]);

  assert.deepEqual(events, [
    ["output", "hello"],
    ["pty-write", "\x1b[4;6R"],
    ["pty-resize", 100, 40],
    ["pty-write", "x"],
  ]);
  assert.deepEqual(headless.events, [
    ["write", "hello\x1b[6n"],
    ["resize", 100, 40],
  ]);
});

test("ordinary input overtakes unrelated parser backlog", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("redraw backlog");

  await queue.enqueueInput([{ data: "x", delayMs: 0 }]);

  assert.deepEqual(events, [
    ["output", "redraw backlog"],
    ["pty-write", "x"],
  ]);
  assert.deepEqual(headless.events, [["write", "redraw backlog"]]);
  headless.release();
  await queue.whenIdle();
});

test("reentrant filtered-output listeners can enqueue input without waiting for parsing", async () => {
  const headless = new FakeHeadless();
  const events = [];
  let queue;
  queue = new TerminalOperationQueue(
    {
      write: (data) => events.push(["pty-write", data]),
      resize: () => {},
    },
    { cols: 80, rows: 24 },
    {
      createHeadless: () => headless,
      onFilteredOutput: (data) => {
        events.push(["output", data]);
        void queue.enqueueInput([{ data: "reentrant", delayMs: 0 }]);
      },
    },
  );

  queue.enqueueOutput("redraw");
  assert.deepEqual(events, [
    ["output", "redraw"],
    ["pty-write", "reentrant"],
  ]);
  headless.release();
  await queue.whenIdle();
});

test("a reentrant DSR barrier replies before the next delayed input fragment", async () => {
  const headless = new FakeHeadless();
  const events = [];
  let queue;
  queue = new TerminalOperationQueue(
    {
      write: (data) => {
        events.push(["pty-write", data]);
        if (data === "hello") queue.enqueueOutput("\x1b[6n");
      },
      resize: () => {},
    },
    { cols: 80, rows: 24 },
    {
      createHeadless: () => headless,
      onFilteredOutput: () => {},
    },
  );

  const input = queue.enqueueInput([
    { data: "hello", delayMs: 0 },
    { data: "\r", delayMs: 1 },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(events, [["pty-write", "hello"]]);
  headless.release("\x1b[1;1R");
  await input;
  assert.deepEqual(events, [
    ["pty-write", "hello"],
    ["pty-write", "\x1b[1;1R"],
    ["pty-write", "\r"],
  ]);
});

test("submitted-text fragments form one operation boundary before later terminal work", async () => {
  const { queue, headless, events } = createQueue();
  const input = queue.enqueueInput(
    [
      { data: "hello", delayMs: 0 },
      { data: "\r", delayMs: 10 },
    ],
    { cols: 90, rows: 30 },
  );
  const resize = queue.enqueueResize(120, 50);
  const laterInput = queue.enqueueInput([{ data: "later", delayMs: 0 }]);

  await Promise.all([input, resize, laterInput]);
  assert.deepEqual(events, [
    ["pty-resize", 90, 30],
    ["pty-write", "hello"],
    ["pty-write", "\r"],
    ["pty-resize", 120, 50],
    ["pty-write", "later"],
  ]);
  assert.deepEqual(headless.events, [
    ["resize", 90, 30],
    ["resize", 120, 50],
  ]);
});

test("adjacent pending resizes coalesce without crossing input", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("hold\x1b[6n");
  const first = queue.enqueueResize(90, 30);
  const second = queue.enqueueResize(100, 35);
  const input = queue.enqueueInput([{ data: "i", delayMs: 0 }]);
  const third = queue.enqueueResize(110, 40);
  headless.release("\x1b[1;5R");

  await Promise.all([first, second, input, third]);
  assert.deepEqual(events, [
    ["output", "hold"],
    ["pty-write", "\x1b[1;5R"],
    ["pty-resize", 100, 35],
    ["pty-write", "i"],
    ["pty-resize", 110, 40],
  ]);
});

test("identical resize and input dimensions do not touch the PTY twice", async () => {
  const { queue, headless, events } = createQueue();

  await queue.enqueueResize(80, 24);
  await queue.enqueueInput([{ data: "a", delayMs: 0 }], { cols: 80, rows: 24 });
  await queue.enqueueResize(100, 35);
  await queue.enqueueInput([{ data: "b", delayMs: 0 }], { cols: 100, rows: 35 });
  await queue.enqueueResize(100, 35);

  assert.deepEqual(events, [
    ["pty-write", "a"],
    ["pty-resize", 100, 35],
    ["pty-write", "b"],
  ]);
  assert.deepEqual(headless.events, [
    ["resize", 100, 35],
  ]);
});

test("a replacement queue repairs its new PTY even when the browser size is unchanged", async () => {
  const first = createQueue();
  await first.queue.enqueueInput([{ data: "first", delayMs: 0 }], { cols: 100, rows: 35 });
  assert.equal(first.events.filter(([event]) => event === "pty-resize").length, 1);

  // A harness socket can outlive its Agent. The replacement queue starts from
  // the replacement PTY's real dimensions rather than stale Hub state.
  const replacement = createQueue();
  await replacement.queue.enqueueInput(
    [{ data: "replacement", delayMs: 0 }],
    { cols: 100, rows: 35 },
  );
  assert.equal(replacement.events.filter(([event]) => event === "pty-resize").length, 1);

  for (let index = 0; index < 25; index += 1) {
    await replacement.queue.enqueueInput(
      [{ data: String(index), delayMs: 0 }],
      { cols: 100, rows: 35 },
    );
  }
  assert.equal(replacement.events.filter(([event]) => event === "pty-resize").length, 1);
  assert.equal(replacement.headless.events.filter(([event]) => event === "resize").length, 1);
});

test("abort is priority and invalidates a delayed input fragment", async () => {
  const { queue, events } = createQueue();
  const input = queue.enqueueInput([
    { data: "hello", delayMs: 0 },
    { data: "\r", delayMs: 20 },
  ]);
  queue.abort();

  await assert.rejects(input, /Aborted/);
  assert.deepEqual(events, [
    ["pty-write", "hello"],
    ["pty-write", "\x03"],
  ]);
});

test("abort stays synchronous while parser work continues", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("hold");
  queue.abort();

  headless.release();
  await queue.whenIdle();

  assert.deepEqual(events, [
    ["output", "hold"],
    ["pty-write", "\x03"],
  ]);
});

test("real headless xterm emits accurate Unicode-aware cursor positions", async () => {
  assert.deepEqual(await runRealHeadless("界e\u0301\x1b[6n"), [
    ["output", "界e\u0301"],
    ["pty-write", "\x1b[1;4R"],
  ]);
});

test("real headless xterm tracks emoji, wide wrapping, alternate screen, and scroll regions", async () => {
  assert.deepEqual(await runRealHeadless("😀e\u0301\x1b[6n"), [
    ["output", "😀e\u0301"],
    ["pty-write", "\x1b[1;3R"],
  ]);
  assert.deepEqual(await runRealHeadless("界界A\x1b[6n", { cols: 4, rows: 4 }), [
    ["output", "界界A"],
    ["pty-write", "\x1b[2;2R"],
  ]);
  assert.deepEqual(await runRealHeadless("\x1b[?1049h\x1b[3;5H\x1b[6n", { cols: 20, rows: 5 }), [
    ["output", "\x1b[?1049h\x1b[3;5H"],
    ["pty-write", "\x1b[3;5R"],
  ]);
  assert.deepEqual(await runRealHeadless("\x1b[2;4r\x1b[4;1Hline\n\x1b[6n", { cols: 20, rows: 5 }), [
    ["output", "\x1b[2;4r\x1b[4;1Hline\n"],
    ["pty-write", "\x1b[4;5R"],
  ]);
});

test("two-lane parsing matches the serialized reference across randomized VT boundaries", async () => {
  const initialDimensions = { cols: 12, rows: 5 };
  const fixture = [
    {
      type: "output",
      data: "\x1b[31mwide:界😀e\u0301-wrap\x1b[0m\r\nsecond\x1b[6n",
    },
    { type: "resize", cols: 9, rows: 4 },
    {
      type: "output",
      data: "\x1b[?1049h\x1b[2J\x1b[2;3Halt界\x1b[?6n",
    },
    {
      type: "output",
      data: "\x1b[?1049l\x1b[2;4r\x1b[4;1Hone\ntwo\nthree\x1b[6n",
    },
  ];

  for (let seed = 1; seed <= 12; seed += 1) {
    const operations = randomizeOutputBoundaries(fixture, seed);
    const expected = await runSerializedReference(operations, initialDimensions);
    const actual = await runTwoLaneHeadless(operations, initialDimensions);

    assert.deepEqual(actual, expected, `seed ${seed}`);
    assert.equal(actual.replies.length, 3);
    assert.match(actual.filtered, /wide:界😀e\u0301-wrap/);
  }
});

test("multiple DSR requests require the exact number of ordered CPR replies", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("a\x1b[6nb\x1b[?6nc");
  const input = queue.enqueueInput([{ data: "later", delayMs: 0 }]);
  headless.release("\x1b[1;2R\x1b[?1;3R");
  await input;

  assert.deepEqual(events, [
    ["output", "abc"],
    ["pty-write", "\x1b[1;2R"],
    ["pty-write", "\x1b[?1;3R"],
    ["pty-write", "later"],
  ]);
});

test("a CPR reply mismatch faults later input and resize but leaves abort available", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("a\x1b[6n\x1b[6n");
  const input = queue.enqueueInput([{ data: "later", delayMs: 0 }]);
  const resize = queue.enqueueResize(100, 40);
  headless.release("\x1b[1;2R");

  await assert.rejects(input, /Terminal protocol fault.*reply mismatch/);
  await assert.rejects(resize, /Terminal protocol fault.*reply mismatch/);
  await assert.rejects(
    queue.enqueueInput([{ data: "new", delayMs: 0 }]),
    /abort remains available/,
  );
  queue.abort();
  assert.deepEqual(events, [
    ["output", "a"],
    ["pty-write", "\x03"],
  ]);
});

test("a DSR deadline starts only when its parser item begins", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { queue, headless } = createQueue();
  queue.enqueueOutput("legitimate parser backlog");
  queue.enqueueOutput("\x1b[6n");
  const input = queue.enqueueInput([{ data: "later", delayMs: 0 }]);
  let outcome = "pending";
  void input.then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; },
  );

  // Waiting behind ordinary parser work consumes none of the DSR budget.
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(outcome, "pending");

  headless.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(headless.events.at(-1), ["write", "\x1b[6n"]);

  t.mock.timers.tick(DSR_DEADLINE_MS - 1);
  await Promise.resolve();
  assert.equal(outcome, "pending");

  t.mock.timers.tick(1);
  await assert.rejects(input, /cursor-position response timed out after 2000ms/);
  assert.equal(outcome, "rejected");
});

test("a headless parser exception faults later controls but leaves abort available", async () => {
  class ThrowingHeadless extends FakeHeadless {
    write() {
      throw new Error("synthetic parser failure");
    }
  }

  const headless = new ThrowingHeadless();
  const events = [];
  const queue = new TerminalOperationQueue(
    {
      write: (data) => events.push(["pty-write", data]),
      resize: (cols, rows) => events.push(["pty-resize", cols, rows]),
    },
    { cols: 80, rows: 24 },
    {
      createHeadless: () => headless,
      onFilteredOutput: (data) => events.push(["output", data]),
    },
  );

  queue.enqueueOutput("redraw");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    queue.enqueueInput([{ data: "later", delayMs: 0 }]),
    /Terminal protocol fault.*synthetic parser failure/,
  );
  await assert.rejects(queue.enqueueResize(100, 40), /abort remains available/);
  queue.abort();
  assert.deepEqual(events, [
    ["output", "redraw"],
    ["pty-write", "\x03"],
  ]);
});

test("output after a parser fault remains deliverable and cannot strand close", async () => {
  class ThrowingHeadless extends FakeHeadless {
    write() {
      throw new Error("synthetic parser failure");
    }
  }

  const headless = new ThrowingHeadless();
  const events = [];
  const queue = new TerminalOperationQueue(
    {
      write: (data) => events.push(["pty-write", data]),
      resize: () => {},
    },
    { cols: 80, rows: 24 },
    {
      createHeadless: () => headless,
      onFilteredOutput: (data) => events.push(["output", data]),
    },
  );

  queue.enqueueOutput("before-fault");
  await new Promise((resolve) => setImmediate(resolve));
  queue.enqueueOutput("after-fault\x1b[6n");

  await queue.close();
  assert.deepEqual(events, [
    ["output", "before-fault"],
    ["output", "after-fault"],
  ]);
});

test("headless resize markers stay between output observed before and after PTY resize", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("before");
  await queue.enqueueResize(100, 40);
  queue.enqueueOutput("after");

  assert.deepEqual(events, [
    ["output", "before"],
    ["pty-resize", 100, 40],
    ["output", "after"],
  ]);
  assert.deepEqual(headless.events, [["write", "before"]]);
  headless.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(headless.events, [
    ["write", "before"],
    ["resize", 100, 40],
    ["write", "after"],
  ]);
  headless.release();
  await queue.whenIdle();
});

test("large parser events are UTF-16-safe and bounded by 64 KiB", () => {
  const source = `${"a".repeat(MAX_PARSER_ITEM_BYTES - 2)}😀${"界".repeat(30_000)}`;
  const chunks = splitParserItems(source);
  assert.equal(chunks.join(""), source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= MAX_PARSER_ITEM_BYTES));
  assert.ok(chunks.every((chunk) => {
    const last = chunk.charCodeAt(chunk.length - 1);
    return !(last >= 0xd800 && last <= 0xdbff);
  }));
});

test("a DSR request split across parser items keeps its corresponding barrier", async () => {
  const { queue, headless, events } = createQueue();
  const prefix = "a".repeat(MAX_PARSER_ITEM_BYTES - 2);
  queue.enqueueOutput(`${prefix}\x1b[6n`);
  const input = queue.enqueueInput([{ data: "later", delayMs: 0 }]);

  headless.release();
  await new Promise((resolve) => setImmediate(resolve));
  headless.release("\x1b[1;1R");
  await input;
  assert.equal(events[0][0], "output");
  assert.equal(events[0][1], prefix);
  assert.deepEqual(events.slice(1), [
    ["pty-write", "\x1b[1;1R"],
    ["pty-write", "later"],
  ]);
});

test("a deterministic 1.25 MB CSI redraw loses no output and keeps input ACKs below 100ms", async () => {
  const { queue, headless, events } = createQueue();
  const redraw = "\x1b[0m".repeat(250_000);
  queue.enqueueOutput(redraw);
  const inputDurations = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    await queue.enqueueInput([{ data: String(index % 10), delayMs: 0 }]);
    inputDurations.push(performance.now() - startedAt);
  }

  assert.equal(events[0][0], "output");
  assert.equal(events[0][1], redraw);
  const sorted = [...inputDurations].sort((left, right) => left - right);
  assert.ok(sorted[Math.ceil(sorted.length * 0.95) - 1] < 100);

  while (headless.callbacks.length > 0 || headless.events.filter(([type]) => type === "write").length < splitParserItems(redraw).length) {
    headless.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await queue.whenIdle();
});

test("parser backlog pauses at 8 MiB and resumes only below 4 MiB", async () => {
  const { queue, headless, events } = createQueue();
  queue.enqueueOutput("x".repeat(PARSER_PAUSE_BYTES));
  assert.equal(events.filter(([type]) => type === "pty-pause").length, 1);

  const itemCount = PARSER_PAUSE_BYTES / MAX_PARSER_ITEM_BYTES;
  for (let index = 0; index < itemCount; index += 1) {
    headless.release();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await queue.whenIdle();
  assert.equal(events.filter(([type]) => type === "pty-resume").length, 1);
});

test("CPR whitelist accepts concatenated normal/private replies and nothing else", () => {
  assert.deepEqual(
    parseWhitelistedCprReplies("\x1b[1;2R\x1b[?3;4R"),
    ["\x1b[1;2R", "\x1b[?3;4R"],
  );
  assert.deepEqual(parseWhitelistedCprReplies("\x1b[1;2Rreply"), []);
  assert.deepEqual(parseWhitelistedCprReplies("\x1b[5n"), []);
});
