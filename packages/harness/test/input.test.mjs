import test from "node:test";
import assert from "node:assert/strict";
import {
  HarnessInputWriter,
  harnessInputFragments,
  normalizeHarnessInput,
  splitHarnessInput,
} from "../dist/input.js";

test("normalizeHarnessInput preserves carriage returns for Claude Code and Codex", () => {
  assert.equal(normalizeHarnessInput("claude-code", "hello\r"), "hello\r");
  assert.equal(normalizeHarnessInput("codex", "hello\r"), "hello\r");
});

test("normalizeHarnessInput preserves OpenCode submit keys as carriage return", () => {
  assert.equal(normalizeHarnessInput("opencode", "hello\r"), "hello\r");
  assert.equal(normalizeHarnessInput("opencode", "\r"), "\r");
  assert.equal(normalizeHarnessInput("opencode", "\n"), "\r");
});

test("normalizeHarnessInput preserves multiline OpenCode input and only converts the trailing submit", () => {
  assert.equal(
    normalizeHarnessInput("opencode", "line one\r\nline two\r"),
    "line one\nline two\r",
  );
  assert.equal(
    normalizeHarnessInput("opencode", "line one\nline two\n"),
    "line one\nline two\r",
  );
});

test("normalizeHarnessInput preserves existing OpenCode control sequences", () => {
  assert.equal(normalizeHarnessInput("opencode", "\u001b[A"), "\u001b[A");
  assert.equal(normalizeHarnessInput("opencode", "\u001b[13u"), "\u001b[13u");
});

test("splitHarnessInput separates OpenCode submit into a follow-up Enter key event", () => {
  assert.deepEqual(splitHarnessInput("opencode", "hello\r"), ["hello", "\r"]);
  assert.deepEqual(splitHarnessInput("opencode", "\r"), ["\r"]);
  assert.deepEqual(
    splitHarnessInput("opencode", "line one\r\nline two\r"),
    ["line one\nline two", "\r"],
  );
});

test("splitHarnessInput leaves non-OpenCode harness input untouched", () => {
  assert.deepEqual(splitHarnessInput("claude-code", "hello\r"), ["hello\r"]);
  assert.deepEqual(splitHarnessInput("codex", "\r"), ["\r"]);
});

test("Codex submitted frames keep paste and delayed Enter in one operation", () => {
  const framed = "\u001b[200~review feedback\u001b[201~\r";

  assert.deepEqual(splitHarnessInput("codex", framed), [
    "\u001b[200~review feedback\u001b[201~",
    "\r",
  ]);
  assert.deepEqual(harnessInputFragments("codex", framed), [
    { data: "\u001b[200~review feedback\u001b[201~", delayMs: 0 },
    { data: "\r", delayMs: 10 },
  ]);
});

test("Codex input splitting ignores incomplete or nested paste frames", () => {
  const incomplete = "\u001b[200~review feedback\r";
  const nested = "\u001b[200~outer\u001b[200~inner\u001b[201~\r";

  assert.deepEqual(splitHarnessInput("codex", incomplete), [incomplete]);
  assert.deepEqual(splitHarnessInput("codex", nested), [nested]);
});

test("HarnessInputWriter ACKs a browser-framed Codex submission after its terminal operation", async () => {
  const operations = [];
  const completions = [];
  let release;
  const writer = new HarnessInputWriter("codex", () => ({
    writeInput: (fragments) => {
      operations.push(fragments);
      return new Promise((resolve) => { release = resolve; });
    },
    abortInput: () => undefined,
  }));

  writer.enqueue("\u001b[200~review feedback\u001b[201~\r", {
    onComplete: (result) => completions.push(result),
  });

  assert.deepEqual(operations, [[
    { data: "\u001b[200~review feedback\u001b[201~", delayMs: 0 },
    { data: "\r", delayMs: 10 },
  ]]);
  assert.deepEqual(completions, []);

  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [{ ok: true }]);
});

test("HarnessInputWriter submits split input directly to the terminal queue", async () => {
  const operations = [];
  const completions = [];
  const releases = [];
  const writer = new HarnessInputWriter("opencode", () => ({
    writeInput: (fragments) => {
      operations.push(fragments);
      return new Promise((resolve) => releases.push(resolve));
    },
    abortInput: () => undefined,
  }));

  writer.enqueue("hello\r", {
    onComplete: (result) => completions.push(["first", result]),
  });
  writer.enqueue("next", {
    onComplete: (result) => completions.push(["second", result]),
  });

  assert.deepEqual(operations, [
    [{ data: "hello", delayMs: 0 }, { data: "\r", delayMs: 10 }],
    [{ data: "next", delayMs: 0 }],
  ]);
  assert.deepEqual(completions, []);

  releases.forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(completions, [
    ["first", { ok: true }],
    ["second", { ok: true }],
  ]);
});

test("HarnessInputWriter completes input only after the terminal queue settles", async () => {
  let completion = null;
  let release;
  const writer = new HarnessInputWriter("opencode", () => ({
    writeInput: () => new Promise((resolve) => { release = resolve; }),
    abortInput: () => undefined,
  }));

  writer.enqueue("hello\r", {
    dimensions: { cols: 90, rows: 30 },
    onComplete: (result) => { completion = result; },
  });

  assert.equal(completion, null);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completion, { ok: true });
});

