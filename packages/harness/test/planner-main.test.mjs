import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "planner", "main.js");
const RUN_ID = "run-e2e";
const RUN_TOKEN = "test-run-token";
const { HARNESS_OWNED_CLAUDE_ENV_KEYS } = await import("../dist/claude-environment.js");

const DIRTY_CLAUDE_ENV = Object.fromEntries(
  HARNESS_OWNED_CLAUDE_ENV_KEYS.map((key) => [key, `dirty-${key}`]),
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createRepo(root) {
  const srcDir = join(root, "src-repo");
  execFileSync("git", ["init", "-q", srcDir]);
  git(srcDir, "config", "user.email", "test@example.com");
  git(srcDir, "config", "user.name", "Test");
  writeFileSync(join(srcDir, "README.md"), "hello planner\n");
  git(srcDir, "add", ".");
  git(srcDir, "commit", "-q", "-m", "initial");
  const commit = git(srcDir, "rev-parse", "HEAD");
  return { repoUrl: srcDir, commit };
}

function restoreOwnerWrite(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, stat.mode | 0o700);
    for (const entry of readdirSync(path)) restoreOwnerWrite(join(path, entry));
  } else {
    chmodSync(path, stat.mode | 0o600);
  }
}

function cleanupRoot(root) {
  restoreOwnerWrite(root);
  rmSync(root, { recursive: true, force: true });
}

// Fake `claude` CLI variants. Extensionless + shebang + no nearby package.json
// means node treats them as CommonJS.
const FAKE_CLI_SUCCESS = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-e2e" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Exploring the repo." }] } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-e2e", name: "Read", input: { file_path: "README.md" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-e2e", content: "hello planner" }] } }));
writeFileSync(process.env.TILLER_PLANNER_OUTPUT_FILE, "# Plan\\n\\nWritten by the fake CLI.\\n");
console.log(JSON.stringify({ type: "result", result: "done" }));
`;

const FAKE_CLI_HANG = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hang" }));
setTimeout(() => {}, 30000);
`;

const FAKE_CLI_FAIL = `#!/usr/bin/env node
console.error("synthetic provider explosion");
process.exit(3);
`;

const FAKE_CLI_NO_INSPECTION = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TILLER_PLANNER_OUTPUT_FILE, "Unverified reviewer prose.\\n");
console.log(JSON.stringify({ type: "result", result: "Unverified reviewer prose." }));
`;

const FAKE_CLI_FALLBACK = `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-fallback" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "I’m tracing the reviewer path." }] } }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-fallback", name: "Read", input: { file_path: "README.md" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-fallback", content: "hello planner" }] } }));
console.log(JSON.stringify({ type: "result", result: "Final fallback review." }));
`;

const FAKE_CLI_CAPTURE = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.TILLER_ENV_CAPTURE_FILE, JSON.stringify(process.env));
writeFileSync(process.env.TILLER_PLANNER_OUTPUT_FILE, "Sanitized reviewer output.\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-sanitized" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-sanitized", name: "Read", input: { file_path: "README.md" } }] } }));
console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-sanitized", content: "workspace" }] } }));
console.log(JSON.stringify({ type: "result", result: "Sanitized reviewer output." }));
`;

function writeFakeCli(root, script) {
  const binDir = join(root, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = join(binDir, "claude");
  writeFileSync(cliPath, script);
  chmodSync(cliPath, 0o755);
  return binDir;
}

function startHubStub({
  context,
  runStatusFn,
  activityResponseDelayMs = 0,
  resultResponseStatusFn = () => 200,
}) {
  const received = { events: [], results: [], order: [], badTokenRequests: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.headers["x-tiller-planner-run-token"] !== RUN_TOKEN) {
        received.badTokenRequests += 1;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/context")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(context));
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/events")) {
        const parsed = body ? JSON.parse(body) : {};
        const events = Array.isArray(parsed.events) ? parsed.events : [];
        received.events.push(...events);
        const hasActivity = events.some((event) => event.type === "model_activity");
        const respond = () => {
          if (hasActivity) received.order.push("activity-response");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, runStatus: runStatusFn() }));
        };
        if (hasActivity && activityResponseDelayMs > 0) setTimeout(respond, activityResponseDelayMs);
        else respond();
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/result")) {
        const result = JSON.parse(body);
        received.order.push("result-request");
        received.results.push(result);
        const status = resultResponseStatusFn(result, received.results.length);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status >= 200 && status < 300
          ? { ok: true }
          : { error: "synthetic result callback failure" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

function createWorkspaceTar(root) {
  const workspaceDir = join(root, "workspace-source");
  const tarPath = join(root, "workspace.tar");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "README.md"), "immutable review workspace\n");
  execFileSync("tar", ["-cf", tarPath, "-C", workspaceDir, "."]);
  return readFileSync(tarPath);
}

