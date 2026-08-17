import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@homebridge/node-pty-prebuilt-multiarch";
import {
  buildOpenCodeLaunch,
  OPENCODE_READY_DEADLINE_MS,
  waitForOpenCodeReady,
} from "../dist/plan-writer/opencode.js";
import { OpenCodeGenerationFence } from "../dist/plan-writer/opencode-hook.js";
import { renderManagedPlanWriterContext } from "../dist/plan-writer/context.js";

const binary = process.env.TILLER_PINNED_OPENCODE_BIN;
const traceBinary = process.env.TILLER_OPENCODE_TRACE_BIN;
if (!binary) {
  throw new Error(
    "TILLER_PINNED_OPENCODE_BIN is required for the image smoke runner.",
  );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function killPtyProcessGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function createDeniedReadMarker(checkout) {
  const gitDir = join(checkout, ".git");
  const markerPath = join(gitDir, "tiller-opencode-read-denied");
  await mkdir(gitDir);
  await writeFile(
    markerPath,
    "External read denied: the requested path is outside the managed checkout.\n",
  );
  await chmod(markerPath, 0o444);
  await chmod(gitDir, 0o555);
}

function writerContext(model = "gpt-native") {
  return {
    writer: {
      repoId: "repo",
      planArtifactId: "plan",
      generation: 2,
      basisCommit: "abc123",
      terminalId: "plan-writer-terminal",
      provider: "opencode",
      model,
      effort: "high",
    },
    plan: {
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

function selectionEnv(input) {
  return {
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    TILLER_OPENCODE_BASE_URL: input.baseURL,
    TILLER_OPENCODE_AUTH_TOKEN: "secret",
    TILLER_OPENCODE_PROVIDER_KIND: input.providerKind,
    TILLER_OPENCODE_PROVIDER_ALIAS: input.providerAlias,
    TILLER_OPENCODE_PROVIDER_LABEL: input.providerLabel,
    TILLER_OPENCODE_MODEL_ID: input.modelId,
    TILLER_OPENCODE_MODEL_ALIAS: input.modelAlias,
    TILLER_OPENCODE_MODEL_LABEL: input.modelLabel,
    TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: String(input.contextLimit),
    ...(input.inputLimit
      ? { TILLER_OPENCODE_MODEL_INPUT_LIMIT: String(input.inputLimit) }
      : {}),
    TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: String(input.outputLimit),
    ...(input.accessHeaders
      ? {
          CF_ACCESS_CLIENT_ID: "client-id",
          CF_ACCESS_CLIENT_SECRET: "client-secret",
        }
      : {}),
  };
}

async function listen(server, ...args) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, resolve);
  });
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function cleanupRuntime(root, checkout, launch) {
  if (launch) {
    for (const path of [
      dirname(launch.env.HOME),
      launch.env.HOME,
      launch.env.XDG_CONFIG_HOME,
      join(launch.env.XDG_CONFIG_HOME, "opencode"),
      dirname(launch.env.OPENCODE_CONFIG),
    ]) {
      await chmod(path, 0o700).catch(() => undefined);
    }
  }
  await chmod(join(checkout, ".git"), 0o700).catch(() => undefined);
  await chmod(checkout, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

function smokeToolCall(input) {
  if (input.requestIndex === 1) {
    return {
      id: "call-read-external",
      name: "read",
      args: { filePath: input.externalPath },
    };
  }
  if (input.requestIndex === 2) {
    return {
      id: "call-read",
      name: "read",
      args: { filePath: input.factPath },
    };
  }
  if (input.requestIndex === 3) {
    return {
      id: "call-webfetch",
      name: "webfetch",
      args: { url: input.researchUrl, format: "text" },
    };
  }
  return {
    id: "call-publish",
    name: "publish_plan",
    args: {
      markdown: "# Smoke plan\n\nResearch found sapphire and cobalt.",
    },
  };
}

function openAIResponse(response, input) {
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
    const call = smokeToolCall(input);
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
  response.end("data: [DONE]\n\n");
}

function anthropicResponse(response, input) {
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
    const call = smokeToolCall(input);
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

const cases = [
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

for (const smokeCase of cases) {
  test(`OpenCode image completes ${smokeCase.label} repository and web research`, async () => {
    const root = await mkdtemp(
      join(tmpdir(), `tiller-image-${smokeCase.providerKind}-`),
    );
    const checkout = join(root, "checkout");
    const providerHome = join(root, "provider-home");
    const factPath = join(checkout, "facts.txt");
    const externalPath = join(root, "outside.txt");
    const externalLink = join(checkout, "external-link.txt");
    const contextPath = join(root, "managed-context.md");
    const socketPath = join(root, "supervisor.sock");
    await mkdir(checkout);
    await mkdir(providerHome);
    await createDeniedReadMarker(checkout);
    await writeFile(factPath, "Repository research: sapphire.\n");
    await writeFile(externalPath, "outside\n");
    await symlink(externalPath, externalLink);
    await chmod(checkout, 0o555);
    await chmod(factPath, 0o444);

    let launch;
    const hookMessages = [];
    let markPublished;
    const published = new Promise((resolve) => {
      markPublished = resolve;
    });
    let markIdle;
    const idle = new Promise((resolve) => {
      markIdle = resolve;
    });
    const fence = new OpenCodeGenerationFence({
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
      const action = fence.accept(message);
      if (action.kind === "violation") {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: action.message }));
        return;
      }
      if (action.kind === "publication") {
        await writeFile(contextPath, "refreshed managed context marker\n");
        markPublished();
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    });
    await listen(hookServer, socketPath);

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
        mainRequests.push({ body, headers: request.headers, url: request.url });
      }
      const input = {
        main,
        requestIndex: main ? mainRequestCount : 0,
        factPath,
        externalPath: externalLink,
        researchUrl,
        modelId: smokeCase.modelId,
      };
      if (smokeCase.api === "anthropic") anthropicResponse(response, input);
      else openAIResponse(response, input);
    });
    await listen(providerServer, 0, "127.0.0.1");
    const address = providerServer.address();
    assert.equal(typeof address, "object");
    researchUrl = `http://127.0.0.1:${address.port}/research`;

    try {
      const context = writerContext(smokeCase.modelId);
      await writeFile(contextPath, renderManagedPlanWriterContext(context));
      const account = { uid: process.getuid(), gid: process.getgid() };
      launch = await buildOpenCodeLaunch({
        context,
        checkoutDir: checkout,
        home: providerHome,
        socketPath,
        contextPath,
        terminalId: "image-smoke-terminal",
        account,
        protectedOwner: account,
        source: selectionEnv({
          ...smokeCase,
          baseURL: `http://127.0.0.1:${address.port}/v1`,
        }),
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
            `Read facts.txt, fetch ${researchUrl}, and publish the plan.`,
          ],
          { cwd: checkout, env: launch.env, stdio: ["ignore", "pipe", "pipe"] },
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
          child.kill();
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
            new Error(
              `OpenCode image smoke timed out after ${mainRequestCount} model requests and ${hookMessages.length} hook messages. stdout=${stdout} stderr=${stderr}`,
            ),
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
            reject(new Error(`OpenCode image smoke exited ${code}. ${stderr}`));
        });
      });

      assert.match(result.stdout, /Published\./);
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

      const publication = hookMessages.find(
        (message) => message.type === "publish",
      );
      assert.ok(publication);
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

      const offeredTools = mainRequests[0].body.tools.map((tool) =>
        smokeCase.api === "anthropic" ? tool.name : tool.function.name,
      );
      for (const allowed of [
        "read",
        "glob",
        "grep",
        "webfetch",
        "websearch",
        "publish_plan",
      ]) {
        assert.equal(
          offeredTools.includes(allowed),
          true,
          `${allowed} should be offered`,
        );
      }
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
    } finally {
      await Promise.all([close(hookServer), close(providerServer)]);
      await cleanupRuntime(root, checkout, launch);
    }
  });
}

