#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { resolveHarness, type Harness } from "../harness.js";
import {
  PlannerHubCallback,
  type PlannerRunContext,
} from "./hub-callback.js";
import { EnvReviewHubCallback, type EnvReviewRunContext } from "./env-review-callback.js";
import { PlannerOutputTracker } from "./output-tracker.js";
import { superviseDirectChild } from "./direct-child-supervisor.js";
import {
  createCheckout,
  ensureGitHubWorkspaceRepo,
  extractTarBuffer,
  materializeGitHubArchiveBase,
} from "./workspace.js";
import { buildReviewerChatPrompt, buildReviewerPrompt } from "./prompts.js";
import { buildArgs as buildClaudeArgs } from "./providers/claude.js";
import { buildArgs as buildCodexArgs } from "./providers/codex.js";
import { buildArgs as buildOpenCodeArgs } from "./providers/opencode.js";
import type { ProviderCommand } from "./providers/types.js";
import { createCodexRuntimeAuthGetter } from "../codex-runtime-auth.js";
import {
  CodexOneShotCancelledError,
  REVIEWER_INSPECTION_REQUIRED_ERROR,
  runCodexOneShot,
} from "./codex-one-shot.js";
import { cfTransportHeaders } from "../config.js";
import {
  buildReviewerProviderEnvironment,
  fingerprintReviewerCheckout,
  prepareReviewerRuntimeDirectories,
  protectReviewerCheckout,
  reviewerChildIdentity,
  seedOpenCodeReviewerRuntime,
} from "./reviewer-isolation.js";

// Disposable one-shot runtime for reviewer execution. Plan Writer owns its
// native provider TUI through the separate plan-writer supervisor.

const STDERR_TAIL_CHARS = 2_000;
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

interface RuntimeSettings {
  harness: Harness;
  checkoutDir: string;
  outputFile: string;
  statusPollMs: number;
}

function usesCodexSubscriptionAppServer(settings: RuntimeSettings): boolean {
  return settings.harness === "codex"
    && process.env.TILLER_CODEX_RUNTIME_MODE === "app-server"
    && process.env.TILLER_CODEX_AUTH_MODE === "subscription";
}

function resolveProviderCommand(
  settings: RuntimeSettings,
  context: PlannerRunContext,
  prompt: string,
  fallbackOutputFile: string,
  providerEnv: NodeJS.ProcessEnv,
  configPath: string,
): ProviderCommand {
  if (settings.harness === "claude-code") {
    return buildClaudeArgs({
      prompt,
      model: context.run.model,
      effort: context.input.effort === "ultra" ? "max" : context.input.effort,
    });
  }
  if (settings.harness === "codex") {
    return buildCodexArgs({
      prompt,
      model: context.run.model,
      effort: context.input.effort === "max" ? "xhigh" : context.input.effort,
      checkoutDir: settings.checkoutDir,
      fallbackOutputFile,
      configPath: join(providerEnv.CODEX_HOME ?? dirname(configPath), "config.toml"),
    });
  }
  return buildOpenCodeArgs({
    prompt,
    model: context.run.model,
    effort: context.input.effort,
    env: providerEnv,
    configPath,
  });
}

function resolveEnvReviewProviderCommand(
  settings: RuntimeSettings,
  context: EnvReviewRunContext,
  fallbackOutputFile: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
): ProviderCommand {
  if (settings.harness === "claude-code") {
    return buildClaudeArgs({
      prompt: context.prompt,
      model: context.run.model,
      effort: context.run.effort === "ultra" ? "max" : context.run.effort,
    });
  }
  if (settings.harness === "codex") {
    return buildCodexArgs({
      prompt: context.prompt,
      model: context.run.model,
      effort: context.run.effort === "max" ? "xhigh" : context.run.effort,
      checkoutDir: settings.checkoutDir,
      fallbackOutputFile,
      configPath: join(env.CODEX_HOME ?? dirname(configPath), "config.toml"),
    });
  }
  return buildOpenCodeArgs({
    prompt: context.prompt,
    model: context.run.model,
    effort: context.run.effort,
    env,
    configPath,
  });
}

function normalizeDeletedWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed === ".") return null;
  return trimmed;
}

interface EnvReviewInspectionManifest {
  formatVersion: 1;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    beforeObject: string | null;
  }>;
}

function inspectionWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) return null;
  const parts = value.slice(1).split("/");
  if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) return null;
  return value;
}

function materializeEnvReviewInspection(
  checkoutDir: string,
  inspectionTar: Uint8Array,
): void {
  const contextDir = join(checkoutDir, ".tiller", "review-context");
  extractTarBuffer(inspectionTar, contextDir);
  const manifestPath = join(contextDir, "manifest.json");
  let manifest: EnvReviewInspectionManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as EnvReviewInspectionManifest;
  } catch (error) {
    throw new Error(`Invalid review inspection manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("Invalid review inspection manifest contract.");
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const workspacePath = inspectionWorkspacePath(file?.path);
    if (
      !workspacePath
      || (file.status !== "added" && file.status !== "modified" && file.status !== "deleted")
      || seen.has(workspacePath)
    ) {
      throw new Error("Invalid changed path in review inspection manifest.");
    }
    seen.add(workspacePath);
    if (file.status === "added") {
      if (file.beforeObject !== null) throw new Error(`Added review file unexpectedly has pre-change bytes: ${workspacePath}`);
      continue;
    }
    if (typeof file.beforeObject !== "string" || !/^objects\/\d{6}\.before$/u.test(file.beforeObject)) {
      throw new Error(`Pre-change review material is missing for ${workspacePath}`);
    }
    const source = resolvePath(contextDir, file.beforeObject);
    const target = resolvePath(contextDir, "before", workspacePath.slice(1));
    if (!source.startsWith(`${resolvePath(contextDir, "objects")}/`) || !target.startsWith(`${resolvePath(contextDir, "before")}/`)) {
      throw new Error(`Unsafe review inspection path: ${workspacePath}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
  }
  rmSync(join(contextDir, "objects"), { recursive: true, force: true });
}

function applyGitHubDeletedPaths(checkoutDir: string, paths: readonly unknown[]): number {
  const root = resolvePath(checkoutDir);
  let deleted = 0;
  for (const value of paths) {
    const path = normalizeDeletedWorkspacePath(value);
    if (!path) continue;
    const target = resolvePath(checkoutDir, path);
    if (!target.startsWith(`${root}/`) && target !== root) {
      throw new Error(`Refusing to delete path outside checkout: ${path}`);
    }
    rmSync(target, { recursive: true, force: true });
    deleted += 1;
  }
  return deleted;
}