function createInspectionTar(root) {
  const inspectionDir = join(root, "inspection-source");
  const tarPath = join(root, "inspection.tar");
  mkdirSync(join(inspectionDir, "objects"), { recursive: true });
  writeFileSync(join(inspectionDir, "objects", "000001.before"), "immutable review workspace before\n");
  writeFileSync(join(inspectionDir, "README.md"), "# Tiller review context\n");
  writeFileSync(join(inspectionDir, "manifest.json"), JSON.stringify({
    formatVersion: 1,
    files: [{ path: "/README.md", status: "modified", beforeObject: "objects/000001.before" }],
  }));
  execFileSync("tar", ["-cf", tarPath, "-C", inspectionDir, "."]);
  return readFileSync(tarPath);
}

function startEnvReviewHubStub({ context, workspaceTar, inspectionTar }) {
  const received = { events: [], results: [], badTokenRequests: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.headers["x-tiller-env-review-run-token"] !== RUN_TOKEN) {
        received.badTokenRequests += 1;
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/context")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(context));
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/workspace.tar")) {
        res.writeHead(200, { "Content-Type": "application/x-tar" });
        res.end(workspaceTar);
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/inspection.tar")) {
        res.writeHead(200, { "Content-Type": "application/x-tar" });
        res.end(inspectionTar);
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/events")) {
        const parsed = body ? JSON.parse(body) : {};
        received.events.push(...(Array.isArray(parsed.events) ? parsed.events : []));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, runStatus: "running" }));
        return;
      }
      if (req.method === "POST" && req.url?.endsWith("/result")) {
        received.results.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, received, port: server.address().port });
    });
  });
}

function buildContext(commit) {
  return {
    run: {
      runId: RUN_ID,
      repoId: "r1",
      planArtifactId: "p1",
      role: "reviewer",
      provider: "claude-code",
      model: "",
      status: "queued",
    },
    input: { githubBaseCommitSha: commit },
    plan: { id: "p1", title: "Test plan", version: 1, markdown: "# Test plan\n\nBody." },
    skillInstructions: "Review for migration risk.",
    threadMessages: [],
    threadMessagesTruncated: false,
  };
}

function buildEnvReviewContext(runOverrides = {}) {
  return {
    run: {
      runId: RUN_ID,
      envSlug: "env-e2e",
      repoId: "r1",
      threadId: "thread-e2e",
      provider: "claude-code",
      model: "sonnet",
      effort: "high",
      roleLabel: "Security Reviewer",
      status: "queued",
      ...runOverrides,
    },
    prompt: "Review the immutable workspace.",
    workspace: { githubDeletedPaths: [] },
  };
}

function runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha, extraEnv = {} }) {
  const child = spawn(process.execPath, [MAIN_PATH], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TILLER_PLANNER_CALLBACK_BASE: `http://127.0.0.1:${port}/api/planner-runtime/repos/r1/runs/${RUN_ID}`,
      TILLER_PLANNER_RUN_TOKEN: RUN_TOKEN,
      TILLER_HARNESS: "claude-code",
      TILLER_PLANNER_OUTPUT_FILE: join(root, "out", "output.md"),
      TILLER_PLANNER_CHECKOUT_DIR: join(root, "job", "checkout"),
      TILLER_PLANNER_STATUS_POLL_MS: "100",
      REPO_URL: repoUrl,
      TILLER_GITHUB_BASE_COMMIT_SHA: baseCommitSha,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`planner main did not exit in time. stderr:\n${stderr}`));
    }, 20000);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { exited, stderrText: () => stderr };
}

function runEnvReviewMain({ root, port, binDir, extraEnv = {} }) {
  const child = spawn(process.execPath, [MAIN_PATH], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      TILLER_ENV_REVIEW_CALLBACK_BASE: `http://127.0.0.1:${port}/api/env-review-runtime/envs/env-e2e/runs/${RUN_ID}`,
      TILLER_ENV_REVIEW_RUN_TOKEN: RUN_TOKEN,
      TILLER_HARNESS: "claude-code",
      TILLER_PLANNER_OUTPUT_FILE: join(root, "out", "output.md"),
      TILLER_PLANNER_CHECKOUT_DIR: join(root, "job", "checkout"),
      TILLER_PLANNER_STATUS_POLL_MS: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`env review main did not exit in time. stderr:\n${stderr}`));
    }, 20000);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  return { exited, stderrText: () => stderr };
}

