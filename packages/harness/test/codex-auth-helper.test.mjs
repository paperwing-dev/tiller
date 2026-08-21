import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexAuthHelperEnvironment,
  projectCodexAuthJson,
  refreshCodexAuthJson,
} from "../dist/codex-auth-helper.js";

function jwt(accountId, exp, nonce = "token") {
  return `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({
    chatgpt_account_id: accountId,
    exp,
    nonce,
  })).toString("base64url")}.sig`;
}

function authJson(overrides = {}) {
  return JSON.stringify({
    auth_mode: "chatgpt",
    arbitrary_future_field: { retained: true },
    tokens: {
      access_token: jwt("acct-1", 2_000_000_000, "old"),
      refresh_token: "refresh-secret",
      id_token: jwt("acct-1", 2_000_000_000, "identity"),
      account_id: "acct-1",
    },
    ...overrides,
  });
}

test("auth refresh app-server receives only its strict isolated environment", () => {
  const result = buildCodexAuthHelperEnvironment({
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/home/tiller",
    TMPDIR: "/tmp/runtime",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
    CODEX_HOME: "/home/tiller/.codex",
    NODE_OPTIONS: "--require=/tmp/inject.js",
    GIT_CONFIG_GLOBAL: "/tmp/injected-gitconfig",
    OPENAI_API_KEY: "unrelated-api-secret",
    OPENAI_BASE_URL: "https://attacker.example",
    TILLER_SESSION_ENV_NAMES: "SESSION_SECRET,NODE_OPTIONS,GIT_CONFIG_GLOBAL",
    SESSION_SECRET: "unrelated-session-secret",
    CF_ACCESS_CLIENT_SECRET: "unrelated-access-secret",
  }, "/tmp/private-codex-home");

  assert.deepEqual(result, {
    HOME: "/tmp/private-codex-home",
    CODEX_HOME: "/tmp/private-codex-home",
    TMPDIR: "/tmp/private-codex-home",
    PATH: "/usr/local/bin:/usr/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    TZ: "UTC",
  });
});

test("projects supported ChatGPT auth without exposing the refresh token", () => {
  const projection = projectCodexAuthJson(authJson());
  assert.deepEqual(projection, {
    accessToken: jwt("acct-1", 2_000_000_000, "old"),
    accountId: "acct-1",
    expiresAt: 2_000_000_000_000,
  });
  assert.equal(JSON.stringify(projection).includes("refresh-secret"), false);
});

test("the npm-bin wrapper runs through a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("file symlinks require elevated privileges on some Windows hosts");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "tiller-auth-helper-bin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binLink = join(root, "tiller-codex-auth-helper");
  const binTarget = join(process.cwd(), "dist", "codex-auth-helper-cli.js");
  const originalMode = (await stat(binTarget)).mode & 0o777;
  await chmod(binTarget, 0o755);
  t.after(() => chmod(binTarget, originalMode));
  await symlink(binTarget, binLink);

  const result = spawnSync(binLink, [], {
    input: "",
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    ok: false,
    error: { code: "invalid_input" },
  });
});

test("rejects API-key caches, malformed JSON, and JWT account mismatches", () => {
  assert.throws(
    () => projectCodexAuthJson(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "secret" })),
    (error) => error?.code === "unsupported_auth_mode",
  );
  assert.throws(
    () => projectCodexAuthJson("not-json"),
    (error) => error?.code === "invalid_input",
  );
  const mismatched = JSON.parse(authJson());
  mismatched.tokens.id_token = jwt("acct-2", 2_000_000_000);
  assert.throws(
    () => projectCodexAuthJson(JSON.stringify(mismatched)),
    (error) => error?.code === "account_mismatch",
  );
});

test("returns the exact post-refresh auth file without reconstructing dropped fields", async (t) => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "tiller-auth-helper-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  const wsModule = createRequire(import.meta.url).resolve("ws");
  const newAccessToken = jwt("acct-1", 2_100_000_000, "new");
  const fakeServer = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const listen = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
try { fs.rmSync(listen); } catch {}
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", socket => socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === "account/read") {
    const authPath = path.join(process.env.CODEX_HOME, "auth.json");
    const config = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
    if (!config.includes('cli_auth_credentials_store = "file"') || !config.includes('forced_login_method = "chatgpt"')) process.exit(2);
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    auth.tokens.access_token = ${JSON.stringify(newAccessToken)};
    auth.tokens.refresh_token = "rotated-refresh-secret";
    delete auth.arbitrary_future_field;
    auth.codex_added_field = "preserved";
    fs.writeFileSync(authPath, JSON.stringify(auth));
    socket.send(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } }));
  }
}));
server.listen(listen);
process.on("SIGTERM", () => {
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
});
`;
  await writeFile(executable, fakeServer);
  await chmod(executable, 0o755);

  const result = await refreshCodexAuthJson(authJson(), { codexExecutable: executable });
  assert.equal(result.projected.accessToken, newAccessToken);
  assert.equal(result.projected.expiresAt, 2_100_000_000_000);
  const updated = JSON.parse(result.auth_json);
  assert.equal(updated.arbitrary_future_field, undefined);
  assert.equal(updated.codex_added_field, "preserved");
  assert.equal(updated.tokens.refresh_token, "rotated-refresh-secret");
});

test("rejects structured permanent failures and every no-progress refresh", async (t) => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "tiller-auth-helper-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wsModule = createRequire(import.meta.url).resolve("ws");
  const changedWithoutLaterExpiry = jwt("acct-1", 2_000_000_000, "changed-without-later-expiry");
  const cases = [
    {
      name: "provider-rejected",
      response: { account: null, requiresOpenaiAuth: true },
      mutation: "",
      errorCode: "provider_rejected",
    },
    {
      name: "unchanged",
      response: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      mutation: "",
      errorCode: "invalid_refresh_result",
    },
    {
      name: "expiry-not-advanced",
      response: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
      mutation: `const authPath = path.join(process.env.CODEX_HOME, "auth.json");
const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
auth.tokens.access_token = ${JSON.stringify(changedWithoutLaterExpiry)};
fs.writeFileSync(authPath, JSON.stringify(auth));`,
      errorCode: "invalid_refresh_result",
    },
  ];

  for (const testCase of cases) {
    const executable = join(root, `codex-${testCase.name}`);
    const fakeServer = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const listen = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
try { fs.rmSync(listen); } catch {}
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", socket => socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === "account/read") {
    ${testCase.mutation}
    socket.send(JSON.stringify({ id: message.id, result: ${JSON.stringify(testCase.response)} }));
  }
}));
server.listen(listen);
process.on("SIGTERM", () => {
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
});
`;
    await writeFile(executable, fakeServer);
    await chmod(executable, 0o755);
    await assert.rejects(
      refreshCodexAuthJson(authJson(), { codexExecutable: executable }),
      (error) => error?.code === testCase.errorCode,
      testCase.name,
    );
  }
});

test("times out and terminates a non-responsive app-server", async (t) => {
  const root = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "tiller-auth-helper-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  const wsModule = createRequire(import.meta.url).resolve("ws");
  const fakeServer = `#!/usr/bin/env node
const http = require("node:http");
const fs = require("node:fs");
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const listen = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
try { fs.rmSync(listen); } catch {}
const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on("connection", socket => socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: {} }));
}));
server.listen(listen);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
  await writeFile(executable, fakeServer);
  await chmod(executable, 0o755);
  await assert.rejects(
    refreshCodexAuthJson(authJson(), { codexExecutable: executable, timeoutMs: 100 }),
    (error) => error?.code === "refresh_timeout",
  );
});
