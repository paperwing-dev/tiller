import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  _test,
  CODEX_ONE_SHOT_DEADLINE_MS,
  CodexOneShotCancelledError,
  codexNotificationActivity,
  codexNotificationCommentary,
  runCodexOneShot,
} from "../dist/planner/codex-one-shot.js";

test("Codex one-shot production deadline remains exactly 60 minutes", () => {
  assert.equal(CODEX_ONE_SHOT_DEADLINE_MS, 60 * 60_000);
});

test("Codex app-server notifications describe thinking and concrete work", () => {
  assert.equal(codexNotificationActivity("turn/started", {}), null);
  assert.equal(codexNotificationActivity("item/started", {
    item: { type: "commandExecution", command: "rg -n reviewer packages/hub" },
  }), "Running: rg -n reviewer packages/hub");
  assert.equal(codexNotificationActivity("item/started", {
    item: { type: "mcpToolCall", server: "github", tool: "search_code" },
  }), "Using github.search_code");
  assert.equal(codexNotificationActivity("item/started", {
    item: { type: "webSearch", query: "reviewer activity" },
  }), "Searching: reviewer activity");
  assert.equal(codexNotificationActivity("item/completed", {
    item: { type: "agentMessage", text: "private intermediate text" },
  }), null);
  assert.equal(codexNotificationCommentary("item/completed", {
    item: { type: "agentMessage", phase: "commentary", text: "Tracing the callback path." },
  }), "Tracing the callback path.");
  assert.equal(codexNotificationCommentary("item/completed", {
    item: {
      type: "reasoning",
      summary: ["The callback drops commentary.", "I’ll preserve it separately."],
      content: ["raw private chain-of-thought"],
    },
  }), "The callback drops commentary.\n\nI’ll preserve it separately.");
  assert.equal(codexNotificationCommentary("item/completed", {
    item: { type: "reasoning", summary: [], content: ["raw private chain-of-thought"] },
  }), null);
  assert.equal(codexNotificationCommentary("item/completed", {
    item: { type: "agentMessage", phase: "final_answer", text: "Final review" },
  }), null);
});

test("one-shot extraction prefers the exact turn's final-answer message", () => {
  assert.equal(_test.finalAgentMessage([
    { id: "one", type: "agentMessage", phase: "commentary", text: "working" },
    { id: "two", type: "agentMessage", phase: "final_answer", text: "first final" },
    { id: "three", type: "agentMessage", phase: "final_answer", text: "authoritative final" },
  ]), "authoritative final");
});

test("one-shot extraction allows pinned-version null phases", () => {
  assert.equal(_test.finalAgentMessage([
    { id: "one", type: "agentMessage", phase: null, text: "compatible final" },
  ]), "compatible final");
});

test("one-shot extraction rejects commentary-only output", () => {
  assert.throws(
    () => _test.finalAgentMessage([
      { id: "one", type: "agentMessage", phase: "commentary", text: "not final" },
    ]),
    /without a final agent message/,
  );
});

class FakeCodexClient extends EventEmitter {
  closed = new Promise(() => {});
  interruptCalls = [];
  requests = [];
  stopped = false;

  constructor({
    complete = false,
    finalText = "Authoritative final",
    inspectionSucceeds = true,
    environmentInfo = { shell: { name: "bash", path: "/bin/bash" }, cwd: "file:///workspace" },
    environmentError = null,
  } = {}) {
    super();
    this.complete = complete;
    this.finalText = finalText;
    this.inspectionSucceeds = inspectionSucceeds;
    this.environmentInfo = environmentInfo;
    this.environmentError = environmentError;
  }

  async start() {}

  async stop() {
    this.stopped = true;
  }