function assertSanitizedClaudeEnvironment(captured, mode, credentialValue) {
  const selectedKey = mode === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";
  assert.equal(captured[selectedKey], credentialValue);
  assert.equal(captured.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.equal(captured.TILLER_CLAUDE_AUTH_RESOLVED_MODE, mode);
  assert.equal(captured.UNRELATED_REVIEWER_FLAG, undefined);
  for (const key of HARNESS_OWNED_CLAUDE_ENV_KEYS) {
    if (key === selectedKey || key === "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST" || key === "TILLER_CLAUDE_AUTH_RESOLVED_MODE") continue;
    assert.equal(captured[key], undefined, `${key} should be absent at the Claude spawn boundary`);
  }
}

test("planner main reports reviewer output as text", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_SUCCESS);
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "running",
  });
  try {
    const { exited, stderrText } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 0);
    assert.equal(received.results.length, 1);
    assert.equal(received.results[0].status, "succeeded");
    assert.match(received.results[0].text, /Written by the fake CLI/);
    assert.equal(received.results[0].markdown, undefined);
    assert.deepEqual(received.events, [
      { type: "runtime_startup" },
      { type: "model_activity", message: "Thinking" },
      { type: "model_commentary", message: "Exploring the repo." },
      { type: "model_activity", message: "Read: README.md" },
    ]);
    assert.match(stderrText(), /provider session id=sess-e2e/);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("planner main never reclassifies produced output when success delivery is exhausted", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_SUCCESS);
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "saving",
    resultResponseStatusFn: (result) => result.status === "succeeded" ? 503 : 200,
  });
  try {
    const { exited, stderrText } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 1);
    assert.equal(received.results.length, 4);
    assert.ok(received.results.every((result) => result.status === "succeeded"));
    assert.match(stderrText(), /output was produced but could not be delivered/);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("initial planner review rejects prose produced without successful repository inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_NO_INSPECTION);
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "running",
  });
  try {
    const { exited } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 1);
    assert.equal(received.results.length, 1);
    assert.equal(received.results[0].status, "failed");
    assert.match(received.results[0].error, /without successfully inspecting the repository checkout/);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("planner follow-up conversation does not require another repository inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_NO_INSPECTION);
  const context = buildContext(commit);
  context.input.instruction = "Explain the prior review.";
  const { server, received, port } = await startHubStub({
    context,
    runStatusFn: () => "running",
  });
  try {
    const { exited } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 0);
    assert.deepEqual(received.results, [{ status: "succeeded", text: "Unverified reviewer prose." }]);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("planner reviewer sanitizes Claude environment at its final spawn boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_CAPTURE);
  const captureFile = join(root, "planner-claude-env.json");
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "running",
  });
  try {
    const { exited } = runPlannerMain({
      root,
      port,
      binDir,
      repoUrl,
      baseCommitSha: commit,
      extraEnv: {
        ...DIRTY_CLAUDE_ENV,
        TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
        CLAUDE_CODE_OAUTH_TOKEN: "selected-subscription-token",
        ANTHROPIC_API_KEY: "inactive-api-key",
        TILLER_ENV_CAPTURE_FILE: captureFile,
        NODE_ENV: "test",
        UNRELATED_REVIEWER_FLAG: "preserved",
      },
    });
    assert.equal(await exited, 0);
    assert.equal(received.results[0]?.status, "succeeded");
    assertSanitizedClaudeEnvironment(
      JSON.parse(readFileSync(captureFile, "utf-8")),
      "subscription",
      "selected-subscription-token",
    );
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("environment reviewer sanitizes Claude environment at its final spawn boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-review-e2e-"));
  const binDir = writeFakeCli(root, FAKE_CLI_CAPTURE);
  const captureFile = join(root, "env-review-claude-env.json");
  const workspaceTar = createWorkspaceTar(root);
  const inspectionTar = createInspectionTar(root);
  const { server, received, port } = await startEnvReviewHubStub({
    context: buildEnvReviewContext(),
    workspaceTar,
    inspectionTar,
  });
  try {
    const { exited, stderrText } = runEnvReviewMain({
      root,
      port,
      binDir,
      extraEnv: {
        ...DIRTY_CLAUDE_ENV,
        TILLER_CLAUDE_AUTH_RESOLVED_MODE: "api",
        ANTHROPIC_API_KEY: "selected-api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "inactive-subscription-token",
        TILLER_ENV_CAPTURE_FILE: captureFile,
        NODE_ENV: "test",
        UNRELATED_REVIEWER_FLAG: "preserved",
      },
    });
    assert.equal(await exited, 0, stderrText());
    assert.equal(received.badTokenRequests, 0);
    assert.equal(received.results[0]?.status, "succeeded");
    assert.equal(
      readFileSync(join(root, "job", "checkout", ".tiller", "review-context", "before", "README.md"), "utf-8"),
      "immutable review workspace before\n",
    );
    assertSanitizedClaudeEnvironment(
      JSON.parse(readFileSync(captureFile, "utf-8")),
      "api",
      "selected-api-key",
    );
  } finally {
    server.close();
    try {
      execFileSync("chmod", ["-R", "u+w", root]);
    } catch {}
    cleanupRoot(root);
  }
});

