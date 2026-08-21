import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import {
  deliverPlanWriterInput,
  PlanWriterActivityController,
  planWriterTurnLifecycleForClaudeHook,
  reportPlanWriterSettlement,
} from "../dist/plan-writer/activity.js";
import { startPlanWriterStartupDeadline } from "../dist/plan-writer/startup-deadline.js";
import {
  bracketedPasteWithoutEnter,
  containsUnsupportedConversationCommand,
  sanitizeContributionInsert,
} from "../dist/plan-writer/sanitize.js";
import {
  buildClaudeLaunch,
  buildProviderEnvironment,
  deterministicClaudeSessionId,
  renderCodexPlanWriterConfig,
} from "../dist/plan-writer/provider.js";
import {
  buildOpenCodeLaunch,
  buildOpenCodePlanWriterConfig,
  OPENCODE_READY_DEADLINE_MS,
  renderOpenCodePlanWriterConfig,
  renderOpenCodePlanWriterPlugin,
  waitForOpenCodeReady,
} from "../dist/plan-writer/opencode.js";
import { OpenCodeGenerationFence } from "../dist/plan-writer/opencode-hook.js";
import {
  PLAN_WRITER_PUBLICATION_DEADLINE_MS,
  PlanWriterPublicationQueue,
} from "../dist/plan-writer/publication-queue.js";
import {
  mergeRefreshedPlanWriterContext,
  normalizePlanMarkdown,
  renderManagedPlanWriterContext,
} from "../dist/plan-writer/context.js";
import {
  PLAN_MARKDOWN_NORMALIZATION_VERSION,
  PLAN_WRITER_PROTOCOL_VERSION,
} from "../dist/plan-writer/contract.js";
import {
  PlanWriterSkillRequestIds,
  planWriterSkillStartedReason,
} from "../dist/plan-writer/skill-invocation.js";
import {
  CodexPlanWriterTurnQueue,
  CodexAppServer,
  codexNotificationThreadId,
  codexPlanWriterTurnLifecycle,
  codexThreadRestingLifecycle,
  hasManagedCodexSettings,
  hasManagedCodexThreadSettings,
  newestCompletedPlan,
  reconcileCodexCompletionWithRetry,
} from "../dist/plan-writer/codex-app-server.js";
import { TerminalOperationQueue } from "../dist/terminal-operations.js";
import {
  codexRepoPlansCliOverrides,
  codexRepoPlansServerConfig,
} from "../dist/plan-writer/repo-plans.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

test("Plan Writer skill requests retain their idempotency key until Hub confirms them", () => {
  const generated = ["first", "second", "third"];
  const ids = new PlanWriterSkillRequestIds(7, () => generated.shift());

  const first = ids.acquire("risk");
  assert.equal(first, "plan-writer-skill:7:first");
  assert.equal(ids.acquire("risk"), first);
  assert.equal(ids.acquire("plan-review"), "plan-writer-skill:7:second");

  ids.confirm("risk", "a-different-request");
  assert.equal(ids.acquire("risk"), first);
  ids.confirm("risk", first);
  assert.equal(ids.acquire("risk"), "plan-writer-skill:7:third");
});

test("Plan Writer describes Health results as immutable", () => {
  assert.equal(
    planWriterSkillStartedReason({ id: "plan-health", command: "health" }),
    "/health started. Its immutable result will appear in Tiller.",
  );
  assert.equal(
    planWriterSkillStartedReason({ id: "plan-review", command: "plan-review" }),
    "/plan-review started. Its result will appear in Tiller.",
  );
});

async function createOpenCodeDeniedReadMarker(checkoutDir) {
  const gitDir = join(checkoutDir, ".git");
  const markerPath = join(gitDir, "tiller-opencode-read-denied");
  await mkdir(gitDir);
  await writeFile(
    markerPath,
    "External read denied: the requested path is outside the managed checkout.\n",
  );
  await chmod(markerPath, 0o444);
  await chmod(gitDir, 0o555);
}

test("Codex Plan Writer disables plugin discovery in its managed config", () => {
  const config = renderCodexPlanWriterConfig({
    model: "gpt-test",
    planModeReasoningEffort: "high",
  });
  assert.match(config, /^features\.plugins = false$/m);
  assert.match(config, /^\[mcp_servers\]$/m);
  assert.match(config, /^plan_mode_reasoning_effort = "high"$/m);
  assert.match(config, /^sandbox_mode = "danger-full-access"$/m);
  assert.match(config, /^approval_policy = "never"$/m);
});

test("Codex Plan Writer configures only the four managed repository plan tools", () => {
  const config = renderCodexPlanWriterConfig({
    model: "gpt-test",
    planModeReasoningEffort: "high",
    repoPlansSocketPath: "/run/tiller-plan-writer/supervisor.sock",
  });
  assert.match(config, /^\[mcp_servers\.tiller_plans\]$/m);
  assert.match(config, /^command = "tiller-plan-writer-plans-mcp"$/m);
  assert.match(
    config,
    /^enabled_tools = \["list_plans","read_plan","create_plan","update_plan"\]$/m,
  );
  assert.match(config, /^default_tools_approval_mode = "approve"$/m);
  assert.match(
    config,
    /^env = \{ TILLER_PLAN_WRITER_SOCKET = "\/run\/tiller-plan-writer\/supervisor\.sock" \}$/m,
  );
  assert.equal((config.match(/^\[mcp_servers\.[^\]]+\]$/gm) ?? []).length, 1);
});

test("Codex app-server boundaries share one managed MCP definition", () => {
  const socketPath = "/run/tiller-plan-writer/supervisor.sock";
  assert.deepEqual(codexRepoPlansServerConfig(socketPath), {
    command: "tiller-plan-writer-plans-mcp",
    enabled: true,
    enabled_tools: ["list_plans", "read_plan", "create_plan", "update_plan"],
    default_tools_approval_mode: "approve",
    env: { TILLER_PLAN_WRITER_SOCKET: socketPath },
  });
  const overrides = codexRepoPlansCliOverrides(socketPath);
  assert.ok(
    overrides.includes(
      'mcp_servers.tiller_plans.command="tiller-plan-writer-plans-mcp"',
    ),
  );
  assert.ok(
    overrides.includes(
      'mcp_servers.tiller_plans.enabled_tools=["list_plans","read_plan","create_plan","update_plan"]',
    ),
  );
  assert.ok(
    overrides.includes(
      `mcp_servers.tiller_plans.env={ TILLER_PLAN_WRITER_SOCKET = "${socketPath}" }`,
    ),
  );
});

test("Codex Plan Writer opts into Fast mode only when selected", () => {
  const standard = renderCodexPlanWriterConfig({
    model: "gpt-test",
    planModeReasoningEffort: "high",
  });
  assert.doesNotMatch(standard, /^service_tier/m);
  assert.doesNotMatch(standard, /^features\.fast_mode/m);

  const fast = renderCodexPlanWriterConfig({
    model: "gpt-test",
    planModeReasoningEffort: "high",
    fastMode: true,
  });
  assert.match(fast, /^service_tier = "fast"$/m);
  assert.match(fast, /^features\.fast_mode = true$/m);
});

function openCodeContext() {
  return {
    writer: {
      protocolVersion: PLAN_WRITER_PROTOCOL_VERSION,
      repoId: "repo",
      planArtifactId: "plan",
      generation: 2,
      basisCommit: "abc123",
      terminalId: "plan-writer-terminal",
      provider: "opencode",
      model: "gpt-native",
      effort: "high",
    },
    plan: {
      normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
      title: "Plan",
      status: "draft",
      markdown: "# Existing\n",
      digest: "digest",
    },
    planFormat: "Use Markdown",
    instructions: ["Research before publishing."],
    skills: [],
  };
}

test("managed context and refreshes freeze repository-plan capability negotiation", () => {
  const disabled = openCodeContext();
  assert.match(
    renderManagedPlanWriterContext(disabled),
    /MCP servers and repository or user hooks are unavailable/,
  );

  const enabled = {
    ...openCodeContext(),
    capabilities: { repoPlansV1: true },
  };
  const rendered = renderManagedPlanWriterContext(enabled);
  assert.match(rendered, /only MCP server available.*`tiller_plans`/);
  assert.match(
    rendered,
    /Never use `update_plan` for this Scribe's owned plan/,
  );

  const remainsDisabled = mergeRefreshedPlanWriterContext(disabled, enabled);
  assert.equal(remainsDisabled.capabilities, undefined);
  const remainsEnabled = mergeRefreshedPlanWriterContext(enabled, disabled);
  assert.deepEqual(remainsEnabled.capabilities, { repoPlansV1: true });
});