  async request(method, params) {
    this.requests.push([method, params]);
    if (method === "environment/info") {
      if (this.environmentError) throw this.environmentError;
      return this.environmentInfo;
    }
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      if (this.complete) {
        this.emit("notification", "item/started", {
          item: { type: "commandExecution", command: "rg -n reviewer packages/hub" },
        });
        this.emit("notification", "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "inspect",
            type: "commandExecution",
            command: "rg -n reviewer packages/hub",
            cwd: "/workspace",
            status: this.inspectionSucceeds ? "completed" : "failed",
            exitCode: this.inspectionSucceeds ? 0 : 1,
            commandActions: [{ type: "search", command: "rg -n reviewer packages/hub", query: "reviewer", path: "packages/hub" }],
          },
        });
        this.emit("notification", "item/completed", {
          threadId: "other-thread",
          turnId: "turn-1",
          item: { id: "other", type: "agentMessage", phase: "final_answer", text: "Wrong thread" },
        });
        this.emit("notification", "item/completed", {
          threadId: "thread-1",
          turnId: "other-turn",
          item: { id: "other-turn", type: "agentMessage", phase: "final_answer", text: "Wrong turn" },
        });
        this.emit("notification", "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "reason", type: "reasoning", summary: ["Checking the implementation."], content: ["private work"] },
        });
        this.emit("notification", "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "work", type: "agentMessage", phase: "commentary", text: "The event filter is the key boundary." },
        });
        this.emit("notification", "item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "final", type: "agentMessage", phase: "final_answer", text: this.finalText },
        });
        this.emit("notification", "turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null },
        });
      }
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  async interruptTurn(threadId, turnId) {
    this.interruptCalls.push([threadId, turnId]);
  }
}

function oneShotInput(client, overrides = {}) {
  return {
    cwd: "/workspace",
    model: "gpt-test",
    prompt: "Review.",
    getAuth: async () => ({ accessToken: "token", accountId: "account" }),
    isCancelled: async () => false,
    completionTimeoutMs: 200,
    cancellationPollMs: 5,
    env: { ...process.env, RUNNER_BACKEND: "host" },
    clientFactory: () => client,
    ...overrides,
  };
}