async function runStartupSmoke(traceCommand) {
  const root = await mkdtemp(join(tmpdir(), "tiller-image-startup-"));
  const checkout = join(root, "checkout");
  const providerHome = join(root, "provider-home");
  const contextPath = join(root, "managed-context.md");
  const socketPath = join(root, "supervisor.sock");
  await mkdir(checkout);
  await mkdir(providerHome);
  await createDeniedReadMarker(checkout);

  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const hookServer = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (JSON.parse(raw).type === "ready") markReady();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  });
  await listen(hookServer, socketPath);

  let providerRequests = 0;
  const providerServer = createServer((_request, response) => {
    providerRequests += 1;
    response.writeHead(503);
    response.end();
  });
  await listen(providerServer, 0, "127.0.0.1");
  const address = providerServer.address();
  assert.equal(typeof address, "object");

  let launch;
  let child;
  let childExited;
  const tracePath = join(root, "startup-network.trace");
  try {
    const context = writerContext();
    await writeFile(contextPath, renderManagedPlanWriterContext(context));
    const account = { uid: process.getuid(), gid: process.getgid() };
    launch = await buildOpenCodeLaunch({
      context,
      checkoutDir: checkout,
      home: providerHome,
      socketPath,
      contextPath,
      terminalId: "image-startup-terminal",
      account,
      protectedOwner: account,
      source: selectionEnv({
        ...cases[0],
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      }),
    });
    await chmod(checkout, 0o555);
    const configBefore = await readFile(launch.env.OPENCODE_CONFIG);
    const config = JSON.parse(configBefore.toString("utf8"));
    const pluginPath = fileURLToPath(config.plugin[0]);
    const pluginBefore = await readFile(pluginPath);
    let markFirstOutput;
    const firstOutput = new Promise((resolve) => {
      markFirstOutput = resolve;
    });
    child = pty.spawn(
      traceCommand ?? binary,
      traceCommand
        ? [
            "-f",
            "-qq",
            "-e",
            "trace=network",
            "-o",
            tracePath,
            binary,
            ...launch.args,
          ]
        : launch.args,
      {
        cwd: checkout,
        env: launch.env,
        cols: 100,
        rows: 30,
        name: "xterm-256color",
      },
    );
    let output = "";
    child.onData((data) => {
      output = `${output}${data}`.slice(-8_000);
      markFirstOutput();
    });
    childExited = new Promise((resolve) =>
      child.onExit(({ exitCode }) => resolve(exitCode)),
    );
    await Promise.race([
      Promise.all([
        firstOutput,
        waitForOpenCodeReady([ready], traceCommand ? 45_000 : undefined),
      ]),
      childExited.then((code) => {
        throw new Error(`OpenCode exited before ready (${code}). ${output}`);
      }),
    ]);
    await delay(100);
    assert.equal(providerRequests, 0);
    assert.deepEqual(await readdir(launch.env.HOME), []);
    assert.deepEqual(await readdir(providerHome), []);
    assert.deepEqual(await readdir(launch.env.XDG_CONFIG_HOME), ["opencode"]);
    assert.deepEqual(
      await readdir(join(launch.env.XDG_CONFIG_HOME, "opencode")),
      [],
    );
    assert.deepEqual(await readFile(launch.env.OPENCODE_CONFIG), configBefore);
    assert.deepEqual(await readFile(pluginPath), pluginBefore);
    await assert.rejects(
      stat(join(launch.env.XDG_CACHE_HOME, "opencode", "node_modules")),
    );
    await assert.rejects(
      stat(join(launch.env.XDG_CACHE_HOME, "opencode", "package.json")),
    );
    if (traceCommand) {
      killPtyProcessGroup(child);
      await childExited;
      child = undefined;
      const networkTrace = await readFile(tracePath, "utf8");
      const outboundAttempts = networkTrace
        .split("\n")
        .filter(
          (line) =>
            /\b(?:connect|sendto|sendmsg)\(/.test(line) &&
            /\bAF_INET6?\b/.test(line) &&
            !/inet_addr\("127\./.test(line) &&
            !/inet_pton\(AF_INET6, "::1"/.test(line),
        );
      assert.deepEqual(
        outboundAttempts,
        [],
        `OpenCode attempted outbound network access before input:\n${outboundAttempts.join("\n")}`,
      );
    }
  } finally {
    if (child) killPtyProcessGroup(child);
    if (childExited) {
      await Promise.race([childExited, delay(5_000)]);
    }
    await Promise.all([close(hookServer), close(providerServer)]);
    await cleanupRuntime(root, checkout, launch);
  }
}

test("OpenCode image starts from empty isolated state without provider traffic", () =>
  runStartupSmoke());

test(
  "OpenCode image makes no outbound network attempts before input",
  {
    skip: traceBinary
      ? false
      : "set TILLER_OPENCODE_TRACE_BIN to trace startup network syscalls",
  },
  () => runStartupSmoke(traceBinary),
);

test("OpenCode image reports the pinned release", async () => {
  const version = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`opencode --version exited ${code}: ${stderr}`));
    });
  });
  assert.equal(version, "1.18.18");
  assert.equal(OPENCODE_READY_DEADLINE_MS, 15_000);
});
