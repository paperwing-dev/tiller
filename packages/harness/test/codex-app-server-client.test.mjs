import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CODEX_AUTH_OPERATION_BUDGET_MS,
  CodexAppServerClient,
  createCodexAppServerSocketLease,
  sanitizeCodexChildEnvironment,
} from "../dist/codex-app-server-client.js";
import { CODEX_RUNTIME_AUTH_HTTP_TIMEOUT_MS } from "../dist/codex-runtime-auth.js";

test("Codex callback deadlines nest below the pinned ten-second provider limit", () => {
  assert.equal(CODEX_AUTH_OPERATION_BUDGET_MS, 9_000);
  assert.equal(CODEX_RUNTIME_AUTH_HTTP_TIMEOUT_MS, 8_500);
});

test("Codex app-server sockets use an owned private parent directory", async () => {
  const lease = createCodexAppServerSocketLease("tiller-codex-socket-test-");
  const directory = dirname(lease.socketPath);
  try {
    assert.equal(directory, lease.directory);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    lease.cleanup();
  }
  await assert.rejects(stat(directory), (error) => error?.code === "ENOENT");
});

test("subscription child environments retain only allowlisted non-secret values", () => {
  const result = sanitizeCodexChildEnvironment({
    PATH: "/bin",
    HOME: "/home/tiller",
    TERM: "xterm-256color",
    OPENAI_API_KEY: "secret",
    CF_ACCESS_CLIENT_SECRET: "secret",
    TILLER_RUNTIME_CAPABILITY: "secret",
    TILLER_GITHUB_BRIDGE_TOKEN: "secret",
    TILLER_SESSION_ENV_NAMES: "SAFE_VALUE,OPENAI_API_KEY,TILLER_GITHUB_BRIDGE_TOKEN",
    SAFE_VALUE: "visible",
    UNLISTED_VALUE: "hidden",
  });

  assert.deepEqual(result, {
    PATH: "/bin",
    HOME: "/home/tiller",
    TERM: "xterm-256color",
    SAFE_VALUE: "visible",
  });
});

test("API-key child environments retain only the selected API credential", () => {
  const result = sanitizeCodexChildEnvironment({
    PATH: "/bin",
    HOME: "/home/tiller",
    OPENAI_API_KEY: "openai-secret",
    CF_ACCESS_CLIENT_SECRET: "access-secret",
    TILLER_RUNTIME_CAPABILITY: "runtime-secret",
    TILLER_PLANNER_RUN_TOKEN: "callback-secret",
    TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
    TILLER_SESSION_ENV_NAMES: "SAFE_VALUE,TILLER_PLANNER_RUN_TOKEN",
    SAFE_VALUE: "visible",
  }, { authMode: "api-key" });

  assert.deepEqual(result, {
    PATH: "/bin",
    HOME: "/home/tiller",
    OPENAI_API_KEY: "openai-secret",
    SAFE_VALUE: "visible",
  });
});

test("interactive child environments retain only the exact GitHub repository bridge", () => {
  const result = sanitizeCodexChildEnvironment({
    PATH: "/bin",
    HUB_URL: "https://hub.example.test",
    CF_ACCESS_CLIENT_ID: "access-client-id",
    CF_ACCESS_CLIENT_SECRET: "access-client-secret",
    TILLER_GITHUB_BRIDGE_ID: "bridge-id",
    TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
    TILLER_GITHUB_ALLOWED_REPO: "example/repo",
    TILLER_GITHUB_BRIDGE_TOKEN: "not-allowed",
    TILLER_GITHUB_BRIDGE_EXTRA: "not-allowed",
    TILLER_RUNTIME_CAPABILITY: "not-allowed",
  }, { githubRepoAccess: true });

  assert.deepEqual(result, {
    PATH: "/bin",
    HUB_URL: "https://hub.example.test",
    CF_ACCESS_CLIENT_ID: "access-client-id",
    CF_ACCESS_CLIENT_SECRET: "access-client-secret",
    TILLER_GITHUB_BRIDGE_ID: "bridge-id",
    TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
    TILLER_GITHUB_ALLOWED_REPO: "example/repo",
  });
});

