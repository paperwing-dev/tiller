import test from "node:test";
import assert from "node:assert/strict";
import { isHarness, resolveHarness } from "../dist/harness.js";

test("isHarness accepts only supported harness ids", () => {
  assert.equal(isHarness("claude-code"), true);
  assert.equal(isHarness("codex"), true);
  assert.equal(isHarness("opencode"), true);
  assert.equal(isHarness("unknown"), false);
  assert.equal(isHarness(undefined), false);
});

test("resolveHarness rejects missing or invalid harness values", () => {
  assert.throws(() => resolveHarness(), /TILLER_HARNESS must be/);
  assert.throws(() => resolveHarness("unknown"), /TILLER_HARNESS must be/);
});
