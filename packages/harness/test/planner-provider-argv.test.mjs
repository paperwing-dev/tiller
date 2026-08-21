import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeDir = mkdtempSync(join(tmpdir(), "planner-provider-home-"));
process.env.HOME = homeDir;

const [{ buildArgs: buildClaudeArgs }, { buildArgs: buildCodexArgs }] = await Promise.all([
  import("../dist/planner/providers/claude.js"),
  import("../dist/planner/providers/codex.js"),
]);

test.after(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

test("Claude forwards the selected reviewer effort", () => {
  const command = buildClaudeArgs({
    prompt: "Review the code.",
    model: "opus",
    effort: "max",
  });
  assert.deepEqual(command.args.slice(-4), ["--model", "opus", "--effort", "max"]);
  assert.ok(command.args.includes("--output-format"));
  assert.ok(command.args.includes("stream-json"));
  assert.ok(command.args.includes("--verbose"));
  assert.ok(command.args.includes("--dangerously-skip-permissions"));
  assert.ok(command.args.includes("--no-session-persistence"));
  assert.ok(!command.args.includes("--bare"));
  assert.ok(!command.args.includes("--permission-mode"));
  assert.ok(!command.args.includes("--allowedTools"));
});

test("Codex overrides model_reasoning_effort for the selected reviewer effort", () => {
  const checkoutDir = mkdtempSync(join(tmpdir(), "planner-codex-effort-"));
  const isolatedConfigPath = join(checkoutDir, "isolated-home", ".codex", "config.toml");
  try {
    const command = buildCodexArgs({
      prompt: "Review the code.",
      model: "gpt-5.5",
      effort: "low",
      checkoutDir,
      fallbackOutputFile: "/tmp/last-message.md",
      configPath: isolatedConfigPath,
    });
    const effortIndex = command.args.lastIndexOf("model_reasoning_effort=\"low\"");
    assert.ok(effortIndex > 0);
    assert.equal(command.args[effortIndex - 1], "-c");
    assert.equal(command.args.filter((arg) => arg.startsWith("model_reasoning_effort=")).length, 1);
    assert.ok(!command.args.includes('model_reasoning_effort="xhigh"'));
    assert.equal(existsSync(isolatedConfigPath), true);
    assert.equal(existsSync(join(homeDir, ".codex", "config.toml")), false);
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});
