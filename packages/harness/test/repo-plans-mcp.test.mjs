import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MAX_REPO_PLAN_COMMAND_BODY_BYTES,
  planWriterStoppingError,
  proxyRepoPlanCommand,
  readPlanWriterLocalBody,
} from "../dist/plan-writer/supervisor-http.js";
import { requestRepoPlanSupervisor } from "../dist/plan-writer/repo-plans-client.js";

test("stopping repository-plan commands keep the compact inactive-source contract", () => {
  assert.deepEqual(
    planWriterStoppingError({ method: "POST", url: "/repo-plans" }),
    {
      error: "This Plan Writer generation is stopping.",
      code: "source_inactive",
    },
  );
  assert.deepEqual(
    planWriterStoppingError({ method: "POST", url: "/opencode-hook" }),
    { error: "This Plan Writer generation is stopping." },
  );
});

test("repository-plan client retries an attempt whose response never completes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiller-plans-client-timeout-"));
  const socketPath = join(root, "supervisor.sock");
  let attempts = 0;
  const supervisor = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the command before responding.
    }
    attempts += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    if (attempts === 1) {
      response.write('{"version":');
      return;
    }
    response.end('{"version":3}');
  });
  await new Promise((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.listen(socketPath, resolve);
  });
  t.after(async () => {
    supervisor.closeAllConnections();
    await new Promise((resolve) => supervisor.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    await requestRepoPlanSupervisor(
      socketPath,
      {
        operation: "update",
        planId: "plan-2",
        expectedVersion: 2,
        markdown: "# Updated\n",
      },
      { attemptTimeoutMs: 100 },
    ),
    { status: 200, body: { version: 3 } },
  );
  assert.equal(attempts, 2);
});

test("repository plan MCP exposes four strict tools and preserves create identities across retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiller-plans-mcp-"));
  const socketPath = join(root, "supervisor.sock");
  const requests = [];
  let firstCreateFailed = false;
  let firstReadMalformed = false;
  let firstListAborted = false;
  const summary = {
    id: "plan-2",
    title: "Plan two",
    status: "draft",
    version: 2,
    updatedAt: "2026-08-15T00:00:00.000Z",
    basisCommit: "main-1",
  };
  const supervisor = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ method: request.method, url: request.url, body, raw });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/repo-plans");

    if (body.operation === "list" && !firstListAborted) {
      firstListAborted = true;
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "4096",
      });
      response.write('{"plans":[');
      response.destroy();
      return;
    }
    if (body.operation === "create" && !firstCreateFailed) {
      firstCreateFailed = true;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "source_inactive", error: "retry" }));
      return;
    }
    if (body.operation === "read" && !firstReadMalformed) {
      firstReadMalformed = true;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"broken":');
      return;
    }
    const payload =
      body.operation === "list"
        ? { plans: [summary] }
        : body.operation === "read"
          ? { ...summary, markdown: "# Plan two\n" }
          : body.operation === "update"
            ? { ...summary, version: 3 }
            : summary;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.listen(socketPath, resolve);
  });
  t.after(async () => {
    supervisor.closeAllConnections();
    await new Promise((resolve) => supervisor.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../dist/plan-writer/plans-mcp.js",
      ),
    ],
    env: { ...inherited, TILLER_PLAN_WRITER_SOCKET: socketPath },
    stderr: "pipe",
  });
  const client = new Client({ name: "tiller-plans-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);

  const callJson = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    return { result, body: JSON.parse(result.content[0].text) };
  };

  const listedTools = await client.listTools();
  assert.deepEqual(
    listedTools.tools.map((tool) => tool.name),
    ["list_plans", "read_plan", "create_plan", "update_plan"],
  );
  for (const tool of listedTools.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }

  assert.deepEqual((await callJson("list_plans", {})).body, {
    plans: [summary],
  });
  assert.equal(
    requests.filter(({ body }) => body.operation === "list").length,
    2,
  );
  assert.equal(
    (await callJson("read_plan", { planId: "plan-2" })).body.markdown,
    "# Plan two\n",
  );
  assert.equal(
    requests.filter(({ body }) => body.operation === "read").length,
    2,
  );

  await callJson("create_plan", { markdown: "# Created\n" });
  const firstCreate = requests.filter(
    ({ body }) => body.operation === "create",
  );
  assert.equal(firstCreate.length, 2);
  assert.equal(firstCreate[0].body.requestId, firstCreate[1].body.requestId);
  assert.match(firstCreate[0].body.requestId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(Object.keys(firstCreate[0].body).sort(), [
    "markdown",
    "operation",
    "requestId",
  ]);

  await callJson("create_plan", { markdown: "# Created again\n" });
  const creates = requests.filter(({ body }) => body.operation === "create");
  assert.notEqual(creates[2].body.requestId, creates[0].body.requestId);

  assert.deepEqual(
    (
      await callJson("update_plan", {
        planId: "plan-2",
        expectedVersion: 2,
        markdown: "# Updated\n",
      })
    ).body,
    { ...summary, version: 3 },
  );

  const invalid = await callJson("read_plan", { planId: "" });
  assert.equal(invalid.result.isError, true);
  assert.deepEqual(invalid.body, {
    error: "planId must be a non-empty string.",
    code: "invalid_request",
  });

  const escapeHeavyMarkdown = `# Large\n\n${'"'.repeat(1024 * 1024 - 21)}\n`;
  await callJson("create_plan", { markdown: escapeHeavyMarkdown });
  const large = requests.at(-1);
  assert.equal(large.body.operation, "create");
  assert.ok(Buffer.byteLength(large.raw) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(large.raw) < 8 * 1024 * 1024);
});

