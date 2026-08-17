import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function sseResponse(id, items = []) {
  const events = [
    { type: "response.created", response: { id } },
    ...items,
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function functionCall(callId, name, argumentsValue) {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify(argumentsValue),
    },
  };
}

function assistantMessage(text) {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      id: "final-message",
      content: [{ type: "output_text", text }],
    },
  };
}

function callOutput(body, callId) {
  const inputs = Array.isArray(body?.input) ? body.input : [];
  const item = inputs.find(
    (candidate) =>
      candidate?.type === "function_call_output" &&
      candidate?.call_id === callId,
  );
  assert.ok(item, `missing function output for ${callId}`);
  return typeof item.output === "string"
    ? item.output
    : JSON.stringify(item.output);
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk.toString("utf8");
  return JSON.parse(body);
}

function createModelServer(sentinel) {
  const requests = [];
  let failure = null;
  let executionTool = null;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.match(request.url ?? "", /\/v1\/responses$/);
      const body = await readRequestBody(request);
      requests.push(body);
      let payload;
      if (requests.length === 1) {
        const advertisedTools = Array.isArray(body.tools)
          ? body.tools.map(
              (tool) => tool?.name ?? tool?.function?.name ?? tool?.type,
            )
          : [];
        executionTool = advertisedTools.includes("shell_command")
          ? "shell_command"
          : advertisedTools.includes("exec_command")
            ? "exec_command"
            : null;
        assert.ok(
          executionTool,
          `model request did not advertise a shell execution tool: ${JSON.stringify(advertisedTools)}`,
        );
        payload = sseResponse("read-response", [
          functionCall(
            "read-sentinel",
            executionTool,
            executionTool === "shell_command"
              ? { command: "cat reviewer-sentinel.txt", login: false }
              : { cmd: "cat reviewer-sentinel.txt", yield_time_ms: 10_000 },
          ),
        ]);
      } else if (requests.length === 2) {
        assert.match(callOutput(body, "read-sentinel"), new RegExp(sentinel));
        payload = sseResponse("write-response", [
          functionCall(
            "attempt-write",
            executionTool,
            executionTool === "shell_command"
              ? {
                  command: "printf forbidden > should-not-exist.txt",
                  login: false,
                }
              : {
                  cmd: "printf forbidden > should-not-exist.txt",
                  yield_time_ms: 10_000,
                },
          ),
        ]);
      } else if (requests.length === 3) {
        const writeOutput = callOutput(body, "attempt-write");
        assert.doesNotMatch(writeOutput, /^Exit code: 0\b/m);
        payload = sseResponse("final-response", [
          assistantMessage("CODEX_REVIEWER_SMOKE_OK"),
        ]);
      } else {
        throw new Error(`unexpected Responses API request ${requests.length}`);
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(payload);
    })().catch((error) => {
      failure = error;
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.stack : String(error));
    });
  });
  return {
    requests,
    server,
    get failure() {
      return failure;
    },
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function recordingClient(
  CodexAppServerClient,
  options,
  methods,
  env = options.env,
) {
  const client = new CodexAppServerClient({
    ...options,
    env,
    getAuth: undefined,
  });
  const request = client.request.bind(client);
  client.request = (method, ...args) => {
    methods.push(method);
    return request(method, ...args);
  };
  return client;
}

const globalNodeModules = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim();
const harnessRoot =
  process.env.TILLER_HARNESS_ROOT ||
  join(globalNodeModules, "@paperwing-dev", "tiller-harness");
const { CodexAppServerClient } = await import(
  pathToFileURL(join(harnessRoot, "dist", "codex-app-server-client.js"))
);
const { runCodexOneShot } = await import(
  pathToFileURL(join(harnessRoot, "dist", "planner", "codex-one-shot.js"))
);

const smokeRoot = await mkdtemp(join(tmpdir(), "tiller-codex-reviewer-smoke-"));
const checkout = join(smokeRoot, "checkout");
const codexHome = join(smokeRoot, "codex-home");
const sentinel = randomBytes(24).toString("hex");
const modelServer = createModelServer(sentinel);

try {
  await mkdir(checkout);
  await mkdir(codexHome);
  await writeFile(join(checkout, "reviewer-sentinel.txt"), `${sentinel}\n`);
  const serverUrl = await listen(modelServer.server);
  await writeFile(
    join(codexHome, "config.toml"),
    `
model = "test-gpt-5-codex"
model_provider = "mock_provider"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.mock_provider]
name = "Codex reviewer smoke"
base_url = "${serverUrl}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
supports_websockets = false
`,
  );

  const enabledMethods = [];
  let output;
  try {
    output = await runCodexOneShot({
      cwd: checkout,
      model: "test-gpt-5-codex",
      prompt: "Read the sentinel, attempt the requested write, then finish.",
      getAuth: async () => {
        throw new Error("image smoke must not request external authentication");
      },
      isCancelled: async () => false,
      completionTimeoutMs: 30_000,
      env: { ...process.env, CODEX_HOME: codexHome },
      requireInspection: true,
      clientFactory: (options) =>
        recordingClient(CodexAppServerClient, options, enabledMethods),
    });
  } catch (error) {
    if (modelServer.failure) throw modelServer.failure;
    throw error;
  }
  if (modelServer.failure) throw modelServer.failure;
  assert.equal(output, "CODEX_REVIEWER_SMOKE_OK");
  assert.equal(modelServer.requests.length, 3);
  assert.deepEqual(enabledMethods.slice(0, 4), [
    "initialize",
    "environment/info",
    "thread/start",
    "turn/start",
  ]);
  await assert.rejects(access(join(checkout, "should-not-exist.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(checkout, "reviewer-sentinel.txt"), "utf8"),
    `${sentinel}\n`,
  );

  const disabledMethods = [];
  await assert.rejects(
    runCodexOneShot({
      cwd: checkout,
      model: "test-gpt-5-codex",
      prompt: "This turn must not start.",
      getAuth: async () => {
        throw new Error("disabled-environment smoke must not authenticate");
      },
      isCancelled: async () => false,
      completionTimeoutMs: 10_000,
      env: { ...process.env, CODEX_HOME: codexHome },
      clientFactory: (options) =>
        recordingClient(CodexAppServerClient, options, disabledMethods, {
          ...options.env,
          CODEX_EXEC_SERVER_URL: "none",
        }),
    }),
    /Codex local reviewer environment is unavailable/,
  );
  assert.deepEqual(disabledMethods, ["initialize", "environment/info"]);
  assert.equal(modelServer.requests.length, 3);
  process.stdout.write("Codex reviewer image smoke passed\n");
} finally {
  if (modelServer.server.listening) await close(modelServer.server);
  await rm(smokeRoot, { recursive: true, force: true });
}