test("harness matches the shared plan Markdown normalization contract", async () => {
  const contract = JSON.parse(
    await readFile(
      new URL("../../../configs/plan-markdown-normalization-v1.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(contract.version, PLAN_MARKDOWN_NORMALIZATION_VERSION);
  for (const fixture of contract.cases) {
    assert.equal(normalizePlanMarkdown(fixture.input), fixture.canonical, fixture.name);
  }
});

test("managed Scribe context lists only the frozen Plan Skill projection", () => {
  const context = openCodeContext();
  context.skills = [{
    id: "plan-health",
    command: "health",
    label: "Plan Health",
    description: "Assess the current plan's risk and change size, then update its hover details with both values.",
    sharedInstructions: "Health rubrics",
    agents: [],
  }];
  const rendered = renderManagedPlanWriterContext(context);
  assert.match(rendered, /^## Plan Skills$/m);
  assert.match(rendered, /^- \/health — Assess the current plan's risk and change size, then update its hover details with both values\.$/m);
  assert.doesNotMatch(rendered, /skillRevision|projection token/i);
});

function openCodeEnv() {
  return {
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    TILLER_OPENCODE_BASE_URL: "https://api.example/v1",
    TILLER_OPENCODE_AUTH_TOKEN: "secret",
    TILLER_OPENCODE_PROVIDER_KIND: "openai",
    TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-openai",
    TILLER_OPENCODE_PROVIDER_LABEL: "OpenAI",
    TILLER_OPENCODE_MODEL_ID: "gpt-native",
    TILLER_OPENCODE_MODEL_ALIAS: "gpt-model",
    TILLER_OPENCODE_MODEL_LABEL: "GPT Model",
    TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "1000000",
    TILLER_OPENCODE_MODEL_INPUT_LIMIT: "872000",
    TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "128000",
  };
}

async function loadManagedOpenCodePlugin(t, onMessage) {
  const root = await mkdtemp(join(tmpdir(), "tiller-opencode-plugin-"));
  const socketPath = join(root, "hook.sock");
  const contextPath = join(root, "managed-context.md");
  const checkoutDir = join(root, "checkout");
  await mkdir(checkoutDir);
  await createOpenCodeDeniedReadMarker(checkoutDir);
  await writeFile(contextPath, "initial managed context\n");
  const messages = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    messages.push(message);
    const result = await onMessage(message);
    if (result === "hang") return;
    const status = result?.status ?? 200;
    const body = JSON.stringify(result?.body ?? { ok: true });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await chmod(join(checkoutDir, ".git"), 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  const source = renderOpenCodePlanWriterPlugin({
    socketPath,
    contextPath,
    checkoutDir,
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const hooks = await module.default();
  return {
    hooks,
    messages,
    root,
    checkoutDir,
    contextPath,
    writeContext: (value) => writeFile(contextPath, value),
  };
}

function resolvedOpenCodeChatOutput(overrides = {}) {
  return {
    message: {
      sessionID: "session-1",
      agent: "plan",
      model: {
        providerID: "provider",
        modelID: "model",
        variant: "high",
      },
      ...(overrides.message ?? {}),
    },
    parts: overrides.parts ?? [],
  };
}

test("OpenCode Plan Writer config has one bundled provider and an ordered deny-first Plan policy", () => {
  const config = buildOpenCodePlanWriterConfig({
    context: openCodeContext(),
    pluginPath: "/protected/tiller-writer-plugin.mjs",
    toolOutputGlob: "/isolated/data/opencode/tool-output/*",
    source: {
      ...openCodeEnv(),
      HOME: "/must-not-leak",
      XDG_CONFIG_HOME: "/must-not-leak",
      OPENCODE_CONFIG_DIR: "/must-not-leak",
      TILLER_OPENCODE_PROVIDER_PACKAGE:
        "@ai-sdk/openai-compatible@must-not-leak",
    },
  });
  assert.deepEqual(config.enabled_providers, ["tiller-openai"]);
  assert.deepEqual(Object.keys(config.provider), ["tiller-openai"]);
  assert.equal(
    config.provider["tiller-openai"].npm,
    "@ai-sdk/openai-compatible",
  );
  assert.equal(config.model, "tiller-openai/gpt-model");
  assert.equal(config.small_model, config.model);
  assert.deepEqual(config.provider["tiller-openai"].models["gpt-model"].limit, {
    context: 1_000_000,
    input: 872_000,
    output: 128_000,
  });
  assert.equal(
    config.provider["tiller-openai"].models["gpt-model"].reasoning,
    true,
  );
  assert.deepEqual(
    config.provider["tiller-openai"].models["gpt-model"].variants,
    {
      high: { reasoningEffort: "high" },
    },
  );
  assert.equal(config.default_agent, "plan");
  assert.equal(config.agent.build.disable, true);
  assert.equal(config.agent.general.disable, true);
  assert.equal(config.agent.explore.disable, true);
  assert.deepEqual(Object.entries(config.agent.plan.permission), [
    ["*", "deny"],
    ["read", "allow"],
    ["glob", "allow"],
    ["grep", "allow"],
    ["question", "allow"],
    ["webfetch", "allow"],
    ["websearch", "allow"],
    ["publish_plan", "allow"],
    [
      "external_directory",
      {
        "*": "deny",
        "/isolated/data/opencode/tool-output/*": "deny",
      },
    ],
  ]);
  assert.deepEqual(config.mcp, {});
  assert.equal(config.share, "disabled");
  assert.equal(config.autoupdate, false);
  assert.equal(config.shell, "/bin/false");
  assert.equal(config.agent.plan.prompt, undefined);
});

test("OpenCode Plan Writer keeps managed context out of its static config", () => {
  const context = openCodeContext();
  const managedText =
    "Keep {file:/protected/secret.txt} and {env:TILLER_SECRET} literal.";
  context.instructions = [managedText];
  context.plan.markdown = `# Existing\n\n${managedText}\n`;
  const rendered = renderOpenCodePlanWriterConfig(
    buildOpenCodePlanWriterConfig({
      context,
      pluginPath: "/protected/tiller-writer-plugin.mjs",
      toolOutputGlob: "/isolated/data/opencode/tool-output/*",
      source: openCodeEnv(),
    }),
  );

  assert.doesNotMatch(rendered, /\{(?:file|env):[^}]+\}/);
  assert.equal(rendered.includes(managedText), false);
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.agent.plan.prompt, undefined);
});

test("OpenCode adds the direct managed plan MCP after deny-all", () => {
  const context = {
    ...openCodeContext(),
    capabilities: { repoPlansV1: true },
  };
  const config = buildOpenCodePlanWriterConfig({
    context,
    pluginPath: "/protected/tiller-writer-plugin.mjs",
    toolOutputGlob: "/isolated/data/opencode/tool-output/*",
    source: openCodeEnv(),
  });
  assert.deepEqual(config.mcp, {
    tiller_plans: {
      type: "local",
      command: ["tiller-plan-writer-plans-mcp"],
      enabled: true,
    },
  });
  assert.deepEqual(Object.entries(config.agent.plan.permission).slice(0, 12), [
    ["*", "deny"],
    ["read", "allow"],
    ["glob", "allow"],
    ["grep", "allow"],
    ["question", "allow"],
    ["webfetch", "allow"],
    ["websearch", "allow"],
    ["publish_plan", "allow"],
    ["tiller_plans_list_plans", "allow"],
    ["tiller_plans_read_plan", "allow"],
    ["tiller_plans_create_plan", "allow"],
    ["tiller_plans_update_plan", "allow"],
  ]);
});

test("OpenCode Plan Writer uses bundled provider identifiers for every credential family", () => {
  const cases = [
    {
      kind: "openai",
      alias: "tiller-openai",
      package: "@ai-sdk/openai-compatible",
      model: "gpt-native",
    },
    {
      kind: "anthropic",
      alias: "tiller-anthropic",
      package: "@ai-sdk/anthropic",
      model: "claude-native",
    },
    {
      kind: "cloudflare-workers-ai",
      alias: "tiller-hub",
      package: "@ai-sdk/openai-compatible",
      model: "workers-native",
    },
  ];
  for (const entry of cases) {
    const context = openCodeContext();
    context.writer.model = entry.model;
    const config = buildOpenCodePlanWriterConfig({
      context,
      pluginPath: "/protected/plugin.mjs",
      toolOutputGlob: "/isolated/data/opencode/tool-output/*",
      source: {
        ...openCodeEnv(),
        TILLER_OPENCODE_PROVIDER_KIND: entry.kind,
        TILLER_OPENCODE_PROVIDER_ALIAS: entry.alias,
        TILLER_OPENCODE_MODEL_ID: entry.model,
        TILLER_OPENCODE_MODEL_ALIAS: "selected-model",
        ...(entry.kind === "cloudflare-workers-ai"
          ? { CF_ACCESS_CLIENT_ID: "client", CF_ACCESS_CLIENT_SECRET: "secret" }
          : {}),
      },
    });
    assert.equal(config.provider[entry.alias].npm, entry.package);
    assert.deepEqual(Object.keys(config.provider), [entry.alias]);
    if (entry.kind === "cloudflare-workers-ai") {
      assert.deepEqual(config.provider[entry.alias].options.headers, {
        "CF-Access-Client-Id": "client",
        "CF-Access-Client-Secret": "secret",
      });
    }
  }
});

test("OpenCode Plan Writer rejects context and runtime model drift", () => {
  const context = openCodeContext();
  context.writer.model = "different-model";
  assert.throws(
    () =>
      buildOpenCodePlanWriterConfig({
        context,
        pluginPath: "/protected/plugin.mjs",
        toolOutputGlob: "/isolated/data/opencode/tool-output/*",
        source: openCodeEnv(),
      }),
    /does not match the frozen runtime selection/,
  );
});

test("OpenCode Plan Writer launch isolates writable state from protected config and HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiller-plan-writer-opencode-"));
  let runtimeRoot;
  t.after(async () => {
    for (const path of [
      runtimeRoot,
      runtimeRoot && join(runtimeRoot, "xdg-config"),
      runtimeRoot && join(runtimeRoot, "xdg-config", "opencode"),
      runtimeRoot && join(runtimeRoot, "managed"),
    ].filter(Boolean)) {
      await chmod(path, 0o700).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, "provider-home");
  await mkdir(home);
  const account = { uid: process.getuid(), gid: process.getgid() };
  const launch = await buildOpenCodeLaunch({
    context: openCodeContext(),
    checkoutDir: "/workspace",
    home,
    socketPath: join(root, "supervisor.sock"),
    contextPath: join(root, "managed-context.md"),
    terminalId: "plan-writer-terminal",
    account,
    protectedOwner: account,
    source: openCodeEnv(),
  });
  runtimeRoot = dirname(launch.env.HOME);
  assert.deepEqual(launch.args, [
    "/workspace",
    "--agent",
    "plan",
    "--model",
    "tiller-openai/gpt-model",
    "--mini",
    "--no-replay",
  ]);
  assert.equal(launch.conversationId, "opencode:plan-writer-terminal");
  assert.equal(launch.env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(launch.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_DEFAULT_PLUGINS, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_EXTERNAL_SKILLS, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_AUTOUPDATE, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_SHARE, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_LSP_DOWNLOAD, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_MODELS_FETCH, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(launch.env.OPENCODE_DISABLE_TERMINAL_TITLE, "1");
  assert.equal(launch.env.OPENCODE_ENABLE_QUESTION_TOOL, "1");
  assert.equal(launch.env.OPENCODE_ENABLE_EXA, "1");
  assert.equal(launch.env.OPENCODE_WEBSEARCH_PROVIDER, "exa");
  assert.equal(launch.env.SHELL, "/bin/false");
  assert.equal(launch.env.TILLER_OPENCODE_AUTH_TOKEN, undefined);
  assert.equal(launch.env.TILLER_OPENCODE_PROVIDER_PACKAGE, undefined);
  assert.equal((await stat(launch.env.HOME)).mode & 0o777, 0o555);
  assert.equal((await stat(runtimeRoot)).mode & 0o777, 0o555);
  assert.equal((await stat(launch.env.XDG_CONFIG_HOME)).mode & 0o777, 0o555);
  assert.deepEqual(await readdir(launch.env.HOME), []);
  assert.deepEqual(await readdir(home), []);
  assert.deepEqual(await readdir(launch.env.XDG_CONFIG_HOME), ["opencode"]);
  assert.deepEqual(
    await readdir(join(launch.env.XDG_CONFIG_HOME, "opencode")),
    [],
  );
  for (const name of [
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
  ]) {
    assert.equal((await stat(launch.env[name])).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(launch.env[name]), []);
  }
  assert.equal((await stat(launch.env.OPENCODE_CONFIG)).mode & 0o777, 0o444);
  const config = JSON.parse(await readFile(launch.env.OPENCODE_CONFIG, "utf8"));
  assert.equal(config.plugin.length, 1);
  assert.doesNotMatch(
    config.plugin[0],
    /provider-home|opencode-xdg|\/workspace/,
  );
  assert.equal(
    (await stat(fileURLToPath(config.plugin[0]))).mode & 0o777,
    0o444,
  );
});

test("OpenCode Plan Writer refuses to reuse a generation runtime directory", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "tiller-plan-writer-opencode-reuse-"),
  );
  const home = join(root, "provider-home");
  await mkdir(home);
  const account = { uid: process.getuid(), gid: process.getgid() };
  const input = {
    context: openCodeContext(),
    checkoutDir: "/workspace",
    home,
    socketPath: join(root, "supervisor.sock"),
    contextPath: join(root, "managed-context.md"),
    terminalId: "plan-writer-terminal",
    account,
    protectedOwner: account,
    source: openCodeEnv(),
  };
  const launch = await buildOpenCodeLaunch(input);
  const runtimeRoot = dirname(launch.env.HOME);
  t.after(async () => {
    for (const path of [
      runtimeRoot,
      join(runtimeRoot, "xdg-config"),
      join(runtimeRoot, "xdg-config", "opencode"),
      join(runtimeRoot, "managed"),
    ])
      await chmod(path, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(buildOpenCodeLaunch(input), /EEXIST/);
  assert.deepEqual(await readdir(launch.env.HOME), []);
});

test("OpenCode managed plugin carries the minimal hook protocol and exact deadlines", () => {
  const plugin = renderOpenCodePlanWriterPlugin({
    socketPath: "/run/supervisor.sock",
    contextPath: "/run/managed-context.md",
    checkoutDir: "/workspace",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  assert.equal(OPENCODE_READY_DEADLINE_MS, 45_000);
  assert.equal(PLAN_WRITER_PUBLICATION_DEADLINE_MS, 120_000);
  assert.match(plugin, /runtime\.callID/);
  assert.match(plugin, /model\?\.modelID \?\? model\?\.id/);
  assert.doesNotMatch(plugin, /context\.abort|publicationDeadlineMs/);
  assert.match(plugin, /"tool\.execute\.before"/);
  assert.match(plugin, /experimental\.chat\.system\.transform/);
  assert.match(
    plugin,
    /throw new Error\("OpenCode did not provide publish_plan runtime callID/,
  );
  assert.match(plugin, /type: "bind"/);
  assert.match(plugin, /type: "activity"/);
  assert.match(plugin, /type: "publish"/);
  assert.match(plugin, /type: "ready"/);
  assert.doesNotMatch(plugin, /terminalId|nonce|invariant-error/);
});

test("OpenCode readiness completes only after every signal and enforces its deadline", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const ready = waitForOpenCodeReady([Promise.resolve(), pending], 100);
  release();
  await ready;
  await assert.rejects(
    waitForOpenCodeReady([new Promise(() => {})], 5),
    /within 5ms/,
  );
});

test("OpenCode managed plugin binds activity and retries publication with the runtime callID", async (t) => {
  let failPublication = true;
  const { hooks, messages } = await loadManagedOpenCodePlugin(t, (message) => {
    if (
      message.type === "bind" &&
      (message.modelId !== "model" || message.variant !== "high")
    ) {
      return { status: 409, body: { error: "changed model or effort" } };
    }
    if (message.type === "publish" && failPublication) {
      failPublication = false;
      return { status: 500, body: { error: "retry publication" } };
    }
    return undefined;
  });
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "busy" } },
    },
  });
  const context = {
    sessionID: "session-1",
    agent: "plan",
    abort: new AbortController().signal,
    callID: "call-1",
  };
  await assert.rejects(
    hooks.tool.publish_plan.execute({ markdown: "# Plan" }, context),
    /retry publication/,
  );
  await hooks.tool.publish_plan.execute({ markdown: "# Plan" }, context);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["ready", "bind", "activity", "publish", "publish"],
  );
  assert.equal(messages.at(-1).callID, "call-1");
  assert.equal(messages.at(-1).sessionId, "session-1");
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "retry" } },
    },
  });
  assert.equal(messages.at(-1).type, "activity");
  assert.equal(messages.at(-1).state, "retry");
  await hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "idle" } },
    },
  });
  assert.equal(messages.at(-1).type, "activity");
  assert.equal(messages.at(-1).state, "idle");
  assert.equal(
    messages.every(
      (message) => !("terminalId" in message) && !("nonce" in message),
    ),
    true,
  );
  await assert.rejects(
    hooks.tool.publish_plan.execute(
      { markdown: 42 },
      { ...context, callID: "invalid-arguments" },
    ),
    /requires non-empty Markdown/,
  );
  assert.equal(
    messages.some((message) => message.callID === "invalid-arguments"),
    false,
  );
  await assert.rejects(
    hooks["chat.message"](
      { sessionID: "session-1" },
      resolvedOpenCodeChatOutput({
        message: {
          model: {
            providerID: "provider",
            modelID: "other-model",
            variant: "high",
          },
        },
      }),
    ),
    /hook returned HTTP 409|different|changed/i,
  );
  assert.equal(messages.at(-1).type, "bind");
  await assert.rejects(
    hooks["chat.message"](
      { sessionID: "session-1" },
      resolvedOpenCodeChatOutput({
        message: {
          model: {
            providerID: "provider",
            modelID: "model",
            variant: "low",
          },
        },
      }),
    ),
    /hook returned HTTP 409|effort|changed/i,
  );
  assert.equal(messages.at(-1).variant, "low");
});

