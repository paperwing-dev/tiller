import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PALETTE_QUERY_CHARS,
  TerminalPaletteQueryFilter,
} from "../dist/vt-palette-query-filter.js";

const palette = {
  background: "#fafafa",
  foreground: "#111111",
  cursor: "#222222",
  selectionBackground: "#dddddd",
  selectionForeground: "#333333",
  ansi: Array.from(
    { length: 16 },
    (_, index) => `#${index.toString(16).repeat(6)}`,
  ),
};

function filterChunks(chunks, end = true) {
  const filter = new TerminalPaletteQueryFilter(palette);
  const events = chunks.flatMap((chunk) => filter.push(chunk));
  if (end) events.push(...filter.end());
  return {
    events,
    output: events
      .filter((event) => event.type === "output")
      .map((event) => event.data)
      .join(""),
    replies: events
      .filter((event) => event.type === "reply")
      .map((event) => event.data)
      .join(""),
  };
}

test("answers indexed and special palette queries across every chunk split", () => {
  for (const [query, reply] of [
    ["\x1b]4;1;?\x07", "\x1b]4;1;#111111\x07"],
    ["\x1b]10;?\x07", "\x1b]10;#111111\x07"],
    ["\x1b]11;?\x1b\\", "\x1b]11;#fafafa\x1b\\"],
    ["\x1b]12;?\x07", "\x1b]12;#222222\x07"],
    ["\x1b]17;?\x07", "\x1b]17;#dddddd\x07"],
    ["\x1b]19;?\x07", "\x1b]19;#333333\x07"],
  ]) {
    const input = `before${query}after`;
    for (let split = 0; split <= input.length; split += 1) {
      const result = filterChunks([input.slice(0, split), input.slice(split)]);
      assert.equal(result.output, "beforeafter");
      assert.equal(result.replies, reply);
    }
  }
});

test("coalesces adjacent replies while preserving surrounding output order", () => {
  const result = filterChunks(["a\x1b]4;0;?\x07\x1b]10;?\x07\x1b]11;?\x07b"]);
  assert.deepEqual(result.events, [
    { type: "output", data: "a" },
    {
      type: "reply",
      data:
        "\x1b]4;0;#000000\x07" + "\x1b]10;#111111\x07" + "\x1b]11;#fafafa\x07",
    },
    { type: "output", data: "b" },
  ]);
});

test("answers the generated 256-color portion of the palette", () => {
  const result = filterChunks([
    "\x1b]4;16;?\x07\x1b]4;231;?\x07\x1b]4;232;?\x07\x1b]4;255;?\x07",
  ]);
  assert.equal(result.output, "");
  assert.equal(
    result.replies,
    "\x1b]4;16;#000000\x07" +
      "\x1b]4;231;#ffffff\x07" +
      "\x1b]4;232;#080808\x07" +
      "\x1b]4;255;#eeeeee\x07",
  );
});

test("preserves unrelated, malformed, cancelled, overlong, and incomplete OSC", () => {
  const values = [
    "\x1b]0;terminal title\x07",
    "\x1b]4;256;?\x07",
    "\x1b]18;?\x07",
    "\x1b]4;one;?\x07",
    "\x1b]4;1;?\x18tail",
    `\x1b]4;${"0".repeat(MAX_PALETTE_QUERY_CHARS)};?\x07`,
    "\x1b]11;?",
  ];
  const input = values.join("");
  const result = filterChunks([...input]);
  assert.equal(result.output, input);
  assert.equal(result.replies, "");
});

test("rejects palettes that could inject terminal data", () => {
  assert.throws(
    () =>
      new TerminalPaletteQueryFilter({
        ...palette,
        background: "#ffffff\x07injected",
      }),
    /six-digit hex color/,
  );
  assert.throws(
    () =>
      new TerminalPaletteQueryFilter({
        ...palette,
        ansi: palette.ansi.slice(0, 15),
      }),
    /exactly 16 ANSI colors/,
  );
});