test("environment reviewer rejects prose produced without successful workspace inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-review-e2e-"));
  const binDir = writeFakeCli(root, FAKE_CLI_NO_INSPECTION);
  const workspaceTar = createWorkspaceTar(root);
  const inspectionTar = createInspectionTar(root);
  const { server, received, port } = await startEnvReviewHubStub({
    context: buildEnvReviewContext(),
    workspaceTar,
    inspectionTar,
  });
  try {
    const { exited, stderrText } = runEnvReviewMain({ root, port, binDir });
    assert.equal(await exited, 1, stderrText());
    assert.equal(received.results.length, 1);
    assert.equal(received.results[0].status, "failed");
    assert.match(received.results[0].error, /without successfully inspecting the repository checkout/);
  } finally {
    server.close();
    try {
      execFileSync("chmod", ["-R", "u+w", root]);
    } catch {}
    cleanupRoot(root);
  }
});

test("environment review Overview accepts synthesis without workspace inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-review-overview-e2e-"));
  const binDir = writeFakeCli(root, FAKE_CLI_NO_INSPECTION);
  const workspaceTar = createWorkspaceTar(root);
  const inspectionTar = createInspectionTar(root);
  const { server, received, port } = await startEnvReviewHubStub({
    context: buildEnvReviewContext({
      roleLabel: "Code Review Overview",
      requiresRepositoryInspection: false,
    }),
    workspaceTar,
    inspectionTar,
  });
  try {
    const { exited, stderrText } = runEnvReviewMain({ root, port, binDir });
    assert.equal(await exited, 0, stderrText());
    assert.deepEqual(received.results, [{
      status: "succeeded",
      text: "Unverified reviewer prose.",
    }]);
  } finally {
    server.close();
    try {
      execFileSync("chmod", ["-R", "u+w", root]);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("planner main reports tool activity and user-facing assistant commentary", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_FALLBACK);
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "running",
    activityResponseDelayMs: 50,
  });
  try {
    const { exited } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 0);
    assert.deepEqual(received.events, [
      { type: "runtime_startup" },
      { type: "model_activity", message: "Thinking" },
      { type: "model_commentary", message: "I’m tracing the reviewer path." },
      { type: "model_activity", message: "Read: README.md" },
    ]);
    assert.deepEqual(received.results, [{ status: "succeeded", text: "Final fallback review." }]);
    assert.ok(JSON.stringify(received).includes("I’m tracing the reviewer path."));
    assert.deepEqual(received.order, ["activity-response", "activity-response", "result-request"]);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("planner main kills the CLI and posts no result when the run is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_HANG);
  let cancelled = false;
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => (cancelled ? "cancelled" : "running"),
  });
  try {
    const { exited } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    setTimeout(() => {
      cancelled = true;
    }, 300);
    const startedAt = Date.now();
    const exitCode = await exited;
    assert.equal(exitCode, 0);
    assert.ok(Date.now() - startedAt < 15000, "should exit well before the fake CLI's 30s sleep");
    assert.equal(received.results.length, 0);
    assert.deepEqual(received.events, [
      { type: "runtime_startup" },
      { type: "model_activity", message: "Thinking" },
    ]);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test("planner main posts a failed result when the CLI exits non-zero", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const { repoUrl, commit } = createRepo(root);
  const binDir = writeFakeCli(root, FAKE_CLI_FAIL);
  const { server, received, port } = await startHubStub({
    context: buildContext(commit),
    runStatusFn: () => "running",
  });
  try {
    const { exited } = runPlannerMain({ root, port, binDir, repoUrl, baseCommitSha: commit });
    assert.equal(await exited, 1);
    assert.equal(received.results.length, 1);
    assert.equal(received.results[0].status, "failed");
    assert.match(received.results[0].error, /exited with code 3/);
    assert.match(received.results[0].error, /synthetic provider explosion/);
    assert.deepEqual(received.events, [
      { type: "runtime_startup" },
      { type: "model_activity", message: "Thinking" },
    ]);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});
