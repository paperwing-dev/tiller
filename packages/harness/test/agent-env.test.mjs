import test from "node:test";
import assert from "node:assert/strict";
import { cleanEnvForAgent } from "../dist/agent.js";

const CONTROLLED_ENV_KEYS = [
  "TILLER_HARNESS",
  "TILLER_CLAUDE_AUTH_RESOLVED_MODE",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "TILLER_CODEX_RUNTIME_MODE",
  "TILLER_CODEX_AUTH_MODE",
  "OPENAI_API_KEY",
  "HUB_URL",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "TILLER_GITHUB_BRIDGE_ID",
  "TILLER_GITHUB_BRIDGE_SECRET",
  "TILLER_GITHUB_ALLOWED_REPO",
  "TILLER_GITHUB_BRIDGE_EXTRA",
  "TILLER_RUNTIME_CAPABILITY",
  "TILLER_HARNESS_CONTROL_SOCKET",
  "TILLER_ACTIVITY_GENERATION",
  "TILLER_ACTIVITY_HOOK_PATH",
];

function withEnv(vars, callback) {
  const previous = new Map(CONTROLLED_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of CONTROLLED_ENV_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, vars);
    callback();
  } finally {
    for (const key of CONTROLLED_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("cleanEnvForAgent strips Claude API auth when subscription mode is resolved", () => {
  withEnv(
    {
      TILLER_HARNESS: "claude-code",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      ANTHROPIC_BASE_URL: "https://api.example.test",
      ANTHROPIC_CUSTOM_HEADERS: "x-test: 1",
      CLAUDECODE: "1",
      CLAUDE_CODE: "1",
    },
    () => {
      const env = cleanEnvForAgent({ TILLER_SESSION_ID: "session-1" });

      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token");
      assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(env.TILLER_CLAUDE_AUTH_RESOLVED_MODE, "subscription");
      assert.equal(env.TILLER_SESSION_ID, "session-1");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, undefined);
      assert.equal(env.CLAUDECODE, undefined);
      assert.equal(env.CLAUDE_CODE, undefined);
    },
  );
});

test("cleanEnvForAgent preserves Anthropic API key outside subscription mode", () => {
  withEnv(
    {
      TILLER_HARNESS: "claude-code",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: "api",
      ANTHROPIC_API_KEY: "api-key",
    },
    () => {
      const env = cleanEnvForAgent();

      assert.equal(env.ANTHROPIC_API_KEY, "api-key");
      assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
      assert.equal(env.TILLER_CLAUDE_AUTH_RESOLVED_MODE, "api");
    },
  );
});

test("cleanEnvForAgent isolates API-key Codex app-server while preserving its API key", () => {
  withEnv(
    {
      TILLER_HARNESS: "codex",
      TILLER_CODEX_RUNTIME_MODE: "app-server",
      TILLER_CODEX_AUTH_MODE: "api-key",
      OPENAI_API_KEY: "openai-key",
      CF_ACCESS_CLIENT_SECRET: "access-secret",
      TILLER_RUNTIME_CAPABILITY: "runtime-secret",
    },
    () => {
      const env = cleanEnvForAgent({
        PATH: "/bin",
        TILLER_SESSION_ENV_NAMES: "SAFE_VALUE",
        SAFE_VALUE: "visible",
        TILLER_HARNESS_CONTROL_SOCKET: "/tmp/tiller-harness-control.sock",
        TILLER_ACTIVITY_GENERATION: "generation-1",
        TILLER_ACTIVITY_HOOK_PATH: "/home/tiller/.config/tiller/hooks/activity-hook.mjs",
      });

      assert.equal(env.OPENAI_API_KEY, "openai-key");
      assert.equal(env.SAFE_VALUE, "visible");
      assert.equal(env.TILLER_HARNESS_CONTROL_SOCKET, "/tmp/tiller-harness-control.sock");
      assert.equal(env.TILLER_ACTIVITY_GENERATION, "generation-1");
      assert.equal(
        env.TILLER_ACTIVITY_HOOK_PATH,
        "/home/tiller/.config/tiller/hooks/activity-hook.mjs",
      );
      assert.equal(env.CF_ACCESS_CLIENT_SECRET, undefined);
      assert.equal(env.TILLER_RUNTIME_CAPABILITY, undefined);
    },
  );
});

test("cleanEnvForAgent preserves the scoped GitHub bridge for API-key Codex app-server", () => {
  withEnv(
    {
      TILLER_HARNESS: "codex",
      TILLER_CODEX_RUNTIME_MODE: "app-server",
      TILLER_CODEX_AUTH_MODE: "api-key",
      OPENAI_API_KEY: "openai-key",
      HUB_URL: "https://hub.example.test",
      CF_ACCESS_CLIENT_ID: "access-client-id",
      CF_ACCESS_CLIENT_SECRET: "access-client-secret",
      TILLER_GITHUB_BRIDGE_ID: "bridge-id",
      TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
      TILLER_GITHUB_ALLOWED_REPO: "example/repo",
      TILLER_GITHUB_BRIDGE_EXTRA: "not-allowed",
    },
    () => {
      const env = cleanEnvForAgent({ PATH: "/bin" });

      assert.equal(env.HUB_URL, "https://hub.example.test");
      assert.equal(env.CF_ACCESS_CLIENT_ID, "access-client-id");
      assert.equal(env.CF_ACCESS_CLIENT_SECRET, "access-client-secret");
      assert.equal(env.TILLER_GITHUB_BRIDGE_ID, "bridge-id");
      assert.equal(env.TILLER_GITHUB_BRIDGE_SECRET, "bridge-secret");
      assert.equal(env.TILLER_GITHUB_ALLOWED_REPO, "example/repo");
      assert.equal(env.TILLER_GITHUB_BRIDGE_EXTRA, undefined);
    },
  );
});