test("OpenCode managed plugin binds from the complete chat identity", async (t) => {
  const { hooks, messages } = await loadManagedOpenCodePlugin(
    t,
    () => undefined,
  );
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  assert.deepEqual(messages.at(-1), {
    type: "bind",
    sessionId: "session-1",
    agent: "plan",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
});

test("OpenCode managed plugin fails closed for missing or conflicting resolved chat identity", async (t) => {
  for (const [label, message] of [
    ["missing", { sessionID: "session-1", agent: "plan" }],
    [
      "conflicting",
      {
        sessionID: "session-1",
        agent: "build",
        model: { providerID: "provider", modelID: "model" },
      },
    ],
  ]) {
    await t.test(label, async (childTest) => {
      const { hooks, messages } = await loadManagedOpenCodePlugin(
        childTest,
        (entry) =>
          entry.type === "bind" &&
          (!entry.sessionId ||
            entry.agent !== "plan" ||
            entry.providerId !== "provider" ||
            entry.modelId !== "model" ||
            entry.variant !== "high")
            ? { status: 409, body: { error: "chat identity drift" } }
            : undefined,
      );
      await assert.rejects(
        hooks["chat.message"](
          { sessionID: "session-1" },
          { message, parts: [] },
        ),
        /chat identity drift/,
      );
      assert.equal(messages.at(-1).type, "bind");
    });
  }
});

test("OpenCode managed plugin reports observed pre-bind identity without synthesizing frozen fields", async (t) => {
  const fence = new OpenCodeGenerationFence({
    agent: "plan",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  const { hooks, messages } = await loadManagedOpenCodePlugin(t, (message) => {
    const action = fence.accept(message);
    return action.kind === "violation"
      ? { status: 409, body: { error: action.message } }
      : undefined;
  });

  await assert.rejects(
    hooks["experimental.chat.system.transform"](
      {
        sessionID: "unexpected-session",
        model: { providerID: "provider", modelID: "unexpected-model" },
      },
      { system: [] },
    ),
    /complete chat identity/,
  );
  assert.equal(fence.boundSessionId, null);
  assert.deepEqual(messages.at(-1), {
    type: "bind",
    sessionId: "unexpected-session",
    providerId: "provider",
    modelId: "unexpected-model",
  });
});

test("OpenCode managed plugin refreshes protected context for every request", async (t) => {
  const { hooks, writeContext } = await loadManagedOpenCodePlugin(
    t,
    () => undefined,
  );
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  const first = { system: ["base"] };
  await hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-1",
      model: { providerID: "provider", id: "model" },
    },
    first,
  );
  assert.deepEqual(first.system, ["base", "initial managed context\n"]);

  await writeContext("refreshed managed context\n");
  const second = { system: ["base"] };
  await hooks["experimental.chat.system.transform"](
    {
      sessionID: "session-1",
      model: { providerID: "provider", id: "model" },
    },
    second,
  );
  assert.deepEqual(second.system, ["base", "refreshed managed context\n"]);
});

test("OpenCode managed plugin canonically fences reads and resolved attachments", async (t) => {
  const { hooks, root, checkoutDir } = await loadManagedOpenCodePlugin(
    t,
    () => undefined,
  );
  const insidePath = join(checkoutDir, "inside.txt");
  const externalPath = join(root, "external.txt");
  const escapePath = join(checkoutDir, "escape.txt");
  await writeFile(insidePath, "inside\n");
  await writeFile(externalPath, "outside\n");
  await symlink(externalPath, escapePath);
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  const canonicalCheckoutDir = await realpath(checkoutDir);

  const insideRead = { args: { filePath: insidePath } };
  await hooks["tool.execute.before"](
    { tool: "read", sessionID: "session-1", callID: "read-inside" },
    insideRead,
  );
  assert.equal(insideRead.args.filePath, join(canonicalCheckoutDir, "inside.txt"));
  for (const [label, filePath] of [
    ["external read", externalPath],
    ["symlink read", escapePath],
    ["missing external read", join(root, "missing.txt")],
  ]) {
    await t.test(label, async () => {
      const output = { args: { filePath } };
      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "session-1", callID: label },
        output,
      );
      assert.equal(
        output.args.filePath,
        join(canonicalCheckoutDir, ".git", "tiller-opencode-read-denied"),
      );
    });
  }

  const missingInside = join(checkoutDir, "missing.txt");
  const missingInsideRead = { args: { filePath: missingInside } };
  await hooks["tool.execute.before"](
    { tool: "read", sessionID: "session-1", callID: "missing-inside" },
    missingInsideRead,
  );
  assert.equal(
    missingInsideRead.args.filePath,
    join(canonicalCheckoutDir, "missing.txt"),
  );

  const readMarker = (filePath) => ({
    type: "text",
    synthetic: true,
    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath })}`,
  });
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput({ parts: [readMarker(externalPath)] }),
  );
  const unseenExternalPath = join(root, "unseen-external.txt");
  await writeFile(unseenExternalPath, "unseen outside\n");
  await assert.rejects(
    hooks["chat.message"](
      { sessionID: "session-1" },
      resolvedOpenCodeChatOutput({ parts: [readMarker(unseenExternalPath)] }),
    ),
    /outside the managed checkout/,
  );
  for (const [label, parts] of [
    [
      "absolute attachment",
      [
        readMarker(externalPath),
        { type: "file", url: pathToFileURL(externalPath).href },
      ],
    ],
    [
      "symlink attachment",
      [
        readMarker(escapePath),
        { type: "file", url: pathToFileURL(escapePath).href },
      ],
    ],
    [
      "symbol attachment",
      [
        {
          type: "file",
          url: "data:text/plain;base64,b3V0c2lkZQ==",
          source: { type: "symbol", path: externalPath },
        },
      ],
    ],
  ]) {
    await t.test(label, async () => {
      await assert.rejects(
        hooks["chat.message"](
          { sessionID: "session-1" },
          resolvedOpenCodeChatOutput({ parts }),
        ),
        /outside the managed checkout/,
      );
    });
  }
});

test("OpenCode managed plugin serializes a delayed chat binding before status activity", async (t) => {
  let releaseBind;
  let markBindReceived;
  const bindReceived = new Promise((resolve) => {
    markBindReceived = resolve;
  });
  const bindResponse = new Promise((resolve) => {
    releaseBind = resolve;
  });
  const { hooks, messages } = await loadManagedOpenCodePlugin(
    t,
    async (message) => {
      if (message.type === "bind") {
        markBindReceived();
        await bindResponse;
      }
    },
  );
  const binding = hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  await bindReceived;
  const busy = hooks.event({
    event: {
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "busy" } },
    },
  });
  await delay(10);
  assert.deepEqual(
    messages.map((message) => [message.type, message.state]),
    [
      ["ready", undefined],
      ["bind", undefined],
    ],
  );
  releaseBind();
  await Promise.all([binding, busy]);
  assert.deepEqual(
    messages.map((message) => [message.type, message.state]),
    [
      ["ready", undefined],
      ["bind", undefined],
      ["activity", "busy"],
    ],
  );
});

test("OpenCode managed plugin leaves publication timeout authority with the supervisor", async (t) => {
  let releasePublication;
  const publicationResponse = new Promise((resolve) => {
    releasePublication = resolve;
  });
  const { hooks } = await loadManagedOpenCodePlugin(t, async (message) => {
    if (message.type === "publish") await publicationResponse;
  });
  await hooks["chat.message"](
    { sessionID: "session-1" },
    resolvedOpenCodeChatOutput(),
  );
  const cancellation = new AbortController();
  const publication = hooks.tool.publish_plan.execute(
    { markdown: "# Plan" },
    {
      sessionID: "session-1",
      agent: "plan",
      abort: cancellation.signal,
      callID: "cancel-call",
    },
  );
  cancellation.abort();
  let settled = false;
  void publication.finally(() => {
    settled = true;
  });
  await delay(20);
  assert.equal(settled, false);
  releasePublication();
  await publication;
});

test("publication deadline covers queueing and prevents an expired late commit", async () => {
  const generation = new AbortController();
  const queue = new PlanWriterPublicationQueue(generation.signal, 20);
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = queue.enqueue(async () => {
    await firstGate;
  });
  void first.catch(() => undefined);
  let lateCommits = 0;
  const expired = queue.enqueue(async () => {
    lateCommits += 1;
  });
  const expiredAssertion = assert.rejects(expired, /timeout|aborted/i);
  const firstAssertion = assert.rejects(first, /timeout|aborted/i);
  await delay(30);
  await Promise.all([expiredAssertion, firstAssertion]);
  releaseFirst();
  await delay(20);
  assert.equal(lateCommits, 0);
});

test("publication shutdown cancels active and queued work with one generation signal", async () => {
  const generation = new AbortController();
  const queue = new PlanWriterPublicationQueue(generation.signal, 1_000);
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const active = queue.enqueue(
    (signal) =>
      new Promise((resolve, reject) => {
        markStarted();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  void active.catch(() => undefined);
  await started;

  let queuedRuns = 0;
  const queued = queue.enqueue(async () => {
    queuedRuns += 1;
  });
  void queued.catch(() => undefined);
  generation.abort(new Error("writer generation stopped"));

  await assert.rejects(active, /generation stopped/);
  await assert.rejects(queued, /generation stopped/);
  await delay(10);
  assert.equal(queuedRuns, 0);
});

const pinnedOpenCodeSmokeCases = [
  {
    label: "OpenAI",
    providerKind: "openai",
    providerAlias: "tiller-openai",
    providerLabel: "OpenAI",
    modelId: "gpt-native",
    modelAlias: "gpt-model",
    modelLabel: "GPT Model",
    contextLimit: 1_050_000,
    inputLimit: 922_000,
    outputLimit: 128_000,
    api: "openai",
  },
  {
    label: "Anthropic",
    providerKind: "anthropic",
    providerAlias: "tiller-anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-native",
    modelAlias: "claude-model",
    modelLabel: "Claude Model",
    contextLimit: 1_000_000,
    outputLimit: 128_000,
    api: "anthropic",
  },
  {
    label: "Workers AI",
    providerKind: "cloudflare-workers-ai",
    providerAlias: "tiller-hub",
    providerLabel: "Tiller Hub",
    modelId: "workers-native",
    modelAlias: "workers-model",
    modelLabel: "Workers Model",
    contextLimit: 262_144,
    outputLimit: 262_144,
    api: "openai",
    accessHeaders: true,
  },
];

function sendOpenAICompatibleSmokeResponse(response, input) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chunk = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const base = {
    id: `response-${input.requestIndex}`,
    object: "chat.completion.chunk",
    created: 1,
    model: input.modelId,
  };
  if (!input.main || input.requestIndex > 4) {
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: input.main ? "Published." : "Smoke title",
          },
          finish_reason: null,
        },
      ],
    });
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  } else {
    const call =
      input.requestIndex === 1
        ? {
            id: "call-read-external",
            name: "read",
            args: { filePath: input.externalPath },
          }
        : input.requestIndex === 2
          ? {
              id: "call-read",
              name: "read",
              args: { filePath: input.factPath },
            }
          : input.requestIndex === 3
            ? {
                id: "call-webfetch",
                name: "webfetch",
                args: { url: input.researchUrl, format: "text" },
              }
            : {
                id: "call-publish",
                name: "publish_plan",
                args: {
                  markdown:
                    "# Smoke plan\n\nResearch found sapphire and cobalt.",
                },
              };
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                index: 0,
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunk({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendAnthropicSmokeResponse(response, input) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const event = (name, value) =>
    response.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: `message-${input.requestIndex}`,
      type: "message",
      role: "assistant",
      model: input.modelId,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  if (!input.main || input.requestIndex > 4) {
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: input.main ? "Published." : "Smoke title",
      },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
  } else {
    const call =
      input.requestIndex === 1
        ? {
            id: "call-read-external",
            name: "read",
            args: { filePath: input.externalPath },
          }
        : input.requestIndex === 2
          ? {
              id: "call-read",
              name: "read",
              args: { filePath: input.factPath },
            }
          : input.requestIndex === 3
            ? {
                id: "call-webfetch",
                name: "webfetch",
                args: { url: input.researchUrl, format: "text" },
              }
            : {
                id: "call-publish",
                name: "publish_plan",
                args: {
                  markdown:
                    "# Smoke plan\n\nResearch found sapphire and cobalt.",
                },
              };
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: {},
      },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(call.args),
      },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
  }
  event("message_stop", { type: "message_stop" });
  response.end();
}

for (const smokeCase of pinnedOpenCodeSmokeCases) {
  test(
    `pinned OpenCode completes a read-only ${smokeCase.label} Scribe publication`,
    {
      skip: process.env.TILLER_PINNED_OPENCODE_BIN
        ? false
        : "set TILLER_PINNED_OPENCODE_BIN for the image lifecycle smoke test",
    },
    async (t) => {
      const binary = process.env.TILLER_PINNED_OPENCODE_BIN;
      const root = await mkdtemp(
        join(tmpdir(), `tiller-pinned-opencode-${smokeCase.providerKind}-`),
      );
      const checkout = join(root, "checkout");
      const providerHome = join(root, "provider-home");
      const factPath = join(checkout, "facts.txt");
      const substitutionPath = join(root, "substitution-secret.txt");
      const externalReadLink = join(checkout, "external-link.txt");
      const socketPath = join(root, "supervisor.sock");
      await mkdir(checkout);
      await mkdir(providerHome);
      await createOpenCodeDeniedReadMarker(checkout);
      await writeFile(factPath, "Tiller fact: sapphire.\n");
      await writeFile(substitutionPath, "file-substitution-secret\n");
      await symlink(substitutionPath, externalReadLink);
      await chmod(checkout, 0o555);
      await chmod(factPath, 0o444);

      const hookMessages = [];
      let markPublished;
      const published = new Promise((resolve) => {
        markPublished = resolve;
      });
      let markIdle;
      const idle = new Promise((resolve) => {
        markIdle = resolve;
      });
      let managedContextPath;
      const hookFence = new OpenCodeGenerationFence({
        agent: "plan",
        providerId: smokeCase.providerAlias,
        modelId: smokeCase.modelAlias,
        variant: "high",
      });
      const hookServer = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const message = JSON.parse(raw);
        hookMessages.push(message);
        if (message.type === "activity" && message.state === "idle") markIdle();
        const action = hookFence.accept(message);
        if (action.kind === "violation") {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: action.message }));
          return;
        }
        if (action.kind === "publication") {
          await writeFile(
            managedContextPath,
            "refreshed managed context marker\n",
          );
          markPublished();
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"ok":true}');
      });
      await new Promise((resolve, reject) => {
        hookServer.once("error", reject);
        hookServer.listen(socketPath, resolve);
      });

      let mainRequestCount = 0;
      let webResearchRequests = 0;
      let researchUrl = "";
      const mainRequests = [];
      const providerServer = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/research") {
          webResearchRequests += 1;
          response.writeHead(200, { "Content-Type": "text/plain" });
          response.end("Loopback web research: cobalt.\n");
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const main = Array.isArray(body.tools) && body.tools.length > 0;
        if (main) {
          mainRequestCount += 1;
          mainRequests.push({
            body,
            headers: request.headers,
            url: request.url,
          });
        }
        const input = {
          main,
          requestIndex: main ? mainRequestCount : 0,
          factPath,
          externalPath: externalReadLink,
          researchUrl,
          modelId: smokeCase.modelId,
        };
        if (smokeCase.api === "anthropic")
          sendAnthropicSmokeResponse(response, input);
        else sendOpenAICompatibleSmokeResponse(response, input);
      });
      await new Promise((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      assert.equal(typeof address, "object");
      researchUrl = `http://127.0.0.1:${address.port}/research`;

      const account = { uid: process.getuid(), gid: process.getgid() };
      let launch;
      t.after(async () => {
        hookServer.closeAllConnections();
        providerServer.closeAllConnections();
        await Promise.all([
          new Promise((resolve) => hookServer.close(resolve)),
          new Promise((resolve) => providerServer.close(resolve)),
        ]);
        if (launch) {
          const runtimeRoot = dirname(launch.env.HOME);
          for (const path of [
            runtimeRoot,
            launch.env.HOME,
            launch.env.XDG_CONFIG_HOME,
            join(launch.env.XDG_CONFIG_HOME, "opencode"),
            dirname(launch.env.OPENCODE_CONFIG),
          ])
            await chmod(path, 0o700).catch(() => undefined);
        }
        await chmod(join(checkout, ".git"), 0o700).catch(() => undefined);
        await chmod(checkout, 0o700).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      });

      const context = openCodeContext();
      context.writer.model = smokeCase.modelId;
      context.instructions = [
        `Preserve {file:${substitutionPath}} and {env:COLORTERM} as literal managed text.`,
      ];
      const contextPath = join(root, "managed-context.md");
      managedContextPath = contextPath;
      await writeFile(contextPath, renderManagedPlanWriterContext(context));
      launch = await buildOpenCodeLaunch({
        context,
        checkoutDir: checkout,
        home: providerHome,
        socketPath,
        contextPath,
        terminalId: "pinned-terminal",
        account,
        protectedOwner: account,
        source: {
          PATH: process.env.PATH,
          TERM: "xterm-256color",
          TILLER_OPENCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          TILLER_OPENCODE_AUTH_TOKEN: "secret",
          TILLER_OPENCODE_PROVIDER_KIND: smokeCase.providerKind,
          TILLER_OPENCODE_PROVIDER_ALIAS: smokeCase.providerAlias,
          TILLER_OPENCODE_PROVIDER_LABEL: smokeCase.providerLabel,
          TILLER_OPENCODE_MODEL_ID: smokeCase.modelId,
          TILLER_OPENCODE_MODEL_ALIAS: smokeCase.modelAlias,
          TILLER_OPENCODE_MODEL_LABEL: smokeCase.modelLabel,
          TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: String(smokeCase.contextLimit),
          ...(smokeCase.inputLimit
            ? {
                TILLER_OPENCODE_MODEL_INPUT_LIMIT: String(smokeCase.inputLimit),
              }
            : {}),
          TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: String(smokeCase.outputLimit),
          COLORTERM: "env-substitution-secret",
          ...(smokeCase.accessHeaders
            ? {
                CF_ACCESS_CLIENT_ID: "client-id",
                CF_ACCESS_CLIENT_SECRET: "client-secret",
              }
            : {}),
        },
      });

      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          binary,
          [
            "run",
            ...launch.args
              .slice(1)
              .filter(
                (argument) =>
                  argument !== "--mini" && argument !== "--no-replay",
              ),
            `Read facts.txt, fetch ${researchUrl}, and publish the researched plan.`,
          ],
          {
            cwd: checkout,
            env: launch.env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        let publicationObserved = false;
        let idleObserved = false;
        let completed = false;
        const finishWhenComplete = () => {
          if (
            completed ||
            !publicationObserved ||
            !idleObserved ||
            !stdout.includes("Published.")
          ) {
            return;
          }
          completed = true;
          clearTimeout(deadline);
          child.kill("SIGKILL");
        };
        void published.then(() => {
          publicationObserved = true;
          finishWhenComplete();
        });
        void idle.then(() => {
          idleObserved = true;
          finishWhenComplete();
        });
        child.stdout.on("data", (chunk) => {
          stdout = `${stdout}${chunk}`.slice(-1024 * 1024);
          finishWhenComplete();
        });
        child.stderr.on("data", (chunk) => {
          stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
        });
        const deadline = setTimeout(() => {
          child.kill();
          reject(
            new Error(`Pinned OpenCode lifecycle smoke timed out. ${stderr}`),
          );
        }, 60_000);
        child.once("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(deadline);
          if (completed || code === 0) resolve({ stdout, stderr });
          else
            reject(
              new Error(
                `Pinned OpenCode lifecycle smoke exited ${code}. ${stderr}`,
              ),
            );
        });
      });
      assert.match(result.stdout, /Published\./);
      assert.match(result.stderr, /Read facts\.txt/);
      assert.match(result.stderr, /publish_plan/);
      assert.equal(mainRequests.length, 5);
      assert.match(
        JSON.stringify(mainRequests[1].body),
        /external read denied|outside the managed checkout/i,
      );
      assert.match(JSON.stringify(mainRequests[2].body), /sapphire/);
      assert.match(JSON.stringify(mainRequests[3].body), /cobalt/);
      assert.match(
        JSON.stringify(mainRequests[4].body),
        /refreshed managed context marker/,
      );
      assert.equal(webResearchRequests, 1);
      const initialRequest = JSON.stringify(mainRequests[0].body);
      assert.equal(initialRequest.includes(`{file:${substitutionPath}}`), true);
      assert.equal(initialRequest.includes("{env:COLORTERM}"), true);
      assert.equal(initialRequest.includes("file-substitution-secret"), false);
      assert.equal(initialRequest.includes("env-substitution-secret"), false);

      const offeredTools = mainRequests[0].body.tools.map((tool) =>
        smokeCase.api === "anthropic" ? tool.name : tool.function.name,
      );
      const allowedTools = new Set([
        "read",
        "glob",
        "grep",
        "webfetch",
        "websearch",
        "publish_plan",
      ]);
      assert.equal(offeredTools.includes("read"), true);
      assert.equal(offeredTools.includes("publish_plan"), true);
      assert.equal(
        offeredTools.every((tool) => allowedTools.has(tool)),
        true,
      );
      for (const denied of [
        "bash",
        "edit",
        "write",
        "apply_patch",
        "task",
        "plan_exit",
      ]) {
        assert.equal(
          offeredTools.includes(denied),
          false,
          `${denied} must not be offered`,
        );
      }
      assert.deepEqual(
        offeredTools.filter((tool) => tool.includes("mcp")),
        [],
      );

      const publication = hookMessages.find(
        (message) => message.type === "publish",
      );
      assert.deepEqual(
        hookMessages.find((message) => message.type === "bind"),
        {
          type: "bind",
          sessionId: publication.sessionId,
          agent: "plan",
          providerId: smokeCase.providerAlias,
          modelId: smokeCase.modelAlias,
          variant: "high",
        },
      );
      assert.deepEqual(publication, {
        type: "publish",
        sessionId: publication.sessionId,
        callID: "call-publish",
        markdown: "# Smoke plan\n\nResearch found sapphire and cobalt.",
      });
      assert.equal(hookMessages[0]?.type, "ready");
      assert.equal(
        hookMessages.some(
          (message) => message.type === "activity" && message.state === "busy",
        ),
        true,
      );
      assert.equal(
        hookMessages.some(
          (message) => message.type === "activity" && message.state === "idle",
        ),
        true,
      );
      if (smokeCase.api === "anthropic") {
        assert.equal(mainRequests[0].url, "/v1/messages");
        assert.equal(mainRequests[0].headers["x-api-key"], "secret");
      } else {
        assert.equal(mainRequests[0].url, "/v1/chat/completions");
        assert.equal(mainRequests[0].headers.authorization, "Bearer secret");
      }
      if (smokeCase.accessHeaders) {
        assert.equal(
          mainRequests[0].headers["cf-access-client-id"],
          "client-id",
        );
        assert.equal(
          mainRequests[0].headers["cf-access-client-secret"],
          "client-secret",
        );
      }
    },
  );
}