function readOptionalFile(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

function buildPrompt(context: PlannerRunContext, outputFile?: string): string {
  if (context.input.instruction?.trim()) {
    return buildReviewerChatPrompt({
      plan: context.plan,
      skillInstructions: context.skillInstructions,
      threadMessages: context.threadMessages,
      threadMessagesTruncated: context.threadMessagesTruncated,
      instruction: context.input.instruction,
      outputFile,
    });
  }
  return buildReviewerPrompt({
    plan: context.plan,
    skillInstructions: context.skillInstructions,
    outputFile,
  });
}
type TurnOutcome = "succeeded" | "failed" | "cancelled";
type RepoGitDirResolver = (context: PlannerRunContext) => Promise<string>;

class PlannerResultDeliveryError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Reviewer output was produced but could not be delivered: ${detail}`);
    this.name = "PlannerResultDeliveryError";
  }
}

async function postSuccessfulReviewerResult(
  client: PlannerHubCallback,
  text: string,
): Promise<void> {
  try {
    await client.postResult({ status: "succeeded", text });
  } catch (error) {
    throw new PlannerResultDeliveryError(error);
  }
}

// Executes one reviewer run end to end: context → checkout → CLI → result.
// Failures are reported to the run-scoped callback before the process exits.
async function executeTurn(
  client: PlannerHubCallback,
  settings: RuntimeSettings,
  resolveRepoGitDir: RepoGitDirResolver,
): Promise<TurnOutcome> {
  async function failTurn(error: unknown): Promise<TurnOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tiller-planner] turn failed: ${message}`);
    await client.flushModelActivity();
    await client.postResult({ status: "failed", error: message }).catch((postError) => {
      console.error(`[tiller-planner] failed to report failure: ${String(postError)}`);
    });
    return "failed";
  }

  try {
    await client.postEvent({ type: "runtime_startup" });
    const context = await client.fetchContext();
    console.error(`[tiller-planner] reviewer run ${context.run.runId} provider=${context.run.provider}`);

    const isolation = prepareReviewerRuntimeDirectories(
      settings.checkoutDir,
      context.run.runId,
    );
    if (settings.harness === "opencode") {
      seedOpenCodeReviewerRuntime(isolation.directories, isolation.account);
    }
    settings.outputFile = isolation.directories.output;

    const baseCommit = context.input.githubBaseCommitSha?.trim() || requireEnv("TILLER_GITHUB_BASE_COMMIT_SHA");
    const repoGitDir = await resolveRepoGitDir(context);
    await createCheckout(repoGitDir, settings.checkoutDir, baseCommit);
    protectReviewerCheckout(settings.checkoutDir);
    const checkoutFingerprint = fingerprintReviewerCheckout(settings.checkoutDir);

    mkdirSync(dirname(settings.outputFile), { recursive: true });
    rmSync(settings.outputFile, { force: true });
    const fallbackOutputFile = isolation.directories.fallbackOutput;
    rmSync(fallbackOutputFile, { force: true });

    const providerBaseEnv = buildReviewerProviderEnvironment({
      harness: settings.harness,
      source: process.env,
      directories: isolation.directories,
    });

    const subscriptionAppServer = usesCodexSubscriptionAppServer(settings);
    const requireInspection = !context.input.instruction?.trim();
    const prompt = buildPrompt(context, subscriptionAppServer ? undefined : settings.outputFile);
    client.queueModelActivity("Thinking");
    if (subscriptionAppServer) {
      try {
        const output = await runCodexOneShot({
          cwd: settings.checkoutDir,
          model: context.run.model,
          effort: context.input.effort === "max" ? "xhigh" : context.input.effort,
          prompt,
          getAuth: createCodexRuntimeAuthGetter({
            url: `${requireEnv("TILLER_PLANNER_CALLBACK_BASE").replace(/\/+$/u, "")}/runtime-auth`,
            tokenHeader: "X-Tiller-Planner-Run-Token",
            token: requireEnv("TILLER_PLANNER_RUN_TOKEN"),
            headers: cfTransportHeaders,
          }),
          isCancelled: async () => await client.pollRunStatus() === "cancelled",
          onActivity: (message) => client.queueModelActivity(message),
          onCommentary: (message) => client.queueModelCommentary(message),
          env: providerBaseEnv,
          account: isolation.account,
          requireInspection,
        });
        if (fingerprintReviewerCheckout(settings.checkoutDir) !== checkoutFingerprint) {
          return await failTurn(new Error("Reviewer modified the protected workspace checkout."));
        }
        await client.flushModelActivity();
        await postSuccessfulReviewerResult(client, output);
        console.error("[tiller-planner] subscription reviewer turn completed");
        return "succeeded";
      } catch (error) {
        if (error instanceof CodexOneShotCancelledError) {
          await client.flushModelActivity();
          return "cancelled";
        }
        if (error instanceof PlannerResultDeliveryError) {
          console.error(`[tiller-planner] ${error.message}`);
          return "failed";
        }
        return await failTurn(error);
      }
    }
    const command = resolveProviderCommand(
      settings,
      context,
      prompt,
      fallbackOutputFile,
      providerBaseEnv,
      join(isolation.directories.config, "opencode.json"),
    );
    const tracker = new PlannerOutputTracker(
      settings.harness,
      (message) => client.queueModelActivity(message),
      settings.checkoutDir,
      (message) => client.queueModelCommentary(message),
    );

    let stdoutBuffer = "";
    let stderrTail = "";
    const outcome = await superviseDirectChild({
      spawnChild: () => spawn(command.command, command.args, {
        cwd: settings.checkoutDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildReviewerProviderEnvironment({
          harness: settings.harness,
          source: process.env,
          commandEnv: command.env,
          directories: isolation.directories,
        }),
        ...reviewerChildIdentity(isolation.account),
      }),
      isCancelled: async () => await client.pollRunStatus() === "cancelled",
      statusPollMs: settings.statusPollMs,
      onSpawn: (child) => {
        child.stdout?.setEncoding("utf-8");
        child.stdout?.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          let newlineIndex = stdoutBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            tracker.handleLine(stdoutBuffer.slice(0, newlineIndex));
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            newlineIndex = stdoutBuffer.indexOf("\n");
          }
        });
        child.stderr?.setEncoding("utf-8");
        child.stderr?.on("data", (chunk: string) => {
          stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
        });
      },
    });

    if (stdoutBuffer.trim()) {
      tracker.handleLine(stdoutBuffer);
    }
    if (tracker.providerSessionId) {
      console.error(`[tiller-planner] provider session id=${tracker.providerSessionId}`);
    }
    await client.flushModelActivity();

    if (outcome.kind === "cancelled") {
      // The hub already marked the run cancelled; a result would be ignored.
      return "cancelled";
    }
    if (outcome.kind === "timed_out") {
      return await failTurn(new Error(`${command.command} timed out after 60 minutes.`));
    }
    if (outcome.kind === "spawn_failed") {
      return await failTurn(new Error(`Failed to start ${command.command}: ${outcome.error.message}`));
    }
    if (outcome.exitCode !== 0) {
      return await failTurn(new Error(
        `${command.command} exited with code ${outcome.exitCode ?? "unknown"}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
      ));
    }
    if (fingerprintReviewerCheckout(settings.checkoutDir) !== checkoutFingerprint) {
      return await failTurn(new Error("Reviewer modified the protected workspace checkout."));
    }

    const output = readOptionalFile(settings.outputFile)
      || readOptionalFile(fallbackOutputFile)
      || (tracker.finalFallbackText ?? "").trim();
    if (!output) {
      return await failTurn(new Error(`${command.command} completed without writing ${settings.outputFile}`));
    }
    if (requireInspection && !tracker.hasSuccessfulRepositoryInspection) {
      return await failTurn(new Error(REVIEWER_INSPECTION_REQUIRED_ERROR));
    }

    await postSuccessfulReviewerResult(client, output);
    console.error("[tiller-planner] turn completed");
    return "succeeded";
  } catch (error) {
    if (error instanceof PlannerResultDeliveryError) {
      console.error(`[tiller-planner] ${error.message}`);
      return "failed";
    }
    return await failTurn(error);
  }
}

async function ensureRepo(settings: RuntimeSettings, baseCommitSha?: string | null): Promise<string> {
  return (await ensureGitHubWorkspaceRepo({
    repoUrl: requireEnv("REPO_URL"),
    baseCommitSha: baseCommitSha?.trim() || requireEnv("TILLER_GITHUB_BASE_COMMIT_SHA"),
    checkoutDir: settings.checkoutDir,
  })).repoGitDir;
}

function hasGitHubArchiveBridgeEnv(): boolean {
  return Boolean(
    process.env.HUB_URL?.trim() &&
    process.env.REPO_URL?.trim()?.startsWith("https://github.com/") &&
    process.env.TILLER_GITHUB_BRIDGE_ID?.trim() &&
    process.env.TILLER_GITHUB_BRIDGE_SECRET?.trim(),
  );
}

async function materializeEnvironmentReviewerBase(settings: RuntimeSettings, baseCommit: string): Promise<void> {
  if (hasGitHubArchiveBridgeEnv()) {
    await materializeGitHubArchiveBase({
      repoUrl: requireEnv("REPO_URL"),
      checkoutDir: settings.checkoutDir,
      baseCommitSha: baseCommit,
      hubUrl: requireEnv("HUB_URL"),
      bridgeId: requireEnv("TILLER_GITHUB_BRIDGE_ID"),
      bridgeSecret: requireEnv("TILLER_GITHUB_BRIDGE_SECRET"),
      cfAccessClientId: process.env.CF_ACCESS_CLIENT_ID ?? null,
      cfAccessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET ?? null,
    });
    return;
  }

  const repoGitDir = await ensureRepo(settings, baseCommit);
  await createCheckout(repoGitDir, settings.checkoutDir, baseCommit);
}

async function runOneShot(settings: RuntimeSettings): Promise<void> {
  const callbackBase = requireEnv("TILLER_PLANNER_CALLBACK_BASE");
  const runToken = requireEnv("TILLER_PLANNER_RUN_TOKEN");
  const client = new PlannerHubCallback({ baseUrl: callbackBase, runToken });
  try {
    const outcome = await executeTurn(client, settings, (context) => ensureRepo(settings, context.input.githubBaseCommitSha));
    process.exit(outcome === "failed" ? 1 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tiller-planner] run failed: ${message}`);
    await client.flushModelActivity();
    await client.postResult({ status: "failed", error: message }).catch(() => undefined);
    process.exit(1);
  }
}