test("HarnessInputWriter submits Codex text as bracketed paste and Enter in one acknowledged operation", async () => {
  const operations = [];
  const completions = [];
  const releases = [];
  const writer = new HarnessInputWriter("codex", () => ({
    writeInput: (fragments) => {
      operations.push(fragments);
      return new Promise((resolve) => releases.push(resolve));
    },
    abortInput: () => undefined,
  }));

  writer.enqueueSubmittedText("line one\nline two", {
    onComplete: (result) => completions.push(["plan", result]),
  });
  writer.enqueue("interactive", {
    onComplete: (result) => completions.push(["interactive", result]),
  });

  assert.deepEqual(operations, [
    [
      { data: "\u001b[200~line one\nline two\u001b[201~", delayMs: 0 },
      { data: "\r", delayMs: 10 },
    ],
    [{ data: "interactive", delayMs: 0 }],
  ]);
  assert.deepEqual(completions, []);

  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [["plan", { ok: true }]]);

  releases[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [
    ["plan", { ok: true }],
    ["interactive", { ok: true }],
  ]);
});

test("HarnessInputWriter sanitizes terminal controls inside Codex submitted text", () => {
  const operations = [];
  const writer = new HarnessInputWriter("codex", () => ({
    writeInput: (fragments) => operations.push(fragments),
    abortInput: () => undefined,
  }));

  writer.enqueueSubmittedText("Review\u001b[201~\u0000\u001b risk\nnext");

  assert.deepEqual(operations, [[
    { data: "\u001b[200~Review risk\nnext\u001b[201~", delayMs: 0 },
    { data: "\r", delayMs: 10 },
  ]]);
});

test("HarnessInputWriter leaves non-Codex submitted text unwrapped", () => {
  const operations = [];
  const writer = new HarnessInputWriter("claude-code", () => ({
    writeInput: (fragments) => operations.push(fragments),
    abortInput: () => undefined,
  }));

  writer.enqueueSubmittedText("execute the plan");

  assert.deepEqual(operations, [[
    { data: "execute the plan", delayMs: 0 },
    { data: "\r", delayMs: 10 },
  ]]);
});

test("HarnessInputWriter registers modern inputs before later terminal operations", async () => {
  const operations = [];
  const releases = [];
  const target = {
    writeInput: (fragments) => {
      operations.push(`input:${fragments.map((fragment) => fragment.data).join("")}`);
      return new Promise((resolve) => releases.push(resolve));
    },
    abortInput: () => undefined,
  };
  const writer = new HarnessInputWriter("codex", () => target);

  writer.enqueue("a");
  writer.enqueue("b");
  operations.push("resize");

  assert.deepEqual(operations, ["input:a", "input:b", "resize"]);
  releases.forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
});

test("HarnessInputWriter reports a terminal-queue failure once", async () => {
  const operations = [];
  const completions = [];
  const writer = new HarnessInputWriter("opencode", () => ({
    writeInput: (fragments) => {
      operations.push(fragments);
      throw new Error("PTY write failed");
    },
    abortInput: () => undefined,
  }));

  writer.enqueue("hello\r", {
    onComplete: (result) => completions.push(result),
  });

  assert.deepEqual(operations, [[
    { data: "hello", delayMs: 0 },
    { data: "\r", delayMs: 10 },
  ]]);
  assert.deepEqual(completions, [{ ok: false, error: "PTY write failed" }]);
});

test("HarnessInputWriter abort fails queued jobs and writes Ctrl+C immediately", () => {
  const writes = [];
  const completions = [];
  const writer = new HarnessInputWriter("opencode", () => ({
    writeInput: () => new Promise(() => undefined),
    abortInput: () => writes.push("\x03"),
  }));

  writer.enqueue("first\r", {
    onComplete: (result) => completions.push(["first", result]),
  });
  writer.enqueue("second\r", {
    onComplete: (result) => completions.push(["second", result]),
  });

  let abortResult = null;
  writer.abort({ onComplete: (result) => { abortResult = result; } });

  // Ctrl+C lands synchronously, ahead of every queued fragment.
  assert.equal(writes[writes.length - 1], "\x03");
  assert.deepEqual(abortResult, { ok: true });
  assert.deepEqual(completions, [
    ["first", { ok: false, error: "Aborted" }],
    ["second", { ok: false, error: "Aborted" }],
  ]);
});

test("HarnessInputWriter ignores a late input completion after abort", async () => {
  const completions = [];
  let release;
  const writer = new HarnessInputWriter("opencode", () => ({
    writeInput: () => new Promise((resolve) => { release = resolve; }),
    abortInput: () => undefined,
  }));

  writer.enqueue("hello\r", {
    onComplete: (result) => completions.push(result),
  });

  writer.abort();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completions, [{ ok: false, error: "Aborted" }]);
});

test("HarnessInputWriter abort reports failure when no PTY is available", () => {
  const writer = new HarnessInputWriter("opencode", () => null);

  let abortResult = null;
  writer.abort({ onComplete: (result) => { abortResult = result; } });

  assert.deepEqual(abortResult, { ok: false, error: "No active PTY" });
});

test("HarnessInputWriter drains accepted input before graceful Stop abort", async () => {
  let releaseInput;
  const operations = [];
  const writer = new HarnessInputWriter("codex", () => ({
    writeInput: () => new Promise((resolve) => {
      operations.push("input");
      releaseInput = resolve;
    }),
    abortInput: () => { operations.push("abort"); },
  }));

  writer.enqueue("finish this write");
  const quiescence = writer.abortForStop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ["input"]);

  releaseInput();
  await quiescence;
  assert.deepEqual(operations, ["input", "abort"]);
});