test(
  "pinned OpenCode starts from an empty isolated cache without protected writes or provider requests",
  {
    skip: process.env.TILLER_PINNED_OPENCODE_BIN
      ? false
      : "set TILLER_PINNED_OPENCODE_BIN for the image contract smoke test",
  },
  async (t) => {
    const binary = process.env.TILLER_PINNED_OPENCODE_BIN;
    const root = await mkdtemp(join(tmpdir(), "tiller-pinned-opencode-"));
    const checkout = join(root, "checkout");
    const home = join(root, "provider-home");
    const socketPath = join(root, "supervisor.sock");
    const managedConfigLink = join(checkout, "managed-config-link.json");
    await mkdir(checkout);
    await mkdir(home);
    await createOpenCodeDeniedReadMarker(checkout);
    const hookMessages = [];
    let markReady;
    let readyAt;
    const ready = new Promise((resolve) => {
      markReady = resolve;
    });
    const hookServer = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      hookMessages.push(message);
      if (message.type === "ready") {
        readyAt = Date.now();
        markReady();
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise((resolve, reject) => {
      hookServer.once("error", reject);
      hookServer.listen(socketPath, resolve);
    });
    let providerRequests = 0;
    const providerServer = createServer((_request, response) => {
      providerRequests += 1;
      response.writeHead(503);
      response.end();
    });
    await new Promise((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const address = providerServer.address();
    assert.equal(typeof address, "object");
    const account = { uid: process.getuid(), gid: process.getgid() };
    let runtimeRoot;
    const context = openCodeContext();
    const contextPath = join(root, "managed-context.md");
    await writeFile(contextPath, renderManagedPlanWriterContext(context));
    const launch = await buildOpenCodeLaunch({
      context,
      checkoutDir: checkout,
      home,
      socketPath,
      contextPath,
      terminalId: "pinned-terminal",
      account,
      protectedOwner: account,
      source: {
        ...openCodeEnv(),
        TILLER_OPENCODE_AUTH_TOKEN: "tiller-native-shell-secret-7f34",
        TILLER_OPENCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      },
    });
    runtimeRoot = dirname(launch.env.HOME);
    await symlink(launch.env.OPENCODE_CONFIG, managedConfigLink);
    await chmod(checkout, 0o555);
    const configBefore = await readFile(launch.env.OPENCODE_CONFIG);
    const config = JSON.parse(configBefore.toString("utf8"));
    const pluginPath = fileURLToPath(config.plugin[0]);
    const pluginBefore = await readFile(pluginPath);
    const startedAt = Date.now();
    const child = pty.spawn(binary, launch.args, {
      cwd: checkout,
      env: launch.env,
      cols: 100,
      rows: 30,
      name: "xterm-256color",
    });
    let output = "";
    let markFirstOutput;
    const firstOutput = new Promise((resolve) => {
      markFirstOutput = resolve;
    });
    const terminalQueue = new TerminalOperationQueue(
      {
        write: (data) => child.write(data),
        resize: (cols, rows) => child.resize(cols, rows),
      },
      { cols: 100, rows: 30 },
      {
        onFilteredOutput(data) {
          output = `${output}${data}`.slice(-8_000);
          markFirstOutput();
        },
      },
    );
    child.onData((data) => {
      terminalQueue.enqueueOutput(data);
    });
    const exited = new Promise((resolve) =>
      child.onExit(({ exitCode }) => resolve(exitCode)),
    );
    let childStopped = false;
    const stopChild = async () => {
      if (childStopped) return;
      childStopped = true;
      child.kill("SIGKILL");
      let killDeadline;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          killDeadline = setTimeout(resolve, 5_000);
        }),
      ]);
      if (killDeadline) clearTimeout(killDeadline);
      await terminalQueue.close();
    };
    try {
      await Promise.race([
        Promise.all([firstOutput, waitForOpenCodeReady([ready])]),
        exited.then((code) => {
          throw new Error(
            `Pinned OpenCode exited before ready (${code}). ${output}`,
          );
        }),
      ]).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${output}`,
        );
      });
      assert.ok(readyAt - startedAt < OPENCODE_READY_DEADLINE_MS);
      await delay(100);
      assert.equal(providerRequests, 0);
      assert.equal(hookMessages[0]?.type, "ready");
      assert.deepEqual(await readdir(launch.env.HOME), []);
      assert.deepEqual(await readdir(home), []);
      assert.deepEqual(await readdir(launch.env.XDG_CONFIG_HOME), ["opencode"]);
      assert.deepEqual(
        await readdir(join(launch.env.XDG_CONFIG_HOME, "opencode")),
        [],
      );
      assert.deepEqual(await readdir(checkout), [
        ".git",
        "managed-config-link.json",
      ]);
      assert.deepEqual(
        await readFile(launch.env.OPENCODE_CONFIG),
        configBefore,
      );
      assert.deepEqual(await readFile(pluginPath), pluginBefore);
      await assert.rejects(
        stat(join(launch.env.XDG_CACHE_HOME, "opencode", "node_modules")),
      );
      await assert.rejects(
        stat(join(launch.env.XDG_CACHE_HOME, "opencode", "package.json")),
      );

      const shellWritePath = join(launch.env.TMPDIR, "native-shell-write");
      const credentialCopyPath = join(
        launch.env.TMPDIR,
        "native-shell-credential-copy",
      );
      child.write(`!touch ${shellWritePath}\r`);
      await delay(500);
      await assert.rejects(stat(shellWritePath));
      child.write(
        `!cat ${launch.env.OPENCODE_CONFIG} > ${credentialCopyPath}\r`,
      );
      await delay(500);
      await assert.rejects(stat(credentialCopyPath));
      child.write(`!cat ${launch.env.OPENCODE_CONFIG}\r`);
      await delay(500);
      assert.equal(output.includes("tiller-native-shell-secret-7f34"), false);

      await stopChild();
      const debugResult = await execFileAsync(
        binary,
        ["debug", "agent", "plan"],
        {
          cwd: checkout,
          env: launch.env,
          timeout: OPENCODE_READY_DEADLINE_MS,
          maxBuffer: 1024 * 1024,
        },
      );
      const debugAgent = JSON.parse(debugResult.stdout);
      for (const tool of [
        "read",
        "glob",
        "grep",
        "question",
        "webfetch",
        "websearch",
        "publish_plan",
      ]) {
        assert.equal(
          debugAgent.tools[tool],
          true,
          `${tool} should be available`,
        );
      }
      for (const tool of [
        "bash",
        "edit",
        "write",
        "apply_patch",
        "task",
        "plan_exit",
      ]) {
        assert.notEqual(
          debugAgent.tools[tool],
          true,
          `${tool} should be unavailable`,
        );
      }
      assert.deepEqual(
        Object.keys(debugAgent.tools).filter((tool) => tool.includes("mcp")),
        [],
      );
      assert.equal(
        debugAgent.permission
          .filter(
            (rule) =>
              rule.permission === "*" ||
              rule.permission === "external_directory",
          )
          .at(-1).action,
        "deny",
      );
    } finally {
      await stopChild();
      hookServer.closeAllConnections();
      providerServer.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => hookServer.close(resolve)),
        new Promise((resolve) => providerServer.close(resolve)),
      ]);
      for (const path of [
        checkout,
        join(checkout, ".git"),
        runtimeRoot,
        launch.env.HOME,
        launch.env.XDG_CONFIG_HOME,
        join(launch.env.XDG_CONFIG_HOME, "opencode"),
        dirname(launch.env.OPENCODE_CONFIG),
      ]) {
        await chmod(path, 0o700).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("OpenCode generation fence binds exactly one frozen session", () => {
  const fence = new OpenCodeGenerationFence({
    agent: "plan",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  assert.deepEqual(fence.accept({ type: "ready" }), { kind: "ready" });
  assert.deepEqual(
    fence.accept({
      type: "bind",
      sessionId: "session-1",
      agent: "plan",
      providerId: "provider",
      modelId: "model",
      variant: "high",
    }),
    { kind: "bound", sessionId: "session-1" },
  );
  assert.deepEqual(
    fence.accept({
      type: "activity",
      state: "busy",
      sessionId: "session-1",
    }),
    { kind: "activity", lifecycle: "started", sessionId: "session-1" },
  );
  assert.equal(
    fence.accept({
      type: "bind",
      sessionId: "session-2",
      agent: "plan",
      providerId: "provider",
      modelId: "model",
      variant: "high",
    }).kind,
    "violation",
  );
  const modelFence = new OpenCodeGenerationFence({
    agent: "plan",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  assert.equal(
    modelFence.accept({
      type: "bind",
      sessionId: "session-1",
      agent: "plan",
      providerId: "other-provider",
      modelId: "model",
      variant: "high",
    }).kind,
    "violation",
  );
  const effortFence = new OpenCodeGenerationFence({
    agent: "plan",
    providerId: "provider",
    modelId: "model",
    variant: "high",
  });
  assert.match(
    effortFence.accept({
      type: "bind",
      sessionId: "session-1",
      agent: "plan",
      providerId: "provider",
      modelId: "model",
      variant: "low",
    }).message,
    /reasoning effort/,
  );
  assert.equal(
    fence.accept({
      type: "publish",
      sessionId: "session-1",
      callID: "",
      markdown: "# Plan",
    }).kind,
    "violation",
  );
  assert.deepEqual(
    fence.accept({
      type: "publish",
      sessionId: "session-1",
      callID: "call-1",
      markdown: "# Plan",
    }),
    {
      kind: "publication",
      sessionId: "session-1",
      callID: "call-1",
      markdown: "# Plan",
    },
  );
});

test("plan writer idle timing begins only when the native composer is ready", async () => {
  let idleCalls = 0;
  const activity = new PlanWriterActivityController({
    idleMs: 20,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  await delay(30);
  assert.equal(idleCalls, 0);
  activity.startIdleTiming();
  await delay(30);
  assert.equal(idleCalls, 1);
});

test("plan writer idle timing resets only from meaningful activity", async () => {
  let idleCalls = 0;
  let deliveries = 0;
  const activity = new PlanWriterActivityController({
    idleMs: 30,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  activity.startIdleTiming();
  await delay(20);
  assert.equal(
    await activity.deliverMeaningfulActivity(() => {
      deliveries += 1;
    }),
    true,
  );
  assert.equal(deliveries, 1);
  await delay(20);
  assert.equal(idleCalls, 0);
  await delay(25);
  assert.equal(idleCalls, 1);
});

test("turn and publication activity suspend idle shutdown and restart it on completion", async () => {
  let idleCalls = 0;
  const activity = new PlanWriterActivityController({
    idleMs: 25,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  activity.startIdleTiming();
  await activity.handleTurnLifecycle("started");
  await delay(35);
  assert.equal(idleCalls, 0);
  await activity.setPublicationActive(true);
  await activity.handleTurnLifecycle("settled");
  await delay(35);
  assert.equal(idleCalls, 0);
  await activity.setPublicationActive(false);
  await delay(35);
  assert.equal(idleCalls, 1);
});

test("plan writer settlement emits once per real active-to-idle turn", async () => {
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });

  await activity.handleTurnLifecycle("settled");
  await activity.handleTurnLifecycle("settled");
  assert.deepEqual(settled, []);

  await activity.handleTurnLifecycle("started");
  await activity.handleTurnLifecycle("started");
  await activity.setPublicationActive(true);
  await activity.handleTurnLifecycle("settled");
  assert.deepEqual(settled, []);
  await activity.setPublicationActive(false);
  await activity.setPublicationActive(false);
  assert.deepEqual(settled, [1]);

  await activity.handleTurnLifecycle("started");
  await activity.handleTurnLifecycle("settled");
  assert.deepEqual(settled, [1, 2]);
  await activity.close();
  assert.deepEqual(settled, [1, 2]);
});

test("cancelled turns never create a settlement", async () => {
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });

  await activity.handleTurnLifecycle("started");
  await activity.handleTurnLifecycle("cancelled");
  await activity.handleTurnLifecycle("settled");
  assert.deepEqual(settled, []);

  await activity.handleTurnLifecycle("started");
  await activity.handleTurnLifecycle("settled");
  assert.deepEqual(settled, [1]);
  await activity.close();
});

test("Ctrl+C input cancels the pending turn before provider callbacks settle", async () => {
  const settled = [];
  let deliveries = 0;
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });

  await activity.handleTurnLifecycle("started");
  assert.equal(
    await deliverPlanWriterInput(activity, "\x03", () => {
      deliveries += 1;
    }),
    true,
  );
  await activity.handleTurnLifecycle("settled");
  assert.equal(deliveries, 1);
  assert.deepEqual(settled, []);
  await activity.close();
});

test("settlement reporting stays ordered with later controller work", async () => {
  let releaseSettlement;
  const settlementGate = new Promise((resolve) => {
    releaseSettlement = resolve;
  });
  let delivered = false;
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: () => settlementGate,
  });
  await activity.handleTurnLifecycle("started");
  const settling = activity.handleTurnLifecycle("settled");
  const delivery = activity.deliverMeaningfulActivity(() => {
    delivered = true;
  });
  await delay(5);
  assert.equal(delivered, false);
  releaseSettlement();
  await settling;
  assert.equal(await delivery, true);
  assert.equal(delivered, true);
  await activity.close();
});

test("settlement reporting retries network and 5xx failures with one sequence", async () => {
  let now = 0;
  const sequences = [];
  const outcomes = [new Error("network unavailable"), 503, 204];
  await reportPlanWriterSettlement(
    7,
    async (sequence) => {
      sequences.push(sequence);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    {
      retryWindowMs: 5_000,
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    },
  );
  assert.deepEqual(sequences, [7, 7, 7]);

  let staleCalls = 0;
  await reportPlanWriterSettlement(8, async (sequence) => {
    staleCalls += 1;
    assert.equal(sequence, 8);
    return 409;
  });
  assert.equal(staleCalls, 1);

  let rejectedCalls = 0;
  await assert.rejects(
    reportPlanWriterSettlement(9, async () => {
      rejectedCalls += 1;
      return 400;
    }),
    /HTTP 400/u,
  );
  assert.equal(rejectedCalls, 1);
});

test("an indeterminate idle check does not manufacture a settlement", async () => {
  let idleCalls = 0;
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: 5,
    onIdle: () => {
      idleCalls += 1;
      return "deferred";
    },
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });
  activity.startIdleTiming();
  await delay(15);
  assert.ok(idleCalls >= 1);

  // A later retry proving the provider is still idle must remain duplicate idle.
  await activity.handleTurnLifecycle("settled");
  await activity.close();
  assert.deepEqual(settled, []);
});

test("Claude and OpenCode hook translations settle each real turn once", async () => {
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });

  for (const event of ["SessionStart", "UserPromptSubmit", "StopFailure"]) {
    const lifecycle = planWriterTurnLifecycleForClaudeHook(event);
    if (lifecycle !== null) await activity.handleTurnLifecycle(lifecycle);
  }
  assert.deepEqual(settled, [1]);
  for (const event of ["UserPromptSubmit", "Stop"]) {
    const lifecycle = planWriterTurnLifecycleForClaudeHook(event);
    if (lifecycle !== null) await activity.handleTurnLifecycle(lifecycle);
  }
  assert.deepEqual(settled, [1, 2]);

  const expected = {
    agent: "plan",
    providerId: "provider-1",
    modelId: "model-1",
    variant: "high",
  };
  const fence = new OpenCodeGenerationFence(expected);
  assert.equal(
    fence.accept({
      type: "bind",
      sessionId: "session-1",
      ...expected,
    }).kind,
    "bound",
  );
  const hook = (state) =>
    fence.accept({
      type: "activity",
      sessionId: "session-1",
      state,
    });
  const busy = hook("busy");
  assert.equal(busy.kind, "activity");
  await activity.handleTurnLifecycle(busy.lifecycle);
  await activity.setPublicationActive(true);
  await activity.setPublicationActive(false);
  const idle = hook("idle");
  assert.equal(idle.kind, "activity");
  await activity.handleTurnLifecycle(idle.lifecycle);
  assert.deepEqual(settled, [1, 2, 3]);
  await activity.handleTurnLifecycle(hook("busy").lifecycle);
  const retry = hook("retry");
  assert.equal(retry.kind, "activity");
  assert.equal(retry.lifecycle, "started");
  await activity.handleTurnLifecycle(retry.lifecycle);
  await activity.handleTurnLifecycle(hook("idle").lifecycle);
  assert.deepEqual(settled, [1, 2, 3, 4]);
  await activity.close();
});

test("Codex notifications retry completion reads and preserve consecutive turn boundaries", async () => {
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });
  const expectedThreadId = "thread-1";
  assert.equal(
    codexPlanWriterTurnLifecycle(
      "turn/started",
      { threadId: "other-thread" },
      expectedThreadId,
    ),
    null,
  );
  assert.equal(
    codexPlanWriterTurnLifecycle(
      "turn/completed",
      { threadId: expectedThreadId, turn: { status: "failed" } },
      expectedThreadId,
    ),
    "settled",
  );
  assert.equal(
    codexPlanWriterTurnLifecycle(
      "turn/completed",
      { threadId: expectedThreadId, turn: { status: "interrupted" } },
      expectedThreadId,
    ),
    "cancelled",
  );

  let reconciliationAttempts = 0;
  let releaseReconciliation;
  const reconciliation = new Promise((resolve) => {
    releaseReconciliation = resolve;
  });
  const queue = new CodexPlanWriterTurnQueue(async (lifecycle) => {
    if (lifecycle === "started" || lifecycle === "cancelled") {
      await activity.handleTurnLifecycle(lifecycle);
      return;
    }
    const completion = await reconcileCodexCompletionWithRetry({
      reconcile: async () => {
        reconciliationAttempts += 1;
        if (reconciliationAttempts === 1) {
          await activity.setPublicationActive(true);
          await activity.setPublicationActive(false);
          throw new Error("transient read failure");
        }
        if (reconciliationAttempts === 2) await reconciliation;
        return { turnActive: reconciliationAttempts === 2 };
      },
      shouldContinue: () => true,
      sleep: async () => undefined,
    });
    assert.equal(completion.completed, true);
    await activity.handleTurnLifecycle("settled");
    if (completion.completed && completion.value.turnActive) {
      await activity.handleTurnLifecycle("started");
    }
  });

  await queue.enqueue("started");
  const firstCompletion = queue.enqueue("settled");
  const secondStart = queue.enqueue("started");
  await delay(5);
  assert.deepEqual(settled, []);
  assert.equal(reconciliationAttempts, 2);
  releaseReconciliation();
  await Promise.all([firstCompletion, secondStart]);
  assert.deepEqual(settled, [1]);

  await queue.enqueue("settled");
  assert.deepEqual(settled, [1, 2]);
  assert.equal(reconciliationAttempts, 3);
  await queue.enqueue("started");
  await queue.enqueue("cancelled");
  assert.deepEqual(settled, [1, 2]);
  await queue.drain();
  await activity.close();
});

test("Codex completion reconciliation stops retrying and releases the lifecycle queue", async () => {
  const settled = [];
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => undefined,
    onSettled: (sequence) => {
      settled.push(sequence);
    },
  });
  let attempts = 0;
  const queue = new CodexPlanWriterTurnQueue(async (lifecycle) => {
    if (lifecycle !== "settled") {
      await activity.handleTurnLifecycle(lifecycle);
      return;
    }
    const completion = await reconcileCodexCompletionWithRetry({
      reconcile: async () => {
        attempts += 1;
        throw new Error("persistent reconciliation failure");
      },
      shouldContinue: () => true,
      sleep: async () => undefined,
      maxAttempts: 2,
    });
    assert.deepEqual(completion, {
      completed: false,
      reason: "exhausted",
      attempts: 2,
    });
    await activity.handleTurnLifecycle("settled");
  });

  await queue.enqueue("started");
  await queue.enqueue("settled");
  await queue.enqueue("started");
  await queue.enqueue("cancelled");

  assert.equal(attempts, 2);
  assert.deepEqual(settled, [1]);
  await queue.drain();
  await activity.close();
});

test("Codex reconciliation and lifecycle work share one ordered queue", async () => {
  const order = [];
  let releaseReconciliation;
  const reconciliationGate = new Promise((resolve) => {
    releaseReconciliation = resolve;
  });
  const queue = new CodexPlanWriterTurnQueue(async (lifecycle) => {
    order.push(lifecycle);
  });

  const reconciliation = queue.enqueueOperation(async () => {
    order.push("reconcile-start");
    await reconciliationGate;
    order.push("reconcile-end");
    return "reconciled";
  });
  const lifecycle = queue.enqueue("started");
  await delay(5);
  assert.deepEqual(order, ["reconcile-start"]);

  releaseReconciliation();
  assert.equal(await reconciliation, "reconciled");
  await lifecycle;
  assert.deepEqual(order, ["reconcile-start", "reconcile-end", "started"]);
  await queue.drain();
});

test("PTY input and idle shutdown share one ordered lifecycle queue", async () => {
  let idleCalls = 0;
  let deliveries = 0;
  const activity = new PlanWriterActivityController({
    idleMs: 20,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  activity.startIdleTiming();
  const delivered = activity.deliverMeaningfulActivity(async () => {
    deliveries += 1;
    await delay(30);
  });
  assert.equal(await delivered, true);
  assert.equal(deliveries, 1);
  assert.equal(idleCalls, 0);
  await delay(30);
  assert.equal(idleCalls, 1);
  assert.equal(
    await activity.deliverMeaningfulActivity(() => {
      deliveries += 1;
    }),
    false,
  );
  assert.equal(deliveries, 1);
});

test("disabled idle timing accepts input and never expires", async () => {
  let idleCalls = 0;
  let deliveries = 0;
  const activity = new PlanWriterActivityController({
    idleMs: null,
    onIdle: () => {
      idleCalls += 1;
    },
  });
  activity.startIdleTiming();
  await activity.handleTurnLifecycle("started");
  await activity.handleTurnLifecycle("settled");
  assert.equal(
    await activity.deliverMeaningfulActivity(() => {
      deliveries += 1;
    }),
    true,
  );
  await delay(35);
  assert.equal(deliveries, 1);
  assert.equal(idleCalls, 0);
  await activity.close();
});

test("the startup deadline catches a stall but cannot fire after registration", async () => {
  let deadlineCalls = 0;
  startPlanWriterStartupDeadline(20, () => {
    deadlineCalls += 1;
  });
  await delay(35);
  assert.equal(deadlineCalls, 1);

  const registered = startPlanWriterStartupDeadline(20, () => {
    deadlineCalls += 1;
  });
  registered();
  await delay(35);
  assert.equal(deadlineCalls, 1);
});

test("contribution insertion is sanitized, bounded, and never submits Enter", () => {
  const paste = bracketedPasteWithoutEnter(
    "hello\u001b[201~\u0000\u001bworld\nnext",
  );
  assert.equal(paste, "\u001b[200~helloworld\nnext\u001b[201~");
  assert.equal(paste.endsWith("\r"), false);
  assert.ok(
    Buffer.byteLength(sanitizeContributionInsert("é".repeat(40_000))) <=
      64 * 1024,
  );
});

test("conversation replacement detection ignores ordinary text and bracketed contributions", () => {
  assert.equal(containsUnsupportedConversationCommand("/new"), true);
  assert.equal(containsUnsupportedConversationCommand("hello\r/clear "), true);
  assert.equal(containsUnsupportedConversationCommand("/permissions"), true);
  assert.equal(
    containsUnsupportedConversationCommand("/sandbox read-only"),
    true,
  );
  assert.equal(
    containsUnsupportedConversationCommand("please discuss /new behavior"),
    false,
  );
  assert.equal(
    containsUnsupportedConversationCommand(
      bracketedPasteWithoutEnter("/resume\n/branch"),
    ),
    false,
  );
});

test("Codex effective settings reject cwd, approval, or sandbox drift", () => {
  const settings = {
    thread: { id: "root", parentThreadId: null, cwd: "/workspace" },
    cwd: "/workspace",
    approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" },
  };
  assert.equal(
    hasManagedCodexSettings(settings, { threadId: "root", cwd: "/workspace" }),
    true,
  );
  assert.equal(
    hasManagedCodexSettings(
      { ...settings, approvalPolicy: "on-request" },
      { threadId: "root", cwd: "/workspace" },
    ),
    false,
  );
  assert.equal(
    hasManagedCodexSettings(
      {
        ...settings,
        sandbox: { type: "workspaceWrite", networkAccess: false },
      },
      { threadId: "root", cwd: "/workspace" },
    ),
    false,
  );
  assert.equal(
    hasManagedCodexSettings(
      { ...settings, cwd: "/tmp" },
      { threadId: "root", cwd: "/workspace" },
    ),
    false,
  );
});

test("Codex thread settings require the managed Plan collaboration mode", () => {
  const settings = {
    cwd: "/workspace",
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-test",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
  };
  assert.equal(
    hasManagedCodexThreadSettings(settings, { cwd: "/workspace" }),
    true,
  );
  assert.equal(
    hasManagedCodexThreadSettings(
      {
        ...settings,
        collaborationMode: { ...settings.collaborationMode, mode: "default" },
      },
      { cwd: "/workspace" },
    ),
    false,
  );
  assert.equal(
    hasManagedCodexThreadSettings(
      { ...settings, approvalPolicy: "on-request" },
      { cwd: "/workspace" },
    ),
    false,
  );
  assert.equal(
    hasManagedCodexThreadSettings(
      {
        ...settings,
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
      },
      { cwd: "/workspace" },
    ),
    false,
  );
});

test("Codex initializes the native TUI through its own /plan command", async (t) => {
  const root = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "tiller-plan-writer-codex-",
    ),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  const transcript = join(root, "transcript.jsonl");
  const planMarker = join(root, "plan-entered");
  const wsModule = createRequire(import.meta.url).resolve("ws");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const listen = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
const transcript = process.env.FAKE_CODEX_TRANSCRIPT;
const planMarker = process.env.FAKE_CODEX_PLAN_MARKER;
try { fs.rmSync(listen); } catch {}
const record = value => fs.appendFileSync(transcript, JSON.stringify(value) + "\\n");
const server = http.createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
let planNotified = false;
setInterval(() => {
  if (planNotified || !fs.existsSync(planMarker)) return;
  planNotified = true;
  for (const socket of wss.clients) socket.send(JSON.stringify({
    method: "thread/settings/updated",
    params: {
      threadId: "root-thread",
      threadSettings: {
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        collaborationMode: { mode: "plan", settings: { model: "gpt-test", reasoning_effort: null, developer_instructions: "native plan" } }
      }
    }
  }));
}, 5);
wss.on("connection", socket => {
  socket.on("message", data => {
    const message = JSON.parse(data.toString());
    record(message);
    if (message.method === "initialize") {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "thread/start") {
      socket.send(JSON.stringify({ id: message.id, result: { thread: { id: "root-thread" } } }));
    } else if (message.method === "thread/inject_items") {
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    }
  });
});
server.listen(listen);
process.on("SIGTERM", () => {
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
});
`,
  );
  await chmod(executable, 0o755);
  const appServer = new CodexAppServer({
    socketPath: join(root, "app-server.sock"),
    cwd: root,
    env: {
      PATH: `${root}:${process.env.PATH}`,
      HOME: root,
      FAKE_CODEX_TRANSCRIPT: transcript,
      FAKE_CODEX_PLAN_MARKER: planMarker,
      TILLER_PLAN_WRITER_SOCKET: join(root, "supervisor.sock"),
    },
    repoPlansSocketPath: join(root, "supervisor.sock"),
  });
  t.after(() => appServer.stop());

  await appServer.start();
  const threadId = await appServer.createManagedThread({
    model: "gpt-test",
    context: "Managed context",
  });
  const tuiInput = [];
  const settings = await appServer.initializeManagedPlanTui({
    threadId,
    writeInput: async (data) => {
      tuiInput.push(data);
      if (data === "\u0015/plan\r") await writeFile(planMarker, data);
    },
  });
  assert.equal(settings.collaborationMode.mode, "plan");
  assert.ok(tuiInput.slice(0, -1).every((data) => data === "\u0015/plan\r"));
  assert.equal(tuiInput.at(-1), "\u0015");
  await appServer.stop();

  const messages = (await readFile(transcript, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const start = messages.find(
    (message) => message.method === "thread/start",
  ).params;
  assert.equal(start.approvalPolicy, "never");
  assert.equal(start.sandbox, "danger-full-access");
  assert.equal(start.baseInstructions, undefined);
  assert.equal(start.developerInstructions, "Managed context");
  assert.deepEqual(start.dynamicTools, []);
  assert.deepEqual(start.config.mcp_servers, {
    tiller_plans: {
      command: "tiller-plan-writer-plans-mcp",
      enabled: true,
      enabled_tools: ["list_plans", "read_plan", "create_plan", "update_plan"],
      default_tools_approval_mode: "approve",
      env: { TILLER_PLAN_WRITER_SOCKET: join(root, "supervisor.sock") },
    },
  });
  assert.equal(
    messages.some((message) => message.method === "thread/settings/update"),
    false,
  );
});

test("Codex completion notifications identify the authoritative foreground thread", () => {
  assert.equal(codexNotificationThreadId({ "thread-id": "root-1" }), "root-1");
  assert.equal(codexNotificationThreadId({ thread_id: "root-2" }), "root-2");
  assert.equal(codexNotificationThreadId({}), null);
});

test("provider environments expose only the explicit provider allowlist", () => {
  const common = {
    home: "/home/tiller",
    socketPath: "/run/writer.sock",
    contextPath: "/run/context.md",
    source: {
      PATH: "/bin",
      TERM: "xterm-256color",
      ANTHROPIC_API_KEY: "anthropic",
      CLAUDE_CODE_OAUTH_TOKEN: "inactive-oauth",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: "api",
      OPENAI_API_KEY: "openai",
      GH_TOKEN: "github",
      TILLER_PLAN_WRITER_TOKEN: "hub-secret",
      TILLER_MCP_SERVERS_JSON: "secret-mcp",
      TILLER_CODEX_GATEWAY_BASE_URL: "https://gateway.example/v1",
      TILLER_CODEX_GATEWAY_SESSION_TOKEN: "gateway-secret",
      TILLER_CODEX_RUNTIME_AUTH_URL: "https://hub.example/runtime-auth",
      TILLER_RUNTIME_CAPABILITY: "runtime-capability",
      TILLER_CODEX_REFRESH_TOKEN: "refresh-token",
      TILLER_CODEX_CALLBACK_TOKEN: "callback-token",
      TILLER_GITHUB_BRIDGE_TOKEN: "bridge-token",
      CF_ACCESS_CLIENT_ID: "access-id",
      CF_ACCESS_CLIENT_SECRET: "access-secret",
    },
  };
  const claude = buildProviderEnvironment({
    ...common,
    provider: "claude-code",
  });
  assert.equal(claude.GIT_CONFIG_GLOBAL, "/run/tiller-plan-writer-gitconfig");
  assert.equal(claude.ANTHROPIC_API_KEY, "anthropic");
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(claude.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(claude.TILLER_CLAUDE_AUTH_RESOLVED_MODE, "api");
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.GH_TOKEN, undefined);
  assert.equal(claude.TILLER_PLAN_WRITER_TOKEN, undefined);
  assert.equal(claude.TILLER_MCP_SERVERS_JSON, undefined);
  const codex = buildProviderEnvironment({ ...common, provider: "codex" });
  assert.equal(codex.OPENAI_API_KEY, "openai");
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  for (const key of [
    "TILLER_CODEX_GATEWAY_BASE_URL",
    "TILLER_CODEX_GATEWAY_SESSION_TOKEN",
    "TILLER_CODEX_RUNTIME_AUTH_URL",
    "TILLER_RUNTIME_CAPABILITY",
    "TILLER_CODEX_REFRESH_TOKEN",
    "TILLER_CODEX_CALLBACK_TOKEN",
    "TILLER_GITHUB_BRIDGE_TOKEN",
    "CF_ACCESS_CLIENT_ID",
    "CF_ACCESS_CLIENT_SECRET",
  ]) {
    assert.equal(
      codex[key],
      undefined,
      `${key} must not reach the Codex child`,
    );
  }

  const subscriptionCodex = buildProviderEnvironment({
    ...common,
    provider: "codex",
    source: {
      ...common.source,
      TILLER_CODEX_RUNTIME_MODE: "app-server",
      TILLER_CODEX_AUTH_MODE: "subscription",
    },
  });
  assert.equal(subscriptionCodex.OPENAI_API_KEY, undefined);
});

test("Claude provider temp storage belongs to the unprivileged provider account", async () => {
  const home = await mkdtemp(
    join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "tiller-plan-writer-claude-",
    ),
  );
  const currentUid = process.getuid?.() ?? 0;
  const currentGid = process.getgid?.() ?? 0;
  const account =
    currentUid === 0
      ? { uid: 65_534, gid: 65_534 }
      : { uid: currentUid, gid: currentGid };
  try {
    await buildClaudeLaunch({
      context: {
        writer: {
          repoId: "repo",
          planArtifactId: "plan",
          generation: 1,
          basisCommit: "abc123",
          terminalId: "terminal",
          provider: "claude-code",
          model: "claude-test",
        },
        plan: {
          title: "Plan",
          status: "draft",
          markdown: "# Plan\n",
          digest: "digest",
        },
        planFormat: "Markdown",
        instructions: [],
      },
      checkoutDir: "/workspace",
      home,
      socketPath: join(home, "supervisor.sock"),
      contextPath: join(home, "managed-context.md"),
      account,
    });
    const temp = await stat(join(home, "tmp"));
    assert.equal(temp.uid, account.uid);
    assert.equal(temp.gid, account.gid);
    assert.equal(temp.mode & 0o777, 0o700);
  } finally {
    await chmod(join(home, "managed-claude"), 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude exposes exactly four managed plan tools and mutation approval hooks", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "tiller-plan-writer-claude-plans-"),
  );
  const account = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
  };
  try {
    const source = openCodeContext();
    const launch = await buildClaudeLaunch({
      context: {
        ...source,
        writer: {
          ...source.writer,
          provider: "claude-code",
          model: "claude-test",
        },
        capabilities: { repoPlansV1: true },
      },
      checkoutDir: "/workspace",
      home,
      socketPath: join(home, "supervisor.sock"),
      contextPath: join(home, "managed-context.md"),
      account,
    });
    const mcpConfig = JSON.parse(
      launch.args[launch.args.indexOf("--mcp-config") + 1],
    );
    assert.deepEqual(mcpConfig, {
      mcpServers: {
        tiller_plans: {
          command: "tiller-plan-writer-plans-mcp",
          args: [],
        },
      },
    });
    const settingsPath = launch.args[launch.args.indexOf("--settings") + 1];
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(settings.permissions.allow, [
      "mcp__tiller_plans__list_plans",
      "mcp__tiller_plans__read_plan",
      "mcp__tiller_plans__create_plan",
      "mcp__tiller_plans__update_plan",
    ]);
    assert.deepEqual(
      settings.hooks.PreToolUse.map(({ matcher }) => matcher),
      [
        "ExitPlanMode",
        "mcp__tiller_plans__create_plan",
        "mcp__tiller_plans__update_plan",
      ],
    );
    assert.deepEqual(settings.mcpServers, {});
  } finally {
    await chmod(join(home, "managed-claude"), 0o700).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude session IDs are deterministic and generation-scoped", () => {
  const firstIdentity = ["repo", "plan", "1"].join("\0");
  const first = deterministicClaudeSessionId(firstIdentity);
  assert.equal(first, deterministicClaudeSessionId(firstIdentity));
  assert.notEqual(
    first,
    deterministicClaudeSessionId(["repo", "plan", "2"].join("\0")),
  );
  assert.match(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

test("Codex publishes only the newest completed root-thread plan", () => {
  const thread = {
    thread: {
      id: "root",
      parentThreadId: null,
      cwd: "/workspace",
      status: "idle",
      turns: [
        {
          id: "older",
          status: "completed",
          completedAt: 1,
          items: [{ type: "plan", id: "plan-1", text: "# One" }],
        },
        {
          id: "newer",
          status: "completed",
          completedAt: 2,
          items: [{ type: "plan", id: "plan-2", text: "# Two" }],
        },
        {
          id: "active",
          status: "inProgress",
          completedAt: null,
          items: [{ type: "plan", id: "draft", text: "# Draft" }],
        },
      ],
    },
  };
  assert.deepEqual(newestCompletedPlan(thread), {
    turnId: "newer",
    eventId: "plan-2",
    markdown: "# Two",
  });
  assert.equal(newestCompletedPlan(thread, "plan-2"), null);
  assert.equal(
    newestCompletedPlan({
      thread: { ...thread.thread, parentThreadId: "root" },
    }),
    null,
  );
  assert.equal(codexThreadRestingLifecycle(thread), "settled");
  assert.equal(
    codexThreadRestingLifecycle({
      thread: {
        ...thread.thread,
        status: "idle",
        turns: [
          {
            id: "cancelled",
            status: "interrupted",
            completedAt: 3,
            items: [],
          },
        ],
      },
    }),
    "cancelled",
  );
});
