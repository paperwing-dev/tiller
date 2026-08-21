import test from "node:test";
import assert from "node:assert/strict";
import {
  HARNESS_OWNED_CLAUDE_ENV_KEYS,
  sanitizeClaudeChildEnvironment,
} from "../dist/claude-environment.js";

const dirtyControls = Object.fromEntries(
  HARNESS_OWNED_CLAUDE_ENV_KEYS.map((key) => [key, `dirty-${key}`]),
);

test("Claude sanitizer restores only the selected subscription credential and required controls", () => {
  const env = sanitizeClaudeChildEnvironment({
    ...dirtyControls,
    TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
    CLAUDE_CODE_OAUTH_TOKEN: "selected-oauth",
    ANTHROPIC_API_KEY: "inactive-api",
    UNRELATED_FLAG: "preserved",
  });

  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "selected-oauth");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(env.TILLER_CLAUDE_AUTH_RESOLVED_MODE, "subscription");
  assert.equal(env.UNRELATED_FLAG, "preserved");
  for (const key of HARNESS_OWNED_CLAUDE_ENV_KEYS) {
    if (key === "CLAUDE_CODE_OAUTH_TOKEN" || key === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" || key === "TILLER_CLAUDE_AUTH_RESOLVED_MODE") continue;
    assert.equal(env[key], undefined, `${key} should be removed`);
  }
});

test("Claude sanitizer restores only the selected API credential", () => {
  const env = sanitizeClaudeChildEnvironment({
    ...dirtyControls,
    TILLER_CLAUDE_AUTH_RESOLVED_MODE: "api",
    CLAUDE_CODE_OAUTH_TOKEN: "inactive-oauth",
    ANTHROPIC_API_KEY: "selected-api",
    PATH: "/usr/bin",
  });

  assert.equal(env.ANTHROPIC_API_KEY, "selected-api");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(env.TILLER_CLAUDE_AUTH_RESOLVED_MODE, "api");
  assert.equal(env.PATH, "/usr/bin");
});
