#!/usr/bin/env node
import { hostname } from "node:os";
import { join, relative, resolve, basename } from "node:path";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { Agent } from "./agent.js";
import { AgentPromptDeliveryRegistry } from "./agent-prompt-delivery.js";
import { HubClient } from "./hub-client.js";
import {
  installHarnessHooks,
  ensureClaudeAutonomousSettings,
  ensureClaudeSettings,
  CLAUDE_SETTINGS_PATH,
} from "./hooks.js";
import {
  reportBootProgress,
  reportRunnerReady,
  createRuntimeSession,
} from "./hub-api.js";
import {
  buildHarnessSpawnArgs,
  buildInteractiveStartupPlanPrompt,
  buildStartupPlanDocument,
  resolveClaudeModelEffortArgs,
  resolveDebugCliArgs,
  resolveResumeArgs,
  resolveRunnerReadyStrategy,
  resolveStartupPlanCliArgs,
} from "./launch-config.js";
import { HarnessInputWriter } from "./input.js";
import { WorkspaceSaveCoordinator } from "./workspace-save.js";
import { TerminalResizeHandoff } from "./terminal-resize-handoff.js";
import { getHarnessLabel, resolveHarness } from "./harness.js";
import {
  HUB_URL,
  NAMESPACE,
  MACHINE_ID,
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
  cfTransportHeaders,
  environmentRuntimeHeaders,
  ensureAuth,
} from "./config.js";
import {
  classifyHarnessExit,
  evaluateHarnessRespawnBudget,
  shouldKeepHarnessAlive,
} from "./harness-supervisor.js";
import { reportRunnerReadyWithRetry } from "./runner-ready.js";
import {
  applyManagedOpenCodeMcpConfig,
  buildCodexMcpConfigOverrides,
  readManagedMcpServersFromEnv,
  writeOpenCodeConfigContent,
  type ManagedMcpServer,
} from "./mcp-config.js";
import {
  CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG,
  buildCodexModelOverrides,
  ensureCodexProjectTrust,
  removeCodexActivityHooks,
  resolveCodexModelSettings,
} from "./codex-config.js";
import {
  buildScheduledRunReplacementPrompt,
  reportScheduledRunIdleWithRetry,
  shouldArmScheduledRunIdleTimer,
} from "./scheduled-run.js";
import {
  DEFAULT_HARNESS_CONTROL_SOCKET_PATH,
  InteractiveActivityController,
} from "./activity-controller.js";
import { ImplementorAttentionReporter } from "./implementor-attention-reporter.js";
import { ensureStartupPlanGitExcludes } from "./startup-plan-git-excludes.js";
import { writeHarnessDiagnostic } from "./runtime-diagnostics.js";