async function runEnvReviewOneShot(settings: RuntimeSettings): Promise<void> {
  const callbackBase = requireEnv("TILLER_ENV_REVIEW_CALLBACK_BASE");
  const runToken = requireEnv("TILLER_ENV_REVIEW_RUN_TOKEN");
  const client = new EnvReviewHubCallback({ baseUrl: callbackBase, runToken });

  async function failRun(error: unknown): Promise<never> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tiller-planner] env review failed: ${message}`);
    await client.flushModelActivity();
    await client.postResult({ status: "failed", error: message }).catch((postError) => {
      console.error(`[tiller-planner] failed to report env review failure: ${String(postError)}`);
    });
    process.exit(1);
  }

  try {
    await client.postEvent({ type: "runtime_startup" });
    const context = await client.fetchContext();
    console.error(`[tiller-planner] env review ${context.run.runId} role=${context.run.roleLabel} provider=${context.run.provider}`);
    // Fail closed for older Hubs. Only synthesis-only runs receive an explicit
    // exemption from the Hub that constructed their prompt.
    const requireInspection = context.run.requiresRepositoryInspection !== false;

    const isolation = prepareReviewerRuntimeDirectories(
      settings.checkoutDir,
      context.run.runId,
    );
    if (settings.harness === "opencode") {
      seedOpenCodeReviewerRuntime(isolation.directories, isolation.account);
    }
    settings.outputFile = isolation.directories.output;

    const [tar, inspectionTar] = await Promise.all([
      client.fetchWorkspaceTar(),
      client.fetchInspectionTar(),
    ]);
    const baseCommit = process.env.TILLER_GITHUB_BASE_COMMIT_SHA?.trim() ?? "";
    if (baseCommit && process.env.REPO_URL?.trim()) {
      await materializeEnvironmentReviewerBase(settings, baseCommit);
      applyGitHubDeletedPaths(settings.checkoutDir, context.workspace?.githubDeletedPaths ?? []);
      extractTarBuffer(tar, settings.checkoutDir, { clean: false });
    } else {
      extractTarBuffer(tar, settings.checkoutDir);
    }
    materializeEnvReviewInspection(settings.checkoutDir, inspectionTar);
    protectReviewerCheckout(settings.checkoutDir);
    const checkoutFingerprint = fingerprintReviewerCheckout(settings.checkoutDir);

    mkdirSync(dirname(settings.outputFile), { recursive: true });
    rmSync(settings.outputFile, { force: true });
    const fallbackOutputFile = isolation.directories.fallbackOutput;
    rmSync(fallbackOutputFile, { force: true });

    const providerBaseEnv = buildReviewerProviderEnvironment({
      harness: settings.harness,
      source: process.env,
      directories: isolation.directories,
    });
    const subscriptionGetAuth = usesCodexSubscriptionAppServer(settings)
      ? createCodexRuntimeAuthGetter({
          url: `${requireEnv("TILLER_ENV_REVIEW_CALLBACK_BASE").replace(/\/+$/u, "")}/runtime-auth`,
          tokenHeader: "X-Tiller-Env-Review-Run-Token",
          token: requireEnv("TILLER_ENV_REVIEW_RUN_TOKEN"),
          headers: cfTransportHeaders,
        })
      : null;
    client.queueModelActivity("Thinking");
    if (subscriptionGetAuth) {
      try {
        const output = await runCodexOneShot({
          cwd: settings.checkoutDir,
          model: context.run.model,
          effort: context.run.effort === "max" ? "xhigh" : context.run.effort,
          prompt: context.prompt,
          getAuth: subscriptionGetAuth,
          isCancelled: async () => await client.pollRunStatus() === "cancelled",
          onActivity: (message) => client.queueModelActivity(message),
          onCommentary: (message) => client.queueModelCommentary(message),
          env: providerBaseEnv,
          account: isolation.account,
          requireInspection,
        });
        if (fingerprintReviewerCheckout(settings.checkoutDir) !== checkoutFingerprint) {
          await failRun(new Error("Reviewer modified the read-only workspace checkout."));
        }
        await client.flushModelActivity();
        await client.postResult({ status: "succeeded", text: output });
        console.error("[tiller-planner] subscription env review completed");
        process.exit(0);
      } catch (error) {
        if (error instanceof CodexOneShotCancelledError) {
          await client.flushModelActivity();
          process.exit(0);
        }
        await failRun(error);
      }
    }
    const command = resolveEnvReviewProviderCommand(
      settings,
      context,
      fallbackOutputFile,
      providerBaseEnv,
      join(isolation.directories.config, "opencode.json"),
    );
    const tracker = new PlannerOutputTracker(
      settings.harness,
      (message) => client.queueModelActivity(message),
      settings.checkoutDir,
      (message) => client.queueModelCommentary(message),
    );

    let stdoutBuffer = "";
    let stderrTail = "";
    const outcome = await superviseDirectChild({
      spawnChild: () => spawn(command.command, command.args, {
        cwd: settings.checkoutDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildReviewerProviderEnvironment({
          harness: settings.harness,
          source: process.env,
          commandEnv: command.env,
          directories: isolation.directories,
        }),
        ...reviewerChildIdentity(isolation.account),
      }),
      isCancelled: async () => await client.pollRunStatus() === "cancelled",
      statusPollMs: settings.statusPollMs,
      onSpawn: (child) => {
        child.stdout?.setEncoding("utf-8");
        child.stdout?.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          let newlineIndex = stdoutBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            tracker.handleLine(stdoutBuffer.slice(0, newlineIndex));
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            newlineIndex = stdoutBuffer.indexOf("\n");
          }
        });
        child.stderr?.setEncoding("utf-8");
        child.stderr?.on("data", (chunk: string) => {
          stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
        });
      },
    });

    if (stdoutBuffer.trim()) {
      tracker.handleLine(stdoutBuffer);
    }
    if (tracker.providerSessionId) {
      console.error(`[tiller-planner] provider session id=${tracker.providerSessionId}`);
    }
    await client.flushModelActivity();

    if (outcome.kind === "cancelled") {
      process.exit(0);
    }
    if (outcome.kind === "timed_out") {
      return await failRun(new Error(`${command.command} timed out after 60 minutes.`));
    }
    if (outcome.kind === "spawn_failed") {
      return await failRun(new Error(`Failed to start ${command.command}: ${outcome.error.message}`));
    }
    if (outcome.exitCode !== 0) {
      await failRun(new Error(
        `${command.command} exited with code ${outcome.exitCode ?? "unknown"}${stderrTail.trim() ? `: ${stderrTail.trim()}` : ""}`,
      ));
    }
    if (fingerprintReviewerCheckout(settings.checkoutDir) !== checkoutFingerprint) {
      await failRun(new Error("Reviewer modified the read-only workspace checkout."));
    }

    const output = readOptionalFile(settings.outputFile)
      || readOptionalFile(fallbackOutputFile)
      || (tracker.finalFallbackText ?? "").trim();
    if (!output) {
      await failRun(new Error(`${command.command} completed without writing reviewer output`));
    }
    if (requireInspection && !tracker.hasSuccessfulRepositoryInspection) {
      await failRun(new Error(REVIEWER_INSPECTION_REQUIRED_ERROR));
    }
    await client.postResult({
      status: "succeeded",
      text: output,
    });
    console.error("[tiller-planner] one-shot reviewer run completed");
    process.exit(0);
  } catch (error) {
    await failRun(error);
  }
}

async function main(): Promise<void> {
  const settings: RuntimeSettings = {
    harness: resolveHarness(process.env.TILLER_HARNESS),
    checkoutDir: process.env.TILLER_PLANNER_CHECKOUT_DIR?.trim() || "/tmp/tiller-planner/checkout",
    outputFile: process.env.TILLER_PLANNER_OUTPUT_FILE?.trim() || "/tmp/tiller-planner/output.md",
    statusPollMs: Number(process.env.TILLER_PLANNER_STATUS_POLL_MS) || 15_000,
  };
  if (process.env.TILLER_ENV_REVIEW_CALLBACK_BASE?.trim()) {
    await runEnvReviewOneShot(settings);
    return;
  }
  await runOneShot(settings);
}

void main().catch((error) => {
  console.error(`[tiller-planner] fatal: ${String(error)}`);
  process.exit(1);
});
