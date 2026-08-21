import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePlannerLine,
  PlannerOutputTracker,
} from "../dist/planner/output-tracker.js";

test("captures Claude fallback text, session ids, and tool activity", () => {
  assert.deepEqual(
    parsePlannerLine("claude-code", JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Reading the repo." }] },
    })),
    { assistantText: "Reading the repo.", commentary: "Reading the repo." },
  );
  assert.deepEqual(
    parsePlannerLine("claude-code", JSON.stringify({ type: "result", result: "Final review." })),
    { assistantText: "Final review." },
  );
  assert.deepEqual(
    parsePlannerLine("claude-code", JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" })),
    { sessionId: "sess-1" },
  );
  assert.deepEqual(
    parsePlannerLine("claude-code", JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "packages/hub/api/hub.ts" } }] },
    })),
    { activity: "Read: packages/hub/api/hub.ts" },
  );
});

test("captures Codex final fallback text, thread ids, and concrete work items", () => {
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Authoritative fallback." },
    })),
    {
      assistantText: "Authoritative fallback.",
      commentaryCandidate: "Authoritative fallback.",
    },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", phase: "commentary", text: "Checking the runtime boundary." },
    })),
    {
      assistantText: "Checking the runtime boundary.",
      commentary: "Checking the runtime boundary.",
    },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.completed",
      item: { type: "reasoning", text: "Tracing the callback and UI boundaries." },
    })),
    { commentary: "Tracing the callback and UI boundaries." },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({ type: "thread.started", thread_id: "thread-9" })),
    { sessionId: "thread-9" },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.started",
      item: { type: "command_execution", command: "rg -n secret packages/hub" },
    })),
    { activity: "Running: rg -n secret packages/hub" },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.started",
      item: { type: "mcp_tool_call", server: "github", tool: "search_code" },
    })),
    { activity: "Using github.search_code" },
  );
  assert.deepEqual(
    parsePlannerLine("codex", JSON.stringify({
      type: "item.started",
      item: { type: "web_search", query: "Cloudflare Durable Objects concurrency" },
    })),
    { activity: "Searching: Cloudflare Durable Objects concurrency" },
  );
});

test("captures OpenCode fallback text, session ids, and tool activity", () => {
  assert.deepEqual(
    parsePlannerLine("opencode", JSON.stringify({ type: "session.created", session: { id: "oc-session-1" } })),
    { sessionId: "oc-session-1" },
  );
  assert.deepEqual(
    parsePlannerLine("opencode", JSON.stringify({
      type: "message",
      sessionID: "oc-session-1",
      message: { role: "assistant", content: [{ type: "text", text: "Final OpenCode review." }] },
    })),
    {
      assistantText: "Final OpenCode review.",
      commentary: "Final OpenCode review.",
      sessionId: "oc-session-1",
    },
  );
  assert.deepEqual(
    parsePlannerLine("opencode", JSON.stringify({
      type: "tool.start",
      tool: { name: "read", input: { file_path: "packages/hub/src/PlanView.tsx" } },
    })),
    { activity: "read: packages/hub/src/PlanView.tsx" },
  );
  assert.deepEqual(
    parsePlannerLine("opencode", JSON.stringify({
      type: "tool",
      part: {
        type: "tool",
        tool: "bash",
        state: { input: { command: "rg -n reviewer packages/hub" } },
      },
    })),
    { activity: "bash: rg -n reviewer packages/hub" },
  );
  assert.deepEqual(
    parsePlannerLine("opencode", JSON.stringify({
      type: "error",
      sessionID: "oc-session-1",
      error: {
        name: "UnknownError",
        data: { message: "Type validation failed" },
      },
    })),
    {
      providerError: "UnknownError: Type validation failed",
      sessionId: "oc-session-1",
    },
  );
});