// Parse args: tiller-harness [session-tag] [--resume] [--bare] [--cwd path]
const args = process.argv.slice(2);
ensureAuth();
function resolveConfiguredHarness() {
  try {
    return resolveHarness(process.env.TILLER_HARNESS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tiller] ${message}`);
    process.exit(1);
  }
}

const harness = resolveConfiguredHarness();
const harnessLabel = getHarnessLabel(harness);
const RUNNER_READY_MARKER_PATH =
  process.env.TILLER_RUNNER_READY_MARKER_PATH || "";
const runnerReadyStrategy = resolveRunnerReadyStrategy(harness);
const startCause = process.env.TILLER_START_CAUSE?.trim() || "ordinary";
const scheduledRunIdleMs = Math.max(
  1,
  Number(process.env.TILLER_SCHEDULED_RUN_IDLE_MS) || 30 * 60_000,
);
const scheduledRunLifecycleOpId =
  process.env.TILLER_LIFECYCLE_START_OP_ID?.trim() || "";
const scheduledRunRepoSlug = process.env.REPO_SLUG?.trim() || "";
// Keep the full quiescence fallback below stop-control's 35-second harness request timeout.
const MANUAL_STOP_GRACEFUL_TIMEOUT_MS = 25_000;
const MANUAL_STOP_TERMINATION_TIMEOUT_MS = 5_000;

let cwd = process.cwd();
let explicitTag: string | undefined;
const harnessArgs: string[] = [];
let resumeRequested = false;
let useBare = false;
let skipPermissions = false;
let planFile: string | undefined;
let runtimePlanFile: string | undefined;
let startupPlanPrompt: string | undefined;
let initialStartupPlanCliArgs: string[] = [];
let fixedStartupPlanText: string | undefined;
let launchCommand = "claude";
let harnessEnv: Record<string, string> | undefined;
let teamName: string | undefined;
let roleName: string | undefined;
let sessionTagOverride: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--cwd" && args[i + 1]) {
    cwd = resolve(args[++i]);
  } else if (args[i] === "--resume") {
    resumeRequested = true;
  } else if (args[i] === "--bare") {
    useBare = true;
  } else if (args[i] === "--skip-permissions") {
    skipPermissions = true;
  } else if (args[i] === "--plan-file" && args[i + 1]) {
    planFile = resolve(args[++i]);
  } else if (args[i] === "--team" && args[i + 1]) {
    teamName = args[++i];
  } else if (args[i] === "--role" && args[i + 1]) {
    roleName = args[++i];
  } else if (args[i] === "--session-tag" && args[i + 1]) {
    sessionTagOverride = args[++i];
  } else if (!args[i].startsWith("--")) {
    explicitTag = args[i];
  }
}

const defaultTag = `${basename(cwd)}@${hostname()}`;
const sessionTag = sessionTagOverride ?? explicitTag ?? NAMESPACE ?? defaultTag;

interface EnvReviewSnapshotRequest {
  sessionId: string;
  opId: string;
  envSlug: string;
  uploadUrl: string;
  uploadToken: string;
  snapshotMode: "github-overlay" | "full";
  maxBytes: number;
  excludePrefixes: string[];
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function matchesSnapshotExclude(
  path: string,
  prefixes: readonly string[],
): boolean {
  const normalized = normalizeWorkspacePath(path);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeWorkspacePath(prefix).replace(/\/+$/, "");
    return (
      normalized === normalizedPrefix ||
      normalized.startsWith(`${normalizedPrefix}/`)
    );
  });
}

function splitNulList(value: string): string[] {
  return value
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean);
}

function gitPathToWorkspacePath(path: string): string {
  return normalizeWorkspacePath(path.replace(/^\/+/, ""));
}

function readGitPathList(workspaceDir: string, args: string[]): string[] {
  return splitNulList(
    execFileSync("git", args, {
      cwd: workspaceDir,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    }),
  );
}

function assertGitCommitExists(workspaceDir: string, commitSha: string): void {
  execFileSync("git", ["cat-file", "-e", `${commitSha}^{commit}`], {
    cwd: workspaceDir,
    stdio: "ignore",
  });
}

function readGitSnapshotChangeSet(
  workspaceDir: string,
  baseCommitSha: string,
  excludePrefixes: readonly string[],
): {
  changed: string[];
  deleted: string[];
} {
  assertGitCommitExists(workspaceDir, baseCommitSha);
  const changed = new Set(
    [
      ...readGitPathList(workspaceDir, [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=ACMRT",
        baseCommitSha,
        "--",
        ".",
      ]),
      ...readGitPathList(workspaceDir, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ]),
    ].map(gitPathToWorkspacePath),
  );
  const deleted = new Set(
    readGitPathList(workspaceDir, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=D",
      baseCommitSha,
      "--",
      ".",
    ]).map(gitPathToWorkspacePath),
  );
  return {
    changed: Array.from(changed)
      .filter(
        (path) =>
          !deleted.has(path) && !matchesSnapshotExclude(path, excludePrefixes),
      )
      .sort((left, right) => left.localeCompare(right)),
    deleted: Array.from(deleted)
      .filter((path) => !matchesSnapshotExclude(path, excludePrefixes))
      .sort((left, right) => left.localeCompare(right)),
  };
}

function walkSnapshotFiles(
  workspaceDir: string,
  excludePrefixes: readonly string[],
  dir = workspaceDir,
): string[] {
  const paths: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const workspacePath = normalizeWorkspacePath(
      relative(workspaceDir, fullPath),
    );
    if (matchesSnapshotExclude(workspacePath, excludePrefixes)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Review snapshots do not support symbolic links: ${workspacePath}`,
      );
    }
    if (entry.isDirectory()) {
      paths.push(...walkSnapshotFiles(workspaceDir, excludePrefixes, fullPath));
    } else if (entry.isFile()) {
      paths.push(workspacePath);
    } else {
      throw new Error(
        `Review snapshots can only include regular files: ${workspacePath}`,
      );
    }
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function readSnapshotFile(
  workspaceDir: string,
  workspacePath: string,
): Uint8Array {
  const relativePath = normalizeWorkspacePath(workspacePath).slice(1);
  const fullPath = join(workspaceDir, relativePath);
  const stat = lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Review snapshots do not support symbolic links: ${workspacePath}`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(
      `Review snapshots can only include regular files: ${workspacePath}`,
    );
  }
  return new Uint8Array(readFileSync(fullPath));
}

function tarHeaderPath(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const encoder = new TextEncoder();
  const relativePath = normalizeWorkspacePath(path).slice(1);
  const direct = encoder.encode(relativePath);
  if (direct.length <= 100) {
    return { name: direct, prefix: new Uint8Array() };
  }
  const parts = relativePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    const prefixBytes = encoder.encode(prefix);
    const nameBytes = encoder.encode(name);
    if (prefixBytes.length <= 155 && nameBytes.length <= 100) {
      return { name: nameBytes, prefix: prefixBytes };
    }
  }
  throw new Error(`Path is too long for ustar snapshot: ${path}`);
}

async function buildSnapshotTar(
  entries: Array<{ path: string; content: Uint8Array }>,
  maxBytes: number,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalBytes = 1024;
  for (const entry of entries.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const header = new Uint8Array(512);
    const pathParts = tarHeaderPath(entry.path);
    header.set(pathParts.name, 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(
      encoder.encode(entry.content.length.toString(8).padStart(11, "0") + "\0"),
      124,
    );
    header.set(
      encoder.encode(
        Math.floor(Date.now() / 1000)
          .toString(8)
          .padStart(11, "0") + "\0",
      ),
      136,
    );
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    if (pathParts.prefix.length > 0) header.set(pathParts.prefix, 345);
    header.set(encoder.encode("        "), 148);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index];
    header.set(
      encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "),
      148,
    );

    const padding =
      entry.content.length % 512 === 0 ? 0 : 512 - (entry.content.length % 512);
    totalBytes += 512 + entry.content.length + padding;
    if (totalBytes > maxBytes) {
      throw new Error(`Review snapshot exceeds ${maxBytes} bytes`);
    }
    chunks.push(header, entry.content);
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const totalLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function uploadEnvReviewSnapshot(
  request: EnvReviewSnapshotRequest,
  workspaceDir: string,
): Promise<void> {
  const excludePrefixes = Array.isArray(request.excludePrefixes)
    ? request.excludePrefixes
    : [];
  const baseCommitSha = process.env.TILLER_GITHUB_BASE_COMMIT_SHA?.trim() ?? "";
  if (request.snapshotMode === "github-overlay" && !baseCommitSha) {
    throw new Error(
      "GitHub overlay review snapshot requires TILLER_GITHUB_BASE_COMMIT_SHA.",
    );
  }
  const gitChangeSet =
    request.snapshotMode === "github-overlay"
      ? readGitSnapshotChangeSet(workspaceDir, baseCommitSha, excludePrefixes)
      : null;
  const paths = gitChangeSet
    ? gitChangeSet.changed
    : walkSnapshotFiles(workspaceDir, excludePrefixes);
  const deleted = gitChangeSet?.deleted ?? [];
  const entries = paths.map((path) => ({
    path,
    content: readSnapshotFile(workspaceDir, path),
  }));
  const workspace = await buildSnapshotTar(entries, request.maxBytes);
  const metadata = {
    snapshotMode: request.snapshotMode,
    baseCommitSha:
      request.snapshotMode === "github-overlay" ? baseCommitSha : null,
    githubDeletedPaths: deleted,
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  const workspaceBody = workspace.buffer.slice(
    workspace.byteOffset,
    workspace.byteOffset + workspace.byteLength,
  ) as ArrayBuffer;
  form.set(
    "workspace",
    new Blob([workspaceBody], { type: "application/x-tar" }),
    "workspace.tar",
  );
  const response = await fetch(request.uploadUrl, {
    method: "PUT",
    headers: {
      ...cfTransportHeaders,
      "X-Tiller-Env-Review-Upload-Token": request.uploadToken,
    },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Snapshot upload failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const activityController = new InteractiveActivityController({
    socketPath:
      process.env.TILLER_HARNESS_CONTROL_SOCKET ||
      DEFAULT_HARNESS_CONTROL_SOCKET_PATH,
    diagnosticSink: writeHarnessDiagnostic,
  });
  const implementorAttentionReporter =
    scheduledRunLifecycleOpId && scheduledRunRepoSlug
      ? new ImplementorAttentionReporter({
          repoSlug: scheduledRunRepoSlug,
          lifecycleOpId: scheduledRunLifecycleOpId,
          onLog: (message) => console.error(`[tiller] ${message}`),
        })
      : null;
  let activityControlListening = false;
  try {
    await activityController.start();
    activityControlListening = true;
    process.env.TILLER_HARNESS_CONTROL_SOCKET = activityController.socketPath;
    console.error(
      `[tiller] Activity control listening at ${activityController.socketPath}`,
    );
  } catch (error) {
    // Provider completion signals cannot be trusted without the private
    // socket. Keep the local state working so automatic stop fails closed.
    console.error(
      `[tiller] Activity control unavailable; automatic idle stop disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
    delete process.env.TILLER_HARNESS_CONTROL_SOCKET;
  }

  const installedHooks = installHarnessHooks();
  process.env.TILLER_ACTIVITY_HOOK_PATH = installedHooks.activityHookPath;
  let mcpServers: ManagedMcpServer[] = [];
  async function failMcpConfig(error: unknown): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tiller] MCP config failed: ${message}`);
    await reportBootProgress(`harness: MCP config FAILED — ${message}`, {
      stepId: "prereq-check",
      severity: "error",
    });
    process.exit(1);
  }

  try {
    mcpServers = readManagedMcpServersFromEnv();
  } catch (error) {
    await failMcpConfig(error);
  }

  if (harness === "claude-code") {
    ensureCommandAvailable("claude");
    try {
      ensureClaudeAutonomousSettings(cwd, mcpServers);
    } catch (error) {
      await failMcpConfig(error);
    }
    harnessArgs.push(...resolveResumeArgs(harness, resumeRequested));
    harnessArgs.push(...resolveClaudeModelEffortArgs());

    // --bare: use ANTHROPIC_API_KEY directly, skip OAuth/keychain.
    // Activity hooks remain enabled in every mode; the approval hook only
    // remains enabled when permissions are not explicitly skipped.
    const usePermissionHook = !skipPermissions;
    ensureClaudeSettings(
      usePermissionHook ? installedHooks.permissionHookPath : null,
      installedHooks.activityHookPath,
    );
    harnessArgs.push("--settings", CLAUDE_SETTINGS_PATH);
    if (useBare && skipPermissions) {
      harnessArgs.push("--bare", "--dangerously-skip-permissions");
      console.error(
        "[tiller] Bare + skip-permissions: API key auth, fully autonomous",
      );
    } else if (useBare) {
      harnessArgs.push("--bare", "--dangerously-skip-permissions");
      console.error(
        "[tiller] Bare mode: using ANTHROPIC_API_KEY, skip permissions, hooks via --settings",
      );
    } else if (skipPermissions) {
      harnessArgs.push("--dangerously-skip-permissions");
      console.error("[tiller] Skip permissions mode: fully autonomous");
    } else {
      console.error("[tiller] Normal mode: permissions routed via hooks");
    }
  } else if (harness === "codex") {
    ensureCommandAvailable("codex");
    const subscriptionAppServer =
      process.env.TILLER_CODEX_RUNTIME_MODE === "app-server" &&
      process.env.TILLER_CODEX_AUTH_MODE === "subscription";

    if (
      subscriptionAppServer &&
      (!process.env.TILLER_CODEX_RUNTIME_AUTH_URL?.trim() ||
        !process.env.TILLER_RUNTIME_CAPABILITY?.trim())
    ) {
      console.error(
        "[tiller] Codex subscription runtime configuration is incomplete",
      );
      await reportBootProgress(
        "harness: Codex setup FAILED — subscription runtime configuration is incomplete",
        {
          stepId: "prereq-check",
          severity: "error",
        },
      );
      process.exit(1);
    }
    if (!subscriptionAppServer && !process.env.OPENAI_API_KEY) {
      console.error(
        "[tiller] Codex requires OPENAI_API_KEY for direct API execution",
      );
      await reportBootProgress(
        "harness: Codex setup FAILED — no API key is available",
        {
          stepId: "prereq-check",
          severity: "error",
        },
      );
      process.exit(1);
    }
    // Both authentication modes use the app-server lifecycle so completion is
    // based on authoritative, thread-scoped turn notifications.
    launchCommand = "tiller-codex-app-server-runtime";
    removeCodexActivityHooks();
    harnessArgs.push(...resolveResumeArgs(harness, resumeRequested));
    harnessArgs.push(CODEX_BYPASS_APPROVALS_AND_SANDBOX_ARG);
    try {
      ensureCodexProjectTrust(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tiller] Codex config failed: ${message}`);
      await reportBootProgress(`harness: Codex config FAILED — ${message}`, {
        stepId: "prereq-check",
        severity: "error",
      });
      process.exit(1);
    }
    let selectedCodexSettings: ReturnType<typeof resolveCodexModelSettings>;
    try {
      selectedCodexSettings = resolveCodexModelSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tiller] Codex model settings failed: ${message}`);
      await reportBootProgress(`harness: Codex setup FAILED — ${message}`, {
        stepId: "prereq-check",
        severity: "error",
      });
      process.exit(1);
    }
    for (const override of buildCodexModelOverrides(selectedCodexSettings)) {
      harnessArgs.push("-c", override);
    }
    if (subscriptionAppServer) {
      console.error("[tiller] Codex auth: subscription app-server");
    } else if (process.env.OPENAI_API_KEY) {
      console.error("[tiller] Codex auth: OPENAI_API_KEY");
    }
    if (useBare) {
      console.error("[tiller] Ignoring --bare for Codex");
    }
    if (skipPermissions) {
      console.error("[tiller] Codex: bypass approvals + sandbox");
    }
    try {
      for (const override of buildCodexMcpConfigOverrides(mcpServers)) {
        harnessArgs.push("-c", override);
      }
    } catch (error) {
      await failMcpConfig(error);
    }
  } else {
    ensureCommandAvailable("opencode");
    launchCommand = "opencode";
    console.error(
      `[tiller] Installed OpenCode activity plugin → ${installedHooks.openCodeActivityPluginPath}`,
    );
    harnessArgs.push(...resolveResumeArgs(harness, resumeRequested));
    harnessArgs.push(...resolveDebugCliArgs(harness));
    try {
      const baseOpenCodeConfigContent =
        process.env.OPENCODE_CONFIG_CONTENT || "";
      if (baseOpenCodeConfigContent || mcpServers.length > 0) {
        const content = applyManagedOpenCodeMcpConfig(
          baseOpenCodeConfigContent || "{}",
          mcpServers,
        );
        process.env.OPENCODE_CONFIG_CONTENT = content;
        if (baseOpenCodeConfigContent) {
          writeOpenCodeConfigContent(content);
        }
      }
    } catch (error) {
      await failMcpConfig(error);
    }
    if (useBare) {
      console.error("[tiller] Ignoring --bare for OpenCode");
    }
    if (skipPermissions) {
      console.error("[tiller] Ignoring --skip-permissions for OpenCode");
    }
  }

  // If a plan file is provided, preload it for the selected harness so the
  // initial turn can begin as part of process startup.
  if (planFile) {
    if (existsSync(planFile)) {
      const stat = statSync(planFile);
      if (stat.size > 0) {
        const gitExcludeResult = ensureStartupPlanGitExcludes(cwd, planFile);
        if (gitExcludeResult.status === "failed") {
          console.error(
            `[tiller] Failed to add startup plan Git exclusions: ${gitExcludeResult.error}`,
          );
        }
        rmSync(planFile + ".executed", { force: true });
        if (harness === "claude-code") {
          const planText = readFileSync(planFile, "utf-8");
          fixedStartupPlanText = planText.trim();
          runtimePlanFile = `${planFile}.runtime`;
          writeFileSync(runtimePlanFile, buildStartupPlanDocument(planText));
          renameSync(planFile, planFile + ".executed");
          harnessArgs.push("--append-system-prompt-file", runtimePlanFile);
          startupPlanPrompt =
            "Execute the plan described in your system prompt. Begin immediately.";
          initialStartupPlanCliArgs = resolveStartupPlanCliArgs(
            harness,
            startupPlanPrompt,
          );
          console.error(
            `[tiller] Plan file loaded for Claude: ${planFile} (${stat.size} bytes), runtime copy: ${runtimePlanFile}`,
          );
        } else {
          const planText = readFileSync(planFile, "utf-8").trim();
          fixedStartupPlanText = planText;
          const executedPlanFile = `${planFile}.executed`;
          renameSync(planFile, executedPlanFile);
          startupPlanPrompt = buildInteractiveStartupPlanPrompt(planText);
          const startupPlanCliArgs = resolveStartupPlanCliArgs(
            harness,
            startupPlanPrompt,
          );
          if (startupPlanCliArgs.length > 0) {
            initialStartupPlanCliArgs = startupPlanCliArgs;
          }
          console.error(
            `[tiller] Plan file loaded for ${harnessLabel}: ${planFile} (${stat.size} bytes)`,
          );
        }
      } else {
        console.error(`[tiller] Plan file empty, starting interactive mode`);
      }
    } else {
      console.error(
        `[tiller] Plan file not found: ${planFile}, starting interactive mode`,
      );
    }
  }

  console.error(
    `[tiller] Connecting to ${HUB_URL} as ${NAMESPACE}/${MACHINE_ID}`,
  );
  console.error(`[tiller] Session tag: ${sessionTag}, cwd: ${cwd}`);
  if (teamName)
    console.error(`[tiller] Team: ${teamName}, role: ${roleName ?? "unset"}`);
  await reportBootProgress("harness: Creating session...", {
    stepId: "hub-connect",
  });

  // 1. Create/get session (CF Access service token authenticates at the edge)
  let session: { id: string; tag: string };
  try {
    session = await createRuntimeSession({
      tag: sessionTag,
      cwd,
      host: hostname(),
      platform: process.platform,
      ...(teamName ? { team: teamName } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tiller] Session creation failed: ${msg}`);
    await reportBootProgress(`harness: Session creation FAILED — ${msg}`, {
      stepId: "hub-connect",
      severity: "error",
    });
    process.exit(1);
  }
  console.error(`[tiller] Session: ${session.id} (tag: ${session.tag})`);
  await reportBootProgress("harness: Session created", {
    stepId: "hub-connect",
  });

  // 3. Spawn Claude agent (with hook env vars)
  const hookEnv: Record<string, string> = {
    TILLER_SESSION_ID: session.id,
    TILLER_ENV_SLUG: process.env.REPO_SLUG ?? "",
    TILLER_HUB_URL: HUB_URL,
    TILLER_CF_CLIENT_ID: CF_ACCESS_CLIENT_ID,
    TILLER_CF_CLIENT_SECRET: CF_ACCESS_CLIENT_SECRET,
    TILLER_RUNTIME_CAPABILITY:
      process.env.TILLER_RUNTIME_CAPABILITY ?? "",
  };
  harnessEnv = harness === "claude-code" ? hookEnv : undefined;
  let agent: Agent | null = null;
  const terminalResizeHandoff = new TerminalResizeHandoff<Agent>();
  const inputWriter = new HarnessInputWriter(
    harness,
    () => agent,
    activityController,
  );
  const workspaceSaves = new WorkspaceSaveCoordinator({
    onLog: (message) => console.error(`[tiller] ${message}`),
  });
  let shuttingDown = false;
  let manualStopQuiescing = false;
  let respawnCount = 0;
  let lastRespawnAtMs = 0;
  const keepHarnessAlive = shouldKeepHarnessAlive({
    isInteractive: Boolean(process.stdin.isTTY),
    hubUrl: HUB_URL,
    repoSlug: process.env.REPO_SLUG,
  });

  // 4. Connect WebSocket
  await reportBootProgress("harness: Connecting WebSocket...", {
    stepId: "hub-connect",
  });
  const hub = new HubClient({
    hubUrl: HUB_URL,
    namespace: NAMESPACE,
    cfAccessHeaders: environmentRuntimeHeaders,
    wsScope: {
      kind: "environment",
      envSlug: process.env.REPO_SLUG!,
      sessionId: session.id,
    },
  });

  hub.setSessionId(session.id);
  let hubConnected = false;
  let runnerReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let scheduledRunIdleTimer: ReturnType<typeof setTimeout> | null = null;
  const activeReviewSnapshots = new Map<string, Promise<void>>();
  const completedReviewSnapshots = new Set<string>();
  const terminalInputDeliveries = new Map<string, {
    data: string;
    result: { ok: boolean; error?: string } | null;
    waiters: Array<{ sessionId: string; clientId: string; inputSeq: number }>;
  }>();

  hub.on("connected", () => {
    hubConnected = true;
    console.error("[tiller] Hub WebSocket connected");
    hub.sendSessionAlive(session.id);
    reportBootProgress("harness: WebSocket connected", {
      stepId: "hub-connect",
    });
    if (runnerReadyStrategy === "spawned") {
      maybeReportRunnerReady(agent);
    } else if (agent && runnerReadyOutputSeen.has(agent)) {
      maybeReportRunnerReady(agent, { delayMs: 0 });
    }
  });

  hub.on("disconnected", () => {
    hubConnected = false;
    if (runnerReadyTimer) {
      clearTimeout(runnerReadyTimer);
      runnerReadyTimer = null;
    }
  });

  hub.on("error", (err) => {
    console.error(`[tiller] Hub error: ${err.message}`);
    reportBootProgress(`harness: Hub error — ${err.message}`, {
      stepId: "hub-connect",
      severity: "warn",
    });
  });

  // Filter incoming messages: write user-input to PTY, handle abort
  type InboundContent =
    | { type: "user-input"; role: "user"; data: string }
    | { type: "abort" }
    | { type: "resize"; data: string }
    | { type: "sync" };

  hub.on("message-received", (msg) => {
    const content = msg.content as InboundContent | undefined;
    if (!content || !agent) return;

    switch (content.type) {
      case "user-input": {
        if (!content.data) break;
        inputWriter.enqueue(content.data);
        break;
      }
      case "abort":
        inputWriter.abort();
        break;
      case "resize":
        try {
          const size = JSON.parse(content.data);
          if (typeof size.cols === "number" && typeof size.rows === "number") {
            void agent.resize(size.cols, size.rows).catch(() => undefined);
          }
        } catch {
          /* ignore malformed resize */
        }
        break;
      case "sync":
        void workspaceSaves.requestSave("explicit").catch((err) => {
          console.error(
            `[tiller] Workspace save failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        break;
    }
  });

  hub.on("terminal-input", (msg) => {
    if (!agent) {
      hub.sendTerminalInputAck(
        msg.sessionId,
        msg.clientId,
        msg.inputSeq,
        false,
        "No active PTY",
      );
      return;
    }
    if (
      msg.applyDimensions === true &&
      (!Number.isInteger(msg.cols) ||
        !Number.isInteger(msg.rows) ||
        msg.cols! < 1 ||
        msg.cols! > 1000 ||
        msg.rows! < 1 ||
        msg.rows! > 1000)
    ) {
      hub.sendTerminalInputAck(
        msg.sessionId,
        msg.clientId,
        msg.inputSeq,
        false,
        "Invalid input dimensions",
      );
      return;
    }
    if (msg.deliveryId) {
      const existing = terminalInputDeliveries.get(msg.deliveryId);
      if (existing) {
        if (existing.data !== msg.data) {
          hub.sendTerminalInputAck(
            msg.sessionId,
            msg.clientId,
            msg.inputSeq,
            false,
            "Terminal delivery ID was reused with different input",
          );
          return;
        }
        if (existing.result) {
          hub.sendTerminalInputAck(
            msg.sessionId,
            msg.clientId,
            msg.inputSeq,
            existing.result.ok,
            existing.result.error,
          );
        } else {
          existing.waiters.push({
            sessionId: msg.sessionId,
            clientId: msg.clientId,
            inputSeq: msg.inputSeq,
          });
        }
        return;
      }
      terminalInputDeliveries.set(msg.deliveryId, {
        data: msg.data,
        result: null,
        waiters: [{
          sessionId: msg.sessionId,
          clientId: msg.clientId,
          inputSeq: msg.inputSeq,
        }],
      });
    }
    inputWriter.enqueue(msg.data, {
      ...(msg.applyDimensions === true
        ? { dimensions: { cols: msg.cols!, rows: msg.rows! } }
        : {}),
      onComplete: (result) => {
        const normalizedResult = {
          ok: result.ok,
          ...(result.ok ? {} : { error: result.error }),
        };
        const delivery = msg.deliveryId
          ? terminalInputDeliveries.get(msg.deliveryId)
          : null;
        const waiters = delivery?.waiters ?? [{
          sessionId: msg.sessionId,
          clientId: msg.clientId,
          inputSeq: msg.inputSeq,
        }];
        if (delivery) {
          if (normalizedResult.ok) {
            delivery.result = normalizedResult;
            delivery.waiters = [];
          } else if (msg.deliveryId) {
            terminalInputDeliveries.delete(msg.deliveryId);
          }
        }
        for (const waiter of waiters) {
          hub.sendTerminalInputAck(
            waiter.sessionId,
            waiter.clientId,
            waiter.inputSeq,
            normalizedResult.ok,
            normalizedResult.error,
          );
        }
        if (terminalInputDeliveries.size > 512) {
          for (const [deliveryId, candidate] of terminalInputDeliveries) {
            if (candidate.result) terminalInputDeliveries.delete(deliveryId);
            if (terminalInputDeliveries.size <= 512) break;
          }
        }
      },
    });
  });

  hub.on("terminal-control", (msg) => {
    if (msg.action === "resize") {
      if (
        !Number.isInteger(msg.cols) ||
        !Number.isInteger(msg.rows) ||
        msg.cols! < 1 ||
        msg.cols! > 1000 ||
        msg.rows! < 1 ||
        msg.rows! > 1000
      ) {
        hub.sendTerminalControlAck(
          msg.sessionId,
          msg.clientId,
          msg.controlSeq,
          false,
          "Invalid resize dimensions",
        );
        return;
      }
      void terminalResizeHandoff.resize(msg.cols!, msg.rows!).then(
        () =>
          hub.sendTerminalControlAck(
            msg.sessionId,
            msg.clientId,
            msg.controlSeq,
            true,
          ),
        (err) =>
          hub.sendTerminalControlAck(
            msg.sessionId,
            msg.clientId,
            msg.controlSeq,
            false,
            err instanceof Error ? err.message : String(err),
          ),
      );
      return;
    }

    if (!agent) {
      hub.sendTerminalControlAck(
        msg.sessionId,
        msg.clientId,
        msg.controlSeq,
        false,
        "No active PTY",
      );
      return;
    }

    if (msg.action === "abort") {
      inputWriter.abort({
        onComplete: (result) => {
          hub.sendTerminalControlAck(
            msg.sessionId,
            msg.clientId,
            msg.controlSeq,
            result.ok,
            result.ok ? undefined : result.error,
          );
        },
      });
      return;
    }

    hub.sendTerminalControlAck(
      msg.sessionId,
      msg.clientId,
      msg.controlSeq,
      false,
      "Unsupported terminal control action",
    );
  });

  hub.on("env-review-snapshot-request", async (msg) => {
    console.error(`[tiller] Review snapshot requested: ${msg.opId}`);
    if (completedReviewSnapshots.has(msg.opId)) {
      console.error(`[tiller] Review snapshot already uploaded: ${msg.opId}`);
      return;
    }
    let pending = activeReviewSnapshots.get(msg.opId);
    if (!pending) {
      pending = uploadEnvReviewSnapshot(
        {
          sessionId: msg.sessionId,
          opId: msg.opId,
          envSlug: msg.envSlug,
          uploadUrl: msg.uploadUrl,
          uploadToken: msg.uploadToken,
          snapshotMode: msg.snapshotMode,
          maxBytes: msg.maxBytes,
          excludePrefixes: msg.excludePrefixes,
        },
        cwd,
      );
      activeReviewSnapshots.set(msg.opId, pending);
    }
    try {
      await pending;
      completedReviewSnapshots.add(msg.opId);
      while (completedReviewSnapshots.size > 50) {
        const oldest = completedReviewSnapshots.values().next().value;
        if (!oldest) break;
        completedReviewSnapshots.delete(oldest);
      }
      console.error(`[tiller] Review snapshot uploaded: ${msg.opId}`);
    } catch (error) {
      console.error(
        `[tiller] Review snapshot upload failed: ${msg.opId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      activeReviewSnapshots.delete(msg.opId);
    }
  });

  hub.connect();

  // Track the first PTY output for harnesses that only count as ready once the
  // terminal has actually rendered something.
  const runnerReadyOutputSeen = new WeakSet<Agent>();
  const promptDeliveries = new AgentPromptDeliveryRegistry<Agent>();
  const agentActivityGenerations = new WeakMap<Agent, string>();
  let spawnedAgentCount = 0;
  let agentStateVersion = 1; // Schema default is 1 (not 0)
  let runnerReadyReported = false;

  function invalidateScheduledRunIdleTimer(): void {
    if (scheduledRunIdleTimer) {
      clearTimeout(scheduledRunIdleTimer);
      scheduledRunIdleTimer = null;
    }
  }

  function armScheduledRunIdleTimer(candidate: Agent): void {
    if (
      !shouldArmScheduledRunIdleTimer(
        startCause,
        promptDeliveries.isDelivered(candidate),
      ) ||
      !scheduledRunLifecycleOpId ||
      !scheduledRunRepoSlug ||
      shuttingDown
    )
      return;
    if (scheduledRunIdleTimer) clearTimeout(scheduledRunIdleTimer);
    scheduledRunIdleTimer = setTimeout(() => {
      scheduledRunIdleTimer = null;
      console.error("[tiller] Scheduled Run idle; requesting interruption");
      void reportScheduledRunIdleWithRetry({
        repoSlug: scheduledRunRepoSlug,
        lifecycleOpId: scheduledRunLifecycleOpId,
        shouldAbort: () =>
          shuttingDown ||
          agent !== candidate ||
          !promptDeliveries.isDelivered(candidate),
        onLog: (message) => console.error(`[tiller] ${message}`),
      });
    }, scheduledRunIdleMs);
  }

  activityController.on("activity", (state) => {
    if (state.status === "working") {
      invalidateScheduledRunIdleTimer();
      return;
    }
    if (!manualStopQuiescing) {
      void workspaceSaves.requestSave("idle").catch((error) => {
        console.error(
          `[tiller] Idle workspace save failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (agent) armScheduledRunIdleTimer(agent);
  });

  activityController.on("completion", (sequence) => {
    void implementorAttentionReporter?.report(sequence);
  });

  activityController.setManualQuiesceHandler(async () => {
    manualStopQuiescing = true;
    await inputWriter.drain();
    const candidate = agent;
    if (!candidate || activityController.snapshot().status === "idle") return;
    await inputWriter.abortForStop();
    await activityController.quiesceForManualStop({
      gracefulTimeoutMs: MANUAL_STOP_GRACEFUL_TIMEOUT_MS,
      terminationTimeoutMs: MANUAL_STOP_TERMINATION_TIMEOUT_MS,
      terminate: () => {
        console.error(
          "[tiller] Active agent turn did not stop after Ctrl+C; terminating the agent process before saving the workspace",
        );
        candidate.kill("SIGKILL");
      },
    });
  });

  function maybeReportRunnerReady(
    candidate: Agent | null,
    options?: { delayMs?: number },
  ): void {
    if (
      !candidate ||
      candidate !== agent ||
      runnerReadyReported ||
      !hubConnected ||
      shuttingDown
    ) {
      return;
    }
    if (runnerReadyTimer) {
      clearTimeout(runnerReadyTimer);
    }
    // Treat runtime readiness as "session created, WS connected, child spawned,
    // and still alive after a short grace window" unless the harness requires
    // actual terminal output before it is considered usable.
    runnerReadyTimer = setTimeout(() => {
      void (async () => {
        if (
          runnerReadyReported ||
          !hubConnected ||
          agent !== candidate ||
          shuttingDown
        ) {
          return;
        }
        const reported = await reportRunnerReadyWithRetry(
          async () => {
            if (RUNNER_READY_MARKER_PATH) {
              try {
                writeFileSync(
                  RUNNER_READY_MARKER_PATH,
                  new Date().toISOString(),
                );
              } catch {
                // Best-effort local marker for the container entrypoint.
              }
            }
            await reportRunnerReady();
          },
          {
            reportBootProgress,
            onLog: (message) => console.error(`[tiller] ${message}`),
            shouldAbort: () =>
              runnerReadyReported ||
              !hubConnected ||
              agent !== candidate ||
              shuttingDown,
          },
        );
        if (
          reported &&
          !runnerReadyReported &&
          hubConnected &&
          agent === candidate &&
          !shuttingDown
        ) {
          runnerReadyReported = true;
        }
      })();
      runnerReadyTimer = null;
    }, options?.delayMs ?? 500);
  }

  // Helper to update session phase/activity agent state (Scion pattern)
  function updatePhaseActivity(phase: string, activity: string): void {
    hub.sendUpdateAgentState(
      session.id,
      { phase, activity },
      agentStateVersion,
    );
    agentStateVersion++;
  }

  // Initialize phase/activity in agent_state column (not metadata)
  updatePhaseActivity("starting", "idle");

  async function spawnHarnessAgent(
    preparedGeneration?: string,
  ): Promise<Agent> {
    console.error(`[tiller] Spawning ${launchCommand}`);
    const isReplacement = spawnedAgentCount > 0;
    const generation = preparedGeneration ?? crypto.randomUUID();
    if (!preparedGeneration) {
      await activityController.beginGeneration(generation);
    }
    const spawnArgs = buildHarnessSpawnArgs(
      harnessArgs,
      initialStartupPlanCliArgs,
      isReplacement,
    );
    const nextAgent = new Agent(launchCommand, spawnArgs, cwd, {
      ...(harnessEnv ?? {}),
      ...(activityControlListening
        ? {
            TILLER_HARNESS_CONTROL_SOCKET: activityController.socketPath,
            TILLER_ACTIVITY_GENERATION: generation,
            TILLER_ACTIVITY_HOOK_PATH: installedHooks.activityHookPath,
          }
        : {}),
    });
    agentActivityGenerations.set(nextAgent, generation);
    spawnedAgentCount += 1;
    const prompt =
      isReplacement && fixedStartupPlanText
        ? startCause === "scheduled"
          ? buildScheduledRunReplacementPrompt(fixedStartupPlanText)
          : buildInteractiveStartupPlanPrompt(fixedStartupPlanText)
        : startupPlanPrompt;
    if (!isReplacement && initialStartupPlanCliArgs.length > 0) {
      promptDeliveries.registerDelivered(nextAgent);
    } else {
      promptDeliveries.register(nextAgent, prompt);
    }
    return nextAgent;
  }

  async function handleHarnessExit(
    exitedAgent: Agent,
    code: number,
  ): Promise<void> {
    if (agent !== exitedAgent) {
      return;
    }
    terminalResizeHandoff.detach(exitedAgent);
    const generation = agentActivityGenerations.get(exitedAgent) ?? null;
    promptDeliveries.invalidate(exitedAgent);
    invalidateScheduledRunIdleTimer();
    const exitClassification = classifyHarnessExit(code);
    const willAttemptRespawn =
      !shuttingDown &&
      !manualStopQuiescing &&
      keepHarnessAlive &&
      exitClassification !== "terminal-auth";
    let finalExitGeneration = generation;
    if (willAttemptRespawn) {
      finalExitGeneration = crypto.randomUUID();
      await activityController.beginGeneration(finalExitGeneration);
    } else if (generation) {
      await activityController.reportProcessExit(generation);
    }
    if (shuttingDown) {
      return;
    }

    console.error(`[tiller] ${harnessLabel} exited with code ${code}`);
    await reportBootProgress(`${harnessLabel} exited (code ${code})`, {
      stepId: runnerReadyReported ? "runner-ready" : "harness-launch",
      severity: "warn",
    });

    if (exitClassification === "terminal-auth") {
      await reportBootProgress(
        "Codex subscription authentication stopped this runtime. Restart required.",
        { stepId: "harness-launch", severity: "error" },
      );
    }

    if (willAttemptRespawn) {
      const respawn = evaluateHarnessRespawnBudget({
        currentCount: respawnCount,
        lastRespawnAtMs,
      });

      if (respawn.allow) {
        respawnCount = respawn.nextCount;
        lastRespawnAtMs = respawn.nextRespawnAtMs;
        updatePhaseActivity("starting", "idle");
        await reportBootProgress(
          `${harnessLabel} exited (code ${code}), restarting session (${respawnCount}/${10})...`,
          { stepId: "harness-launch", severity: "warn" },
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
        try {
          agent = wireHarnessAgent(
            await spawnHarnessAgent(finalExitGeneration ?? undefined),
          );
          void terminalResizeHandoff.attach(agent).catch(() => undefined);
          if (runnerReadyStrategy === "spawned") {
            maybeReportRunnerReady(agent);
          }
          console.error(`[tiller] ${harnessLabel} PTY respawned`);
          await reportBootProgress(`${harnessLabel} is starting...`, {
            stepId: "harness-launch",
          });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[tiller] Failed to respawn ${harnessLabel}: ${message}`,
          );
          await reportBootProgress(
            `harness: ${harnessLabel} respawn FAILED — ${message}`,
            {
              stepId: "harness-launch",
              severity: "error",
            },
          );
        }
      } else {
        console.error(
          `[tiller] ${harnessLabel} exceeded respawn budget, shutting down`,
        );
        await reportBootProgress(
          `${harnessLabel} exited too many times; shutting down harness.`,
          {
            stepId: "harness-launch",
            severity: "error",
          },
        );
      }
    }

    if (willAttemptRespawn && finalExitGeneration) {
      await activityController.reportProcessExit(finalExitGeneration);
    }

    updatePhaseActivity("stopped", code === 0 ? "completed" : "idle");
    try {
      await cleanup();
    } catch (err) {
      console.error(
        `[tiller] Cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(code);
  }

  function wireHarnessAgent(nextAgent: Agent): Agent {
    let reportedRunning = false;

    nextAgent.on("output", () => {
      if (!reportedRunning) {
        reportedRunning = true;
        runnerReadyOutputSeen.add(nextAgent);
        if (respawnCount > 0) {
          respawnCount = 0;
        }
        reportBootProgress(`${harnessLabel} is running`, {
          stepId: "runner-ready",
        });
        updatePhaseActivity("running", "executing");
        if (runnerReadyStrategy === "first-output") {
          maybeReportRunnerReady(nextAgent, { delayMs: 0 });
        }
      }
      const pendingPrompt =
        agent === nextAgent ? promptDeliveries.schedule(nextAgent) : null;
      if (pendingPrompt) {
        console.error("[tiller] Sending startup plan prompt");
        reportBootProgress(`${harnessLabel} is applying startup plan...`, {
          stepId: "harness-launch",
        });
        setTimeout(() => {
          promptDeliveries.submitScheduled(
            nextAgent,
            (prompt, onComplete) =>
              inputWriter.enqueueSubmittedText(prompt, { onComplete }),
            () => agent === nextAgent,
            () => undefined,
          );
        }, 250);
      }
    });

    nextAgent.on("output", (data) => {
      const msgId = crypto.randomUUID();
      hub.sendMessage(msgId, session.id, {
        role: "assistant",
        type: "terminal-output",
        data,
      });
    });

    nextAgent.on("exit", (code) => {
      void handleHarnessExit(nextAgent, code);
    });

    return nextAgent;
  }

  // Now spawn the selected harness after WS is up so we don't miss early output.
  await reportBootProgress(`harness: Spawning ${harnessLabel}...`, {
    stepId: "harness-launch",
  });
  try {
    agent = wireHarnessAgent(await spawnHarnessAgent());
    void terminalResizeHandoff.attach(agent).catch(() => undefined);
    if (runnerReadyStrategy === "spawned") {
      maybeReportRunnerReady(agent);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tiller] Failed to spawn ${harnessLabel}: ${msg}`);
    await reportBootProgress(`harness: ${harnessLabel} spawn FAILED — ${msg}`, {
      stepId: "harness-launch",
      severity: "error",
    });
    process.exit(1);
  }
  console.error(`[tiller] ${harnessLabel} PTY spawned`);
  await reportBootProgress(`${harnessLabel} is starting...`, {
    stepId: "harness-launch",
  });

  // 5. Signal handling + local stdin → PTY
  let lastSigint = 0;
  let cleanupPromise: Promise<void> | null = null;

  // Connect local stdin to the harness PTY (raw mode so keystrokes go directly).
  // Only attach stdin when running interactively (TTY). In containers, stdin is
  // /dev/null and resume() blocks the event loop, preventing WebSocket from connecting.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }

  // Discard startup-buffered bytes.
  setImmediate(() => {
    process.stdin.on("data", (data: Buffer) => {
      if (!agent) return;
      const str = data.toString();

      // Detect double Ctrl+C (raw mode means we get \x03 directly)
      if (str === "\x03") {
        const now = Date.now();
        if (now - lastSigint < 1000) {
          console.error("\n[tiller] Double Ctrl+C — shutting down");
          cleanup()
            .catch((err) => {
              console.error(
                `[tiller] Cleanup error: ${err instanceof Error ? err.message : String(err)}`,
              );
            })
            .finally(() => process.exit(0));
          return;
        }
        lastSigint = now;
      }

      inputWriter.enqueue(str);
    });
  });

  process.on("SIGTERM", async () => {
    console.error("[tiller] SIGTERM — shutting down");
    shuttingDown = true;
    try {
      await cleanup();
    } catch (err) {
      console.error(
        `[tiller] Cleanup error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    process.exit(0);
  });

  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise;

    cleanupPromise = (async () => {
      shuttingDown = true;
      if (scheduledRunIdleTimer) {
        clearTimeout(scheduledRunIdleTimer);
        scheduledRunIdleTimer = null;
      }
      // Restore terminal
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      hub.sendSessionEnd(session.id);
      if (agent) agent.kill();

      // Wait for pending WebSocket sends to flush before closing
      const ws = hub.getSocket();
      if (ws && ws.readyState === WebSocket.OPEN) {
        const deadline = Date.now() + 2000;
        while (ws.bufferedAmount > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      hub.close();

      if (activityControlListening) {
        await activityController.stop().catch(() => undefined);
      }
      await implementorAttentionReporter?.shutdown();

      if (runtimePlanFile && existsSync(runtimePlanFile)) {
        rmSync(runtimePlanFile, { force: true });
      }
    })();

    return cleanupPromise;
  }
}

function ensureCommandAvailable(command: string): void {
  try {
    execSync(`which ${command}`, { stdio: "ignore" });
  } catch {
    throw new Error(`${command} binary not found in PATH`);
  }
}

main().catch(async (err) => {
  console.error(`[tiller] Fatal: ${err}`);
  await reportBootProgress(
    `harness: Fatal error — ${err instanceof Error ? err.message : String(err)}`,
    {
      stepId: "startup-failed",
      severity: "error",
    },
  );
  process.exit(1);
});