test("Codex one-shot returns only the authoritative final output", async () => {
  const client = new FakeCodexClient({ complete: true, finalText: "Final review" });
  const activities = [];
  const commentary = [];
  const output = await runCodexOneShot(oneShotInput(client, {
    onActivity: (message) => activities.push(message),
    onCommentary: (message) => commentary.push(message),
    requireInspection: true,
  }));

  assert.equal(output, "Final review");
  assert.deepEqual(activities, ["Running: rg -n reviewer packages/hub"]);
  assert.deepEqual(commentary, [
    "Checking the implementation.",
    "The event filter is the key boundary.",
  ]);
  assert.deepEqual(client.requests.map(([method]) => method), [
    "environment/info",
    "thread/start",
    "turn/start",
  ]);
  assert.deepEqual(client.requests[0][1], { environmentId: "local" });
  const threadParams = client.requests.find(([method]) => method === "thread/start")[1];
  const turnParams = client.requests.find(([method]) => method === "turn/start")[1];
  assert.equal(threadParams.ephemeral, true);
  assert.deepEqual(threadParams.environments, [{ environmentId: "local", cwd: "/workspace" }]);
  assert.deepEqual(turnParams.environments, [{ environmentId: "local", cwd: "/workspace" }]);
  assert.deepEqual(threadParams.config, {
    mcp_servers: {},
    "features.use_legacy_landlock": true,
  });
  assert.deepEqual(threadParams.runtimeWorkspaceRoots, ["/workspace"]);
  assert.deepEqual(turnParams.runtimeWorkspaceRoots, ["/workspace"]);
  assert.equal(threadParams.sandbox, "read-only");
  assert.deepEqual(turnParams.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(client.requests.some(([method]) => method === "thread/read"), false);
  assert.equal(client.stopped, true);
});

test("Codex one-shot keeps the default bwrap sandbox on Cloudflare", async () => {
  const client = new FakeCodexClient({ complete: true });
  await runCodexOneShot(oneShotInput(client, {
    env: { ...process.env, RUNNER_BACKEND: "cf" },
  }));

  const threadParams = client.requests.find(([method]) => method === "thread/start")[1];
  assert.deepEqual(threadParams.config, { mcp_servers: {} });
});

test("Codex one-shot rejects final prose when repository inspection failed", async () => {
  const client = new FakeCodexClient({ complete: true, inspectionSucceeds: false });
  await assert.rejects(
    runCodexOneShot(oneShotInput(client, { requireInspection: true })),
    /without successfully inspecting the repository checkout/,
  );
  assert.equal(client.stopped, true);
});

test("Codex one-shot allows synthesis-only prose when inspection is not required", async () => {
  const client = new FakeCodexClient({
    complete: true,
    finalText: "Synthesized review",
    inspectionSucceeds: false,
  });
  assert.equal(
    await runCodexOneShot(oneShotInput(client, { requireInspection: false })),
    "Synthesized review",
  );
  assert.equal(client.stopped, true);
});

test("Codex one-shot fails before thread creation when the local environment is unavailable", async () => {
  const upstream = new Error("unknown environment id `local`");
  const client = new FakeCodexClient({ environmentError: upstream });
  let socketDirectory = "";
  await assert.rejects(
    runCodexOneShot(oneShotInput(client, {
      clientFactory: (options) => {
        socketDirectory = dirname(options.socketPath);
        return client;
      },
    })),
    (error) => {
      assert.match(error.message, /local reviewer environment is unavailable/);
      assert.equal(error.cause, upstream);
      return true;
    },
  );
  assert.deepEqual(client.requests.map(([method]) => method), ["environment/info"]);
  assert.equal(client.stopped, true);
  assert.ok(socketDirectory);
  assert.equal(existsSync(socketDirectory), false);
});

for (const [label, environmentInfo] of [
  ["missing shell", {}],
  ["missing shell name", { shell: { path: "/bin/bash" } }],
  ["blank shell name", { shell: { name: "  ", path: "/bin/bash" } }],
  ["blank shell path", { shell: { name: "bash", path: "  " } }],
]) {
  test(`Codex one-shot rejects ${label} before thread creation`, async () => {
    const client = new FakeCodexClient({ environmentInfo });
    await assert.rejects(
      runCodexOneShot(oneShotInput(client)),
      (error) => {
        assert.match(error.message, /local reviewer environment is unavailable/);
        assert.match(error.cause?.message ?? "", /invalid shell metadata/);
        return true;
      },
    );
    assert.deepEqual(client.requests.map(([method]) => method), ["environment/info"]);
    assert.equal(client.stopped, true);
  });
}

test("Codex one-shot uses and cleans a private app-server socket directory", async () => {
  const client = new FakeCodexClient({ complete: true });
  let socketDirectory = "";
  await runCodexOneShot(oneShotInput(client, {
    clientFactory: (options) => {
      socketDirectory = dirname(options.socketPath);
      assert.equal(statSync(socketDirectory).mode & 0o777, 0o700);
      assert.equal(options.declineMcpServerElicitations, true);
      return client;
    },
  }));

  assert.ok(socketDirectory);
  assert.equal(existsSync(socketDirectory), false);
});

test("Codex one-shot retains its completion deadline", async () => {
  const client = new FakeCodexClient();
  await assert.rejects(
    runCodexOneShot(oneShotInput(client, { completionTimeoutMs: 20 })),
    /Timed out waiting for Codex reviewer completion/,
  );
  assert.equal(client.stopped, true);
});

test("Codex one-shot ignores transient cancellation poll failures", async () => {
  const client = new FakeCodexClient();
  let polls = 0;
  await assert.rejects(
    runCodexOneShot(oneShotInput(client, {
      isCancelled: async () => {
        polls += 1;
        if (polls === 1) throw new Error("temporary callback failure");
        return true;
      },
    })),
    (error) => error instanceof CodexOneShotCancelledError,
  );
  assert.ok(polls >= 2);
  assert.deepEqual(client.interruptCalls, [["thread-1", "turn-1"]]);
  assert.equal(client.stopped, true);
});