test("ignores unparseable provider output", () => {
  assert.equal(parsePlannerLine("opencode", "Looking at the code"), null);
  assert.equal(parsePlannerLine("claude-code", "garbage"), null);
  assert.equal(parsePlannerLine("codex", "   "), null);
  assert.equal(parsePlannerLine("claude-code", JSON.stringify({ type: "unknown_event" })), null);
});

test("output tracker publishes user-facing commentary and selects the final fallback", () => {
  const activities = [];
  const commentary = [];
  const tracker = new PlannerOutputTracker(
    "claude-code",
    (message) => activities.push(message),
    undefined,
    (message) => commentary.push(message),
  );
  tracker.handleLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2" }));
  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "Intermediate reasoning." }] },
  }));
  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "private" } }] },
  }));
  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "private" } }] },
  }));
  tracker.handleLine(JSON.stringify({ type: "result", result: "Final fallback text." }));

  assert.equal(tracker.providerSessionId, "sess-2");
  assert.equal(tracker.finalFallbackText, "Final fallback text.");
  assert.deepEqual(activities, ["Grep: private"]);
  assert.deepEqual(commentary, ["Intermediate reasoning."]);
  assert.equal("postEvent" in tracker, false);
  assert.equal("startHeartbeat" in tracker, false);
});

test("output tracker requires Claude tool success, not a tool attempt", () => {
  const tracker = new PlannerOutputTracker("claude-code", undefined, "/workspace");
  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/index.ts" } }] },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, false);
  tracker.handleLine(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "read-1", is_error: true, content: "denied" }] },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, false);

  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "reviewer" } }] },
  }));
  tracker.handleLine(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "grep-1", content: "src/index.ts:1" }] },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, true);
});

test("output tracker recognizes a successful Claude Bash repository inspection", () => {
  const tracker = new PlannerOutputTracker("claude-code", undefined, "/workspace");
  tracker.handleLine(JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "git diff -- src/index.ts" } }] },
  }));
  tracker.handleLine(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "diff --git" }] },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, true);
});

test("output tracker recognizes only successful Codex repository commands", () => {
  const tracker = new PlannerOutputTracker("codex", undefined, "/workspace");
  tracker.handleLine(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "rg -n reviewer src", status: "failed", exit_code: 1 },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, false);
  tracker.handleLine(JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "/bin/bash -lc 'git diff -- src/index.ts'", status: "completed", exit_code: 0 },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, true);
});

test("output tracker surfaces unphased Codex messages only after later work", () => {
  const commentary = [];
  const tracker = new PlannerOutputTracker(
    "codex",
    undefined,
    "/workspace",
    (message) => commentary.push(message),
  );
  tracker.handleLine(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "I’ll inspect the callback path." },
  }));
  assert.deepEqual(commentary, []);
  tracker.handleLine(JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "rg -n model_activity packages/hub" },
  }));
  assert.deepEqual(commentary, ["I’ll inspect the callback path."]);

  tracker.handleLine(JSON.stringify({
    type: "item.completed",
    item: { type: "reasoning", text: "The event filter drops prose." },
  }));
  tracker.handleLine(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Final answer must stay local." },
  }));
  assert.deepEqual(commentary, [
    "I’ll inspect the callback path.",
    "The event filter drops prose.",
  ]);
  assert.equal(tracker.finalFallbackText, "Final answer must stay local.");
});

test("output tracker recognizes successful OpenCode inspection tools", () => {
  const tracker = new PlannerOutputTracker("opencode", undefined, "/workspace");
  tracker.handleLine(JSON.stringify({
    type: "tool_use",
    part: {
      type: "tool",
      tool: "bash",
      state: { status: "completed", input: { command: "cat src/index.ts" }, metadata: { exit: 1 } },
    },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, false);
  tracker.handleLine(JSON.stringify({
    type: "tool_use",
    part: {
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { filePath: "src/index.ts" }, output: "source" },
    },
  }));
  assert.equal(tracker.hasSuccessfulRepositoryInspection, true);
});
