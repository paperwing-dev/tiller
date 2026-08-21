import test from "node:test";
import assert from "node:assert/strict";
import { CursorPositionDsrFilter, MAX_DSR_CANDIDATE_CHARS } from "../dist/vt-dsr-filter.js";

function filterChunks(chunks, end = true) {
  const filter = new CursorPositionDsrFilter();
  let output = "";
  for (const chunk of chunks) {
    output += filter.push(chunk);
  }
  if (end) output += filter.end();
  return output;
}

test("filters normal and private CPR requests across every chunk split", () => {
  for (const request of ["\x1b[6n", "\x1b[?6n"]) {
    const input = `before${request}after`;
    for (let split = 0; split <= input.length; split += 1) {
      assert.equal(filterChunks([input.slice(0, split), input.slice(split)]), "beforeafter");
    }
  }
});

test("filters repeated requests but preserves unrelated CSI", () => {
  assert.equal(filterChunks(["a\x1b[6n\x1b[?6n\x1b[006nb\x1b[5n"]), "ab\x1b[5n");
});

test("reports removed cursor-position requests per pushed chunk", () => {
  const filter = new CursorPositionDsrFilter();
  assert.deepEqual(filter.pushWithReport("a\x1b[6n\x1b[?6"), {
    output: "a",
    removedCount: 1,
  });
  assert.deepEqual(filter.pushWithReport("nb"), {
    output: "b",
    removedCount: 1,
  });
});

test("preserves cancelled, malformed, overlong, and incomplete candidates", () => {
  const cancelled = "\x1b[6\x18n";
  const malformed = "\x1b[;6n";
  const overlong = `\x1b[${"0".repeat(MAX_DSR_CANDIDATE_CHARS)}6n`;
  const incomplete = "\x1b[?6";
  const input = cancelled + malformed + overlong + incomplete;
  assert.equal(filterChunks([input]), input);
});

test("does not recognize DSR-looking text inside VT control strings", () => {
  const strings = [
    "\x1b]title \x1b[6n\x07",
    "\x1bPpayload \x1b[6n\x1b\\",
    "\x1b_payload \x1b[?6n\x1b\\",
    "\x1b^payload \x1b[6n\x1b\\",
    "\x1bXpayload \x1b[6n\x1b\\",
  ];
  const input = strings.join("");
  assert.equal(filterChunks([...input]), input);
});

test("tracks BEL and CAN cancellation even after an ESC inside a control string", () => {
  const input = "\x1b]title\x1b\x07\x1b[6nA\x1bPpayload\x1b\x18\x1b[?6nB";
  assert.equal(filterChunks([...input]), "\x1b]title\x1b\x07A\x1bPpayload\x1b\x18B");
});

test("leaves 8-bit CSI untouched until node-pty representation is proven", () => {
  assert.equal(filterChunks(["\u009b6n"]), "\u009b6n");
});
