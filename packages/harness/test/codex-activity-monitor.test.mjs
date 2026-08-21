import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexActivityMonitor,
  codexActivityPollDelayMs,
} from "../dist/codex-activity-monitor.js";
import { CodexAppServerClient } from "../dist/codex-app-server-client.js";

function thread(id, parentThreadId, status = "idle") {
  return {
    id,
    parentThreadId,
    cwd: "/workspace",
    status: { type: status, ...(status === "active" ? { activeFlags: [] } : {}) },
  };
}

test("Codex activity reconciliation backs off repeated startup failures", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((failures) =>
      codexActivityPollDelayMs(undefined, failures)),
    [250, 250, 500, 1000, 2000, 4000, 5000],
  );
  assert.equal(codexActivityPollDelayMs(10_000, 8), 10_000);
});

test("Codex activity client uses read-only discovery and a settings-free thread join", async () => {
  const client = new CodexAppServerClient({
    socketPath: "/tmp/not-used.sock",
    cwd: "/workspace",
    env: {},
  });
  const requests = [];
  client.request = async (method, params) => {
    requests.push({ method, params });
    if (method === "thread/loaded/list") {
      return params.cursor
        ? { data: ["child"], nextCursor: null }
        : { data: ["root", "root"], nextCursor: "page-2" };
    }
    if (method === "thread/read") return { thread: thread(params.threadId, null) };
    if (method === "thread/resume") {
      return {
        thread: thread(params.threadId, null),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      };
    }
    throw new Error(`Unexpected request: ${method}`);
  };

  assert.deepEqual(await client.listLoadedThreadIds(), ["root", "child"]);
  await client.readThreadMetadata("root");
  await client.subscribeThread("root");

  assert.deepEqual(requests, [
    { method: "thread/loaded/list", params: {} },
    { method: "thread/loaded/list", params: { cursor: "page-2" } },
    {
      method: "thread/read",
      params: { threadId: "root", includeTurns: false },
    },
    {
      method: "thread/resume",
      params: { threadId: "root", excludeTurns: true },
    },
  ]);
});

test("Codex activity monitor subscribes only loaded roots and reports their completion", async () => {
  const calls = [];
  const signals = [];
  const client = {
    async listLoadedThreadIds() {
      calls.push(["list"]);
      return ["root", "child"];
    },
    async readThreadMetadata(threadId) {
      calls.push(["read", threadId]);
      return {
        thread: thread(threadId, threadId === "child" ? "root" : null, "active"),
      };
    },
    async subscribeThread(threadId) {
      calls.push(["subscribe", threadId]);
      return {
        thread: thread(threadId, null, "active"),
        cwd: "/workspace",
        approvalPolicy: "never",
        sandbox: { type: "dangerFullAccess" },
      };
    },
  };
  const monitor = new CodexActivityMonitor({
    client,
    onActivity: (signal) => signals.push(signal),
  });

  await monitor.reconcile();
  assert.deepEqual(calls, [
    ["list"],
    ["read", "root"],
    ["subscribe", "root"],
    ["read", "child"],
  ]);
  assert.deepEqual(signals, ["working"]);

  monitor.handleNotification("turn/completed", {
    threadId: "child",
    turn: { status: "completed" },
  });
  monitor.handleNotification("turn/completed", {
    threadId: "root",
    turn: { status: "completed" },
  });
  assert.deepEqual(signals, ["working", "completed"]);

  await monitor.reconcile();
  assert.deepEqual(calls.at(-1), ["list"]);
  assert.equal(calls.filter(([operation]) => operation === "subscribe").length, 1);
});

test("Codex activity monitor joins a loaded thread when its rollout is not readable yet", async () => {
  const calls = [];
  const signals = [];
  const monitor = new CodexActivityMonitor({
    client: {
      async listLoadedThreadIds() {
        calls.push(["list"]);
        return ["root"];
      },
      async readThreadMetadata(threadId) {
        calls.push(["read", threadId]);
        throw new Error(`rollout for ${threadId} is empty`);
      },
      async subscribeThread(threadId) {
        calls.push(["subscribe", threadId]);
        return {
          thread: thread(threadId, null, "active"),
          cwd: "/workspace",
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        };
      },
    },
    onActivity: (signal) => signals.push(signal),
  });

  await monitor.reconcile();
  assert.deepEqual(calls, [
    ["list"],
    ["read", "root"],
    ["subscribe", "root"],
  ]);
  assert.deepEqual(signals, ["working"]);

  monitor.handleNotification("turn/completed", {
    threadId: "root",
    turn: { status: "completed" },
  });
  assert.deepEqual(signals, ["working", "completed"]);

  await monitor.reconcile();
  assert.deepEqual(calls.at(-1), ["list"]);
  assert.equal(calls.filter(([operation]) => operation === "read").length, 1);
  assert.equal(calls.filter(([operation]) => operation === "subscribe").length, 1);
});

test("Codex activity monitor does not stay working when a turn settles during join", async () => {
  const signals = [];
  const monitor = new CodexActivityMonitor({
    client: {
      async listLoadedThreadIds() {
        return ["root"];
      },
      async readThreadMetadata() {
        return { thread: thread("root", null, "active") };
      },
      async subscribeThread() {
        return {
          thread: thread("root", null, "idle"),
          cwd: "/workspace",
          approvalPolicy: "never",
          sandbox: { type: "dangerFullAccess" },
        };
      },
    },
    onActivity: (signal) => signals.push(signal),
  });

  await monitor.reconcile();
  assert.deepEqual(signals, ["working", "idle"]);
});
