import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexModelOverrides,
  ensureCodexProjectTrust,
  removeCodexActivityHooks,
  resolveCodexModelSettings,
  splitCodexRemoteRuntimeArgs,
} from "../dist/codex-config.js";

function tempConfigPath() {
  const dir = mkdtempSync(join(tmpdir(), "tiller-codex-config-"));
  return {
    dir,
    path: join(dir, ".codex", "config.toml"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("buildCodexModelOverrides emits the complete selected pair", () => {
  assert.deepEqual(buildCodexModelOverrides({
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    fastMode: false,
  }), [
    'model="gpt-5.6-sol"',
    'model_reasoning_effort="xhigh"',
  ]);
});

test("buildCodexModelOverrides emits another selected model and effort without defaulting", () => {
  assert.deepEqual(buildCodexModelOverrides({
    model: "gpt-5.5",
    reasoningEffort: "low",
    fastMode: false,
  }), [
    'model="gpt-5.5"',
    'model_reasoning_effort="low"',
  ]);
});

test("buildCodexModelOverrides enables the complete Fast mode configuration", () => {
  assert.deepEqual(buildCodexModelOverrides({
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    fastMode: true,
  }), [
    'model="gpt-5.6-sol"',
    'model_reasoning_effort="high"',
    "features.fast_mode=true",
    'service_tier="fast"',
  ]);
});

test("resolveCodexModelSettings rejects incomplete or unsupported transport", () => {
  assert.throws(() => resolveCodexModelSettings({}), /TILLER_CODEX_MODEL/);
  assert.throws(() => resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.6-sol",
  }), /TILLER_CODEX_REASONING_EFFORT/);
  assert.throws(() => resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.6-sol",
    TILLER_CODEX_REASONING_EFFORT: "extreme",
  }), /must be low, medium, high, xhigh, max, or ultra/);
  assert.deepEqual(resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.6-sol",
    TILLER_CODEX_REASONING_EFFORT: "max",
  }), {
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    fastMode: false,
  });
  assert.deepEqual(resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.5",
    TILLER_CODEX_REASONING_EFFORT: "high",
  }), {
    model: "gpt-5.5",
    reasoningEffort: "high",
    fastMode: false,
  });
  assert.deepEqual(resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.5",
    TILLER_CODEX_REASONING_EFFORT: "high",
    TILLER_CODEX_FAST_MODE: "1",
  }), {
    model: "gpt-5.5",
    reasoningEffort: "high",
    fastMode: true,
  });
  assert.throws(() => resolveCodexModelSettings({
    TILLER_CODEX_MODEL: "gpt-5.5",
    TILLER_CODEX_REASONING_EFFORT: "high",
    TILLER_CODEX_FAST_MODE: "yes",
  }), /must be 0 or 1/);
});

test("splitCodexRemoteRuntimeArgs forwards URL-only MCP config to both Codex processes", () => {
  const mcpConfig = 'mcp_servers.tiller_docs={ url = "https://docs.example.com/mcp" }';
  const initialPrompt = "Execute the approved startup plan.";
  assert.deepEqual(splitCodexRemoteRuntimeArgs([
    "--model", "gpt-5.5",
    "-c", 'model_reasoning_effort="high"',
    "--config", mcpConfig,
    initialPrompt,
  ]), {
    appServerArgs: [
      "-c", 'model_reasoning_effort="high"',
      "-c", mcpConfig,
    ],
    tuiArgs: [
      "--model", "gpt-5.5",
      "-c", 'model_reasoning_effort="high"',
      "--config", mcpConfig,
      initialPrompt,
    ],
  });
});

test("ensureCodexProjectTrust writes trusted project entries for workspace and cwd", () => {
  const config = tempConfigPath();
  try {
    ensureCodexProjectTrust("/tmp/example-workspace", config.path);

    const content = readFileSync(config.path, "utf-8");
    assert.match(content, /# BEGIN TILLER MANAGED CODEX PROJECT TRUST/);
    assert.match(content, /\[projects\."\/workspace"\]\ntrust_level = "trusted"/);
    assert.match(content, /\[projects\."\/tmp\/example-workspace"\]\ntrust_level = "trusted"/);
  } finally {
    config.cleanup();
  }
});

test("ensureCodexProjectTrust replaces only the Tiller-managed trust block", () => {
  const config = tempConfigPath();
  try {
    mkdirSync(join(config.dir, ".codex"), { recursive: true });
    writeFileSync(config.path, [
      'web_search = "disabled"',
      "",
      "# BEGIN TILLER MANAGED CODEX PROJECT TRUST",
      '[projects."/old-workspace"]',
      'trust_level = "trusted"',
      "# END TILLER MANAGED CODEX PROJECT TRUST",
      "",
    ].join("\n"), { flag: "w" });

    ensureCodexProjectTrust("/workspace", config.path);

    const content = readFileSync(config.path, "utf-8");
    assert.match(content, /web_search = "disabled"/);
    assert.doesNotMatch(content, /old-workspace/);
    assert.equal(
      content.match(/# BEGIN TILLER MANAGED CODEX PROJECT TRUST/g)?.length,
      1,
    );
    assert.equal(
      content.match(/\[projects\."\/workspace"\]/g)?.length,
      1,
    );
  } finally {
    config.cleanup();
  }
});

test("removeCodexActivityHooks preserves user hooks and removes stale managed lifecycle hooks", () => {
  const config = tempConfigPath();
  try {
    const hooksPath = join(config.dir, ".codex", "hooks.json");
    mkdirSync(join(config.dir, ".codex"), { recursive: true });
    writeFileSync(hooksPath, JSON.stringify({
      custom: "preserved",
      hooks: {
        UserPromptSubmit: [{ hooks: [
          { type: "command", command: "user-prompt-hook" },
          { type: "command", command: "node /home/tiller/.config/tiller/hooks/activity-hook.mjs working" },
        ] }],
        Stop: [{ hooks: [
          { type: "command", command: "user-stop-hook" },
          { type: "command", command: "node /home/tiller/.config/tiller/hooks/activity-hook.mjs completed" },
        ] }],
      },
    }));

    removeCodexActivityHooks(hooksPath);
    removeCodexActivityHooks(hooksPath);

    const document = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(document.custom, "preserved");
    assert.deepEqual(
      document.hooks.UserPromptSubmit.flatMap((group) => group.hooks.map((hook) => hook.command)),
      ["user-prompt-hook"],
    );
    assert.deepEqual(
      document.hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command)),
      ["user-stop-hook"],
    );
  } finally {
    config.cleanup();
  }
});