test("GitHub repository access stays disabled without a complete bridge", () => {
  const result = sanitizeCodexChildEnvironment({
    PATH: "/bin",
    HUB_URL: "https://hub.example.test",
    CF_ACCESS_CLIENT_SECRET: "access-client-secret",
    TILLER_GITHUB_BRIDGE_ID: "bridge-id",
    TILLER_GITHUB_ALLOWED_REPO: "example/repo",
  }, { githubRepoAccess: true });

  assert.deepEqual(result, { PATH: "/bin" });
});

test("GitHub repository access omits incomplete Cloudflare Access credentials", () => {
  const bridge = {
    PATH: "/bin",
    HUB_URL: "https://hub.example.test",
    TILLER_GITHUB_BRIDGE_ID: "bridge-id",
    TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
    TILLER_GITHUB_ALLOWED_REPO: "example/repo",
  };
  const expected = { ...bridge };

  assert.deepEqual(
    sanitizeCodexChildEnvironment({
      ...bridge,
      CF_ACCESS_CLIENT_ID: "access-client-id",
    }, { githubRepoAccess: true }),
    expected,
  );
  assert.deepEqual(
    sanitizeCodexChildEnvironment({
      ...bridge,
      CF_ACCESS_CLIENT_SECRET: "access-client-secret",
    }, { githubRepoAccess: true }),
    expected,
  );
});

test("external auth and non-interactive MCP elicitation use the pinned app-server protocol", async (t) => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "tiller-codex-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  const transcript = join(root, "transcript.jsonl");
  const wsModule = createRequire(import.meta.url).resolve("ws");
  const fakeServer = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const listen = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
const transcript = process.env.FAKE_CODEX_TRANSCRIPT;
try { fs.rmSync(listen); } catch {}
const record = value => fs.appendFileSync(transcript, JSON.stringify(value) + "\\n");
const server = http.createServer();
const wss = new WebSocketServer({ server, perMessageDeflate: false });
wss.on("connection", socket => {
  socket.on("message", data => {
    const message = JSON.parse(data.toString()); record(message);
    if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "account/login/start") {
      socket.send(JSON.stringify({ id: message.id, result: { type: "chatgptAuthTokens" } }));
      setTimeout(() => {
        socket.send(JSON.stringify({ id: 900, method: "account/chatgptAuthTokens/refresh", params: { reason: "unauthorized", previousAccountId: null } }));
        socket.send(JSON.stringify({
          id: 901,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "codex_apps",
            mode: "form",
            message: "Allow this request?",
            requestedSchema: { type: "object", properties: {} },
          },
        }));
      }, 10);
    }
  });
});
server.listen(listen);
process.on("SIGTERM", () => {
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
});
`;
  await writeFile(executable, fakeServer);
  await chmod(executable, 0o755);

  const oldToken = "old-access-token";
  const newToken = "new-access-token";
  const rejected = createHash("sha256").update(oldToken).digest("hex");
  const authCalls = [];
  const client = new CodexAppServerClient({
    socketPath: join(root, "app-server.sock"),
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      FAKE_CODEX_TRANSCRIPT: transcript,
    },
    codexExecutable: executable,
    declineMcpServerElicitations: true,
    rejectUnexpectedServerRequests: true,
    getAuth: async (hash) => {
      authCalls.push(hash);
      return {
        accessToken: hash ? newToken : oldToken,
        accountId: "acct-1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    },
  });

  await client.start();
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("refresh response was not observed")), 2_000);
    const poll = async () => {
      const content = await readFile(transcript, "utf8").catch(() => "");
      if (content.includes('"id":900,"result"') && content.includes('"id":901,"result"')) {
        clearTimeout(timeout);
        resolve();
      } else setTimeout(poll, 10);
    };
    void poll();
  });
  await client.stop();

  const messages = (await readFile(transcript, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(authCalls, [undefined, rejected]);
  assert.deepEqual(messages.find((message) => message.method === "account/login/start").params, {
    type: "chatgptAuthTokens",
    accessToken: oldToken,
    chatgptAccountId: "acct-1",
    chatgptPlanType: null,
  });
  assert.deepEqual(messages.find((message) => message.id === 900 && message.result).result, {
    accessToken: newToken,
    chatgptAccountId: "acct-1",
    chatgptPlanType: null,
  });
  assert.deepEqual(messages.find((message) => message.id === 901 && message.result).result, {
    action: "decline",
    content: null,
  });
});
