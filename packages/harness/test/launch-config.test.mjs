import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHarnessSpawnArgs,
  buildInteractiveStartupPlanPrompt,
  buildStartupPlanDocument,
  resolveClaudeModelEffortArgs,
  resolveDebugCliArgs,
  resolveResumeArgs,
  resolveRunnerReadyStrategy,
  resolveStartupPlanCliArgs,
  MAX_STARTUP_PLAN_CLI_ARG_BYTES,
  STARTUP_PLAN_IMPLEMENTATION_PREAMBLE,
} from "../dist/launch-config.js";

test("resolveClaudeModelEffortArgs forwards the selected Claude binding", () => {
  assert.deepEqual(
    resolveClaudeModelEffortArgs({
      TILLER_CLAUDE_MODEL: "claude-fable-5",
      TILLER_CLAUDE_EFFORT: "max",
    }),
    ["--model", "claude-fable-5", "--effort", "max"],
  );
});

test("resolveClaudeModelEffortArgs requires a complete selection without shadowing the Hub catalog", () => {
  assert.throws(
    () => resolveClaudeModelEffortArgs({}),
    /TILLER_CLAUDE_MODEL/,
  );
  assert.throws(
    () => resolveClaudeModelEffortArgs({ TILLER_CLAUDE_MODEL: "claude-opus-4-8" }),
    /TILLER_CLAUDE_EFFORT/,
  );
  assert.throws(
    () => resolveClaudeModelEffortArgs({ TILLER_CLAUDE_EFFORT: "max" }),
    /TILLER_CLAUDE_MODEL/,
  );
  assert.deepEqual(
    resolveClaudeModelEffortArgs({
      TILLER_CLAUDE_MODEL: "future-catalog-model",
      TILLER_CLAUDE_EFFORT: "future-catalog-effort",
    }),
    ["--model", "future-catalog-model", "--effort", "future-catalog-effort"],
  );
});

test("resolveResumeArgs maps OpenCode resume to --continue", () => {
  assert.deepEqual(resolveResumeArgs("opencode", true), ["--continue"]);
});

test("resolveResumeArgs keeps --resume for Claude Code and Codex", () => {
  assert.deepEqual(resolveResumeArgs("claude-code", true), ["--resume"]);
  assert.deepEqual(resolveResumeArgs("codex", true), ["--resume"]);
});

test("resolveDebugCliArgs enables documented OpenCode debug flags", () => {
  assert.deepEqual(
    resolveDebugCliArgs("opencode", { TILLER_OPENCODE_DEBUG: "1" }),
    ["--print-logs", "--log-level", "DEBUG"],
  );
});

test("resolveDebugCliArgs stays quiet when OpenCode debug is disabled", () => {
  assert.deepEqual(resolveDebugCliArgs("opencode", {}), []);
  assert.deepEqual(resolveDebugCliArgs("codex", { TILLER_OPENCODE_DEBUG: "1" }), []);
});

test("resolveRunnerReadyStrategy waits for first output before marking Codex and OpenCode ready", () => {
  assert.equal(resolveRunnerReadyStrategy("opencode"), "first-output");
  assert.equal(resolveRunnerReadyStrategy("claude-code"), "spawned");
  assert.equal(resolveRunnerReadyStrategy("codex"), "first-output");
});

test("resolveStartupPlanCliArgs routes OpenCode startup plans through --prompt", () => {
  const prompt = buildInteractiveStartupPlanPrompt("Update the failing test and run the suite.");

  assert.match(prompt, /Startup plan:/);
  assert.match(prompt, /A previous agent produced the plan below/);
  assert.deepEqual(resolveStartupPlanCliArgs("opencode", prompt), ["--prompt", prompt]);
});

test("resolveStartupPlanCliArgs passes Codex startup plans as the initial prompt", () => {
  const prompt = buildInteractiveStartupPlanPrompt("Run lint and fix the reported issue.");

  assert.deepEqual(resolveStartupPlanCliArgs("codex", prompt), [prompt]);
});

test("resolveStartupPlanCliArgs starts Claude with its preloaded plan instruction", () => {
  const prompt = "Execute the plan described in your system prompt. Begin immediately.";

  assert.deepEqual(resolveStartupPlanCliArgs("claude-code", prompt), [prompt]);
});

test("resolveStartupPlanCliArgs falls back to PTY delivery above the safe argv limit", () => {
  const oversizedPrompt = "x".repeat(MAX_STARTUP_PLAN_CLI_ARG_BYTES + 1);

  assert.deepEqual(resolveStartupPlanCliArgs("codex", oversizedPrompt), []);
  assert.deepEqual(resolveStartupPlanCliArgs("opencode", oversizedPrompt), []);
});

test("CLI startup plans are passed only to the initial process", () => {
  const baseArgs = ["--continue"];
  const planArgs = ["--prompt", "execute the startup plan"];

  assert.deepEqual(
    buildHarnessSpawnArgs(baseArgs, planArgs, false),
    ["--continue", "--prompt", "execute the startup plan"],
  );
  assert.deepEqual(
    buildHarnessSpawnArgs(baseArgs, planArgs, true),
    ["--continue"],
  );
});

test("buildStartupPlanDocument prepends the implementation preamble once", () => {
  const plan = "1. Update the launch config.";
  const document = buildStartupPlanDocument(plan);

  assert.equal(
    document,
    `${STARTUP_PLAN_IMPLEMENTATION_PREAMBLE}\n\n${plan}`,
  );
  assert.equal(buildStartupPlanDocument(document), document);
});

test("startup plan implementation uses the concise canonical preamble", () => {
  const preamble = `Read the approved startup plan below and execute it immediately.

Work step by step, update files as needed, run relevant checks, and continue until the plan is complete or you hit a real blocker.

Startup plan:

A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context.
Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation
and verification.`;

  assert.equal(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE, preamble);
  assert.equal(
    buildInteractiveStartupPlanPrompt("1. Update the launch config."),
    `${preamble}\n\n1. Update the launch config.`,
  );
});