test("supervisor reserves the 8 MiB encoded-body allowance for the one plan command endpoint", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiller-plans-proxy-"));
  const socketPath = join(root, "supervisor.sock");
  const forwarded = [];
  const hub = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    forwarded.push({
      method: request.method,
      url: request.url,
      token: request.headers["x-tiller-plan-writer-token"],
      raw,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => {
    hub.once("error", reject);
    hub.listen(0, "127.0.0.1", resolve);
  });
  const hubAddress = hub.address();
  assert.equal(typeof hubAddress, "object");

  let limitRejections = 0;
  const supervisor = createServer(async (request, response) => {
    try {
      if (
        await proxyRepoPlanCommand({
          request,
          response,
          enabled: true,
          callbackBase: `http://127.0.0.1:${hubAddress.port}/callback`,
          token: "generation-secret",
        })
      )
        return;
      await readPlanWriterLocalBody(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
    } catch {
      limitRejections += 1;
      if (!response.destroyed) {
        response.writeHead(413, { "Content-Type": "application/json" });
        response.end('{"error":"too large"}');
      }
    }
  });
  await new Promise((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.listen(socketPath, resolve);
  });
  t.after(async () => {
    supervisor.closeAllConnections();
    hub.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => supervisor.close(resolve)),
      new Promise((resolve) => hub.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });

  const send = (path, raw) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(raw),
          },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body }),
          );
        },
      );
      request.on("error", reject);
      request.end(raw);
    });

  const markdown = `# Large\n\n${'"'.repeat(1024 * 1024 - 21)}\n`;
  const command = JSON.stringify({
    operation: "create",
    requestId: "00000000-0000-4000-8000-000000000001",
    markdown,
  });
  assert.ok(Buffer.byteLength(command) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(command) < 8 * 1024 * 1024);
  assert.equal((await send("/repo-plans", command)).status, 200);
  assert.deepEqual(
    forwarded.map(({ method, url, token }) => ({ method, url, token })),
    [
      {
        method: "POST",
        url: "/callback/repo-plans",
        token: "generation-secret",
      },
    ],
  );
  assert.equal(JSON.parse(forwarded[0].raw).markdown, markdown);

  const emptyBoundaryCommand = JSON.stringify({
    operation: "create",
    requestId: "00000000-0000-4000-8000-000000000002",
    markdown: "",
  });
  const exactBoundaryCommand = JSON.stringify({
    operation: "create",
    requestId: "00000000-0000-4000-8000-000000000002",
    markdown: "x".repeat(
      MAX_REPO_PLAN_COMMAND_BODY_BYTES -
        Buffer.byteLength(emptyBoundaryCommand),
    ),
  });
  assert.equal(
    Buffer.byteLength(exactBoundaryCommand),
    MAX_REPO_PLAN_COMMAND_BODY_BYTES,
  );
  assert.equal((await send("/repo-plans", exactBoundaryCommand)).status, 200);
  assert.equal(forwarded.length, 2);

  let planCommandRejected = false;
  try {
    const result = await send("/repo-plans", `${exactBoundaryCommand} `);
    planCommandRejected = (result.status ?? 0) >= 400;
  } catch {
    planCommandRejected = true;
  }
  assert.equal(planCommandRejected, true);
  assert.equal(forwarded.length, 2);
  assert.equal(limitRejections, 0);

  let ordinaryRejected = false;
  try {
    const result = await send(
      "/opencode-hook",
      JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024 + 1) }),
    );
    ordinaryRejected = (result.status ?? 0) >= 400;
  } catch {
    ordinaryRejected = true;
  }
  assert.equal(ordinaryRejected, true);
  assert.equal(limitRejections, 1);
});
