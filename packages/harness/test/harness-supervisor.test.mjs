import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_TERMINAL_AUTH_EXIT_CODE,
  classifyHarnessExit,
  codexRuntimeExitCode,
  evaluateHarnessRespawnBudget,
  shouldKeepHarnessAlive,
} from "../dist/harness-supervisor.js";

test("terminal Codex authentication failures bypass respawn", () => {
  assert.equal(classifyHarnessExit(CODEX_TERMINAL_AUTH_EXIT_CODE), "terminal-auth");
  assert.equal(classifyHarnessExit(1), "retryable");
});

test("only typed Codex authentication failures use the terminal exit code", () => {
  for (const code of [
    "needs_reconnect",
    "runtime_inactive",
  ]) {
    assert.equal(codexRuntimeExitCode(Object.assign(new Error(code), { code })), CODEX_TERMINAL_AUTH_EXIT_CODE);
  }
  assert.equal(codexRuntimeExitCode(
    Object.assign(new Error("temporary"), { code: "auth_temporarily_unavailable" }),
  ), 1);
  assert.equal(codexRuntimeExitCode(new Error("app-server crashed")), 1);
  assert.equal(codexRuntimeExitCode(Object.assign(new Error("unknown"), { code: "unknown" })), 1);
});

test("shouldKeepHarnessAlive stays enabled for non-interactive remote envs", () => {
  assert.equal(
    shouldKeepHarnessAlive({
      isInteractive: false,
      hubUrl: "https://hub.example.com",
      repoSlug: "demo-env",
    }),
    true,
  );
});

test("shouldKeepHarnessAlive stays disabled for local interactive runs", () => {
  assert.equal(
    shouldKeepHarnessAlive({
      isInteractive: true,
      hubUrl: "https://hub.example.com",
      repoSlug: "demo-env",
    }),
    false,
  );
});

test("evaluateHarnessRespawnBudget resets after the quiet window", () => {
  const result = evaluateHarnessRespawnBudget({
    currentCount: 3,
    lastRespawnAtMs: 1_000,
    nowMs: 400_000,
    maxRespawns: 10,
    resetWindowMs: 300_000,
  });

  assert.deepEqual(result, {
    allow: true,
    nextCount: 1,
    nextRespawnAtMs: 400_000,
  });
});

test("evaluateHarnessRespawnBudget blocks once the respawn budget is exhausted", () => {
  const result = evaluateHarnessRespawnBudget({
    currentCount: 10,
    lastRespawnAtMs: 100_000,
    nowMs: 120_000,
    maxRespawns: 10,
    resetWindowMs: 300_000,
  });

  assert.deepEqual(result, {
    allow: false,
    nextCount: 11,
    nextRespawnAtMs: 120_000,
  });
});
