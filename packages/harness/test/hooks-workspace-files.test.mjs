import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOOKS_DIST = path.resolve(import.meta.dirname, "../dist/hooks.js");

test("ensureClaudeAutonomousSettings writes home Claude settings without creating workspace files", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "tiller-harness-hooks-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const script = `
    import { ensureClaudeAutonomousSettings } from ${JSON.stringify(pathToFileURL(HOOKS_DIST).href)};
    ensureClaudeAutonomousSettings(${JSON.stringify(workspaceDir)});
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      HOME: homeDir,
    },
    encoding: "utf8",
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const homeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    const workspaceSettingsPath = path.join(workspaceDir, ".claude", "settings.local.json");

    assert.equal(existsSync(homeSettingsPath), true);
    assert.equal(existsSync(workspaceSettingsPath), false);
    const settings = JSON.parse(readFileSync(homeSettingsPath, "utf8"));
    assert.equal(settings.skipDangerousModePermissionPrompt, true);
    assert.equal(settings.fastMode, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensureClaudeAutonomousSettings enables Claude Fast mode when requested", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "tiller-harness-hooks-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const script = `
    import { ensureClaudeAutonomousSettings } from ${JSON.stringify(pathToFileURL(HOOKS_DIST).href)};
    ensureClaudeAutonomousSettings(${JSON.stringify(workspaceDir)});
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      HOME: homeDir,
      TILLER_CLAUDE_FAST_MODE: "1",
    },
    encoding: "utf8",
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.fastMode, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensureClaudeAutonomousSettings does not approve API keys for subscription auth", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "tiller-harness-hooks-"));
  const homeDir = path.join(tempRoot, "home");
  const workspaceDir = path.join(tempRoot, "workspace");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const script = `
    import { ensureClaudeAutonomousSettings } from ${JSON.stringify(pathToFileURL(HOOKS_DIST).href)};
    ensureClaudeAutonomousSettings(${JSON.stringify(workspaceDir)});
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      HOME: homeDir,
      TILLER_HARNESS: "claude-code",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
      ANTHROPIC_API_KEY: "sk-ant-api-key",
    },
    encoding: "utf8",
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const claudeStatePath = path.join(homeDir, ".claude.json");
    const claudeState = JSON.parse(readFileSync(claudeStatePath, "utf8"));

    assert.deepEqual(claudeState.customApiKeyResponses, { approved: [], rejected: [] });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensureClaudeSettings installs completion activity hooks without replacing user hooks", () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "tiller-harness-hooks-"));
  const homeDir = path.join(tempRoot, "home");
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "user-stop-hook" }] }],
    },
  }));

  const activityHookPath = path.join(homeDir, ".config", "tiller", "hooks", "activity-hook.mjs");
  const script = `
    import { ensureClaudeSettings } from ${JSON.stringify(pathToFileURL(HOOKS_DIST).href)};
    ensureClaudeSettings(null, ${JSON.stringify(activityHookPath)});
    ensureClaudeSettings(null, ${JSON.stringify(activityHookPath)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: homeDir },
    encoding: "utf8",
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const commands = (event) => settings.hooks[event]
      .flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.deepEqual(commands("UserPromptSubmit"), [
      `node ${JSON.stringify(activityHookPath)} working`,
    ]);
    assert.deepEqual(commands("Stop"), [
      "user-stop-hook",
      `node ${JSON.stringify(activityHookPath)} completed`,
    ]);
    assert.deepEqual(commands("StopFailure"), [
      `node ${JSON.stringify(activityHookPath)} idle`,
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
