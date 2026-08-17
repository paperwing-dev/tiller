#!/usr/bin/env node
import { chownSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Agent } from "../agent.js";
import {
  cfTransportHeaders,
  HUB_URL,
  MACHINE_ID,
  NAMESPACE,
  ensureAuth,
} from "../config.js";
import { createPlanWriterSession } from "../hub-api.js";
import { HubClient } from "../hub-client.js";
import { harnessInputFragments } from "../input.js";
import {
  deliverPlanWriterInput,
  PlanWriterActivityController,
  planWriterTurnLifecycleForClaudeHook,
  reportPlanWriterSettlement,
} from "./activity.js";
import {
  CodexPlanWriterTurnQueue,
  codexNotificationThreadId,
  codexThreadRestingLifecycle,
  hasManagedCodexSettings,
  hasManagedCodexThreadSettings,
  newestCompletedPlan,
  reconcileCodexCompletionWithRetry,
  type CodexThreadRead,
} from "./codex-app-server.js";
import {
  PLAN_MARKDOWN_NORMALIZATION_VERSION,
  PLAN_WRITER_PROTOCOL_VERSION,
  type NativeTuiLaunch,
  type PlanWriterContext,
} from "./contract.js";
import {
  mergeRefreshedPlanWriterContext,
  sha256Hex,
  writeManagedPlanWriterContext,
} from "./context.js";
import {
  PlanWriterSkillRequestIds,
  planWriterSkillStartedReason,
} from "./skill-invocation.js";
import { buildClaudeLaunch, buildCodexLaunch } from "./provider.js";
import { buildOpenCodeLaunch, waitForOpenCodeReady } from "./opencode.js";
import { OpenCodeGenerationFence } from "./opencode-hook.js";
import { PlanWriterPublicationQueue } from "./publication-queue.js";
import { containsUnsupportedConversationCommand } from "./sanitize.js";
import { createCodexRuntimeAuthGetter } from "../codex-runtime-auth.js";
import { startPlanWriterStartupDeadline } from "./startup-deadline.js";
import { PlanPublicationCoordinator } from "./publication.js";
import {
  isClaudeRepoPlanMutationTool,
  repoPlansEnabled,
} from "./repo-plans.js";
import {
  planWriterStoppingError,
  proxyRepoPlanCommand,
  readPlanWriterLocalBody,
} from "./supervisor-http.js";

const CODEX_NATURAL_EXIT_DRAIN_MS = 5_000;
const CODEX_COMPLETION_RECONCILIATION_ATTEMPTS = 3;

interface RuntimeConfig {
  repoId: string;
  planArtifactId: string;
  generation: number;
  basisCommit: string;
  terminalId: string;
  callbackBase: string;
  token: string;
  provider: "claude-code" | "codex" | "opencode";
  checkoutDir: string;
  idleMs: number | null;
  startupDeadlineMs: number;
}

let cancelStartupDeadline: (() => void) | null = null;

function clearStartupDeadline(): void {
  cancelStartupDeadline?.();
  cancelStartupDeadline = null;
}

function required(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

function runtimeConfig(): RuntimeConfig {
  const provider = required("TILLER_HARNESS");
  if (
    provider !== "claude-code" &&
    provider !== "codex" &&
    provider !== "opencode"
  ) {
    throw new Error(
      "Plan writers support only claude-code, codex, and opencode",
    );
  }
  const rawIdleMs = process.env.TILLER_PLAN_WRITER_IDLE_MS?.trim();
  const configuredIdleMs = rawIdleMs ? Number(rawIdleMs) : Number.NaN;
  return {
    repoId: required("TILLER_PLAN_WRITER_REPO_ID"),
    planArtifactId: required("TILLER_PLAN_WRITER_ARTIFACT_ID"),
    generation: positiveInteger("TILLER_PLAN_WRITER_GENERATION"),
    basisCommit: required("TILLER_PLAN_WRITER_BASIS_COMMIT"),
    terminalId: required("TILLER_PLAN_WRITER_TERMINAL_ID"),
    callbackBase: required("TILLER_PLAN_WRITER_CALLBACK_BASE").replace(
      /\/+$/u,
      "",
    ),
    token: required("TILLER_PLAN_WRITER_TOKEN"),
    provider,
    checkoutDir:
      process.env.TILLER_PLAN_WRITER_CHECKOUT_DIR?.trim() || "/workspace",
    idleMs:
      configuredIdleMs === 0
        ? null
        : Number.isFinite(configuredIdleMs)
          ? Math.max(1_000, configuredIdleMs)
          : 900_000,
    startupDeadlineMs: Math.max(
      60_000,
      Number(process.env.TILLER_PLAN_WRITER_WATCHDOG_MS) || 28_800_000,
    ),
  };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

function providerAccount(): { uid: number; gid: number } {
  const uid = Number(
    execFileSync("id", ["-u", "tiller"], { encoding: "utf8" }).trim(),
  );
  const gid = Number(
    execFileSync("id", ["-g", "tiller"], { encoding: "utf8" }).trim(),
  );
  return { uid, gid };
}

function assertContextOwnership(
  context: PlanWriterContext,
  config: RuntimeConfig,
): void {
  if (
    context.writer.protocolVersion !== PLAN_WRITER_PROTOCOL_VERSION ||
    context.writer.repoId !== config.repoId ||
    context.writer.planArtifactId !== config.planArtifactId ||
    context.writer.generation !== config.generation ||
    context.writer.basisCommit !== config.basisCommit ||
    context.writer.terminalId !== config.terminalId ||
    context.writer.provider !== config.provider ||
    context.plan.normalizationVersion !== PLAN_MARKDOWN_NORMALIZATION_VERSION
  )
    throw new Error(
      "Hub writer context does not match this deterministic generation",
    );
}

async function main(): Promise<void> {
  ensureAuth();
  const config = runtimeConfig();
  const root = join("/var/lib/tiller-plan-writer", config.terminalId);
  const providerHome = join(root, "provider-home");
  const contextPath = join(root, "managed-context.md");
  const socketPath = join(root, "supervisor.sock");
  const codexSocketPath = join(providerHome, "tmp", "codex-app-server.sock");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o711 });
  chmodSync(root, 0o711);
  const account = providerAccount();
  if (config.provider !== "opencode") {
    mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    chownSync(providerHome, account.uid, account.gid);
  }

  const generationAbort = new AbortController();
  const skillRequestIds = new PlanWriterSkillRequestIds(config.generation);
  const requestHub = async <T>(
    path: string,
    init: RequestInit = {},
    generationSignal?: AbortSignal,
  ): Promise<T> => {
    const response = await fetch(`${config.callbackBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Tiller-Plan-Writer-Token": config.token,
        ...cfTransportHeaders,
        ...(init.headers ?? {}),
      },
      signal: generationSignal ?? AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(body.error || `Hub returned HTTP ${response.status}`);
    return body;
  };

  let launch: NativeTuiLaunch & {
    appServer?: Awaited<ReturnType<typeof buildCodexLaunch>>["appServer"];
    threadId?: string;
    providerId?: string;
    modelId?: string;
    variant?: string;
  };
  const server = createServer();
  let agent: Agent | null = null;
  let terminalInputReady = false;
  let shuttingDown = false;

  const stopRuntime = async (
    reason: "idle" | "runtime_ended" | "mode_invalidated" | "watchdog",
    startupError?: string,
  ) => {
    if (shuttingDown) return;
    clearStartupDeadline();
    shuttingDown = true;
    // Abort publication work immediately; reporting the stop must not delay
    // cancellation if the Hub is slow or unreachable.
    generationAbort.abort();
    agent?.kill();
    await requestHub("/stop", {
      method: "POST",
      body: JSON.stringify({
        reason,
        ...(startupError ? { startupError } : {}),
      }),
    }).catch(() => undefined);
  };

  cancelStartupDeadline = startPlanWriterStartupDeadline(
    config.startupDeadlineMs,
    () => stopRuntime("watchdog"),
  );

  let context = await requestHub<PlanWriterContext>("/context");
  assertContextOwnership(context, config);
  const repoPlansFrozen = repoPlansEnabled(context);
  writeManagedPlanWriterContext(contextPath, context);

  let commandBuffer = "";
  const publicationQueue = new PlanWriterPublicationQueue(
    generationAbort.signal,
  );
  let codexRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleCodexReconciliationRetry(error?: unknown): void {
    if (error)
      console.error("[plan-writer] Codex reconciliation failed:", error);
    if (codexRetryTimer || shuttingDown) return;
    codexRetryTimer = setTimeout(() => {
      codexRetryTimer = null;
      if (shuttingDown || !launch?.appServer || !launch.threadId) return;
      void reconcileCodex().catch(scheduleCodexReconciliationRetry);
    }, 5_000);
  }

  function waitForCodexReconciliationRetry(): Promise<void> {
    if (generationAbort.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, 5_000);
      generationAbort.signal.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        generationAbort.signal.removeEventListener("abort", done);
        resolve();
      }
    });
  }

  const activity = new PlanWriterActivityController({
    idleMs: config.idleMs,
    onIdle: async () => {
      if (config.provider === "codex" && launch?.appServer && launch.threadId) {
        const thread = await launch.appServer
          .readThread(launch.threadId)
          .catch(() => null);
        if (!thread) {
          scheduleCodexReconciliationRetry();
          return "deferred";
        }
        const active = thread && isCodexTurnActive(thread);
        if (active) return false;
      }
      await stopRuntime("idle");
      return true;
    },
    onSettled: async (sequence) => {
      try {
        await reportPlanWriterSettlement(
          sequence,
          async (reportedSequence, signal) => {
            const response = await fetch(`${config.callbackBase}/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Tiller-Plan-Writer-Token": config.token,
                ...cfTransportHeaders,
              },
              body: JSON.stringify({ sequence: reportedSequence }),
              signal,
            });
            return response.status;
          },
        );
      } catch (error) {
        console.error(
          "[plan-writer] Could not report settled turn:",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  const refreshManagedContext = async (publicationSignal: AbortSignal) => {
    const refreshed = await requestHub<PlanWriterContext>(
      "/context",
      {},
      publicationSignal,
    );
    assertContextOwnership(refreshed, config);
    context = mergeRefreshedPlanWriterContext(context, refreshed);
    writeManagedPlanWriterContext(contextPath, context);
    await requestHub(
      "/synchronization",
      { method: "POST", body: JSON.stringify({ error: null }) },
      publicationSignal,
    );
  };

  const publicationCoordinator = new PlanPublicationCoordinator({
    initialCursor: context.writer.publicationCursor,
    async post(payload, signal) {
      try {
        const response = await fetch(`${config.callbackBase}/publications`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tiller-Plan-Writer-Token": config.token,
            ...cfTransportHeaders,
          },
          body: JSON.stringify(payload),
          signal,
        });
        const body = (await response.json().catch(() => ({}))) as {
          cursor?: PlanWriterContext["writer"]["publicationCursor"];
          error?: string;
        };
        return {
          status: response.status,
          ...(body.cursor ? { cursor: body.cursor } : {}),
          ...(body.error ? { error: body.error } : {}),
        };
      } catch (error) {
        throw error;
      }
    },
    async readContext(signal) {
      const canonical = await requestHub<PlanWriterContext>("/context", {}, signal);
      assertContextOwnership(canonical, config);
      return canonical;
    },
    refreshManagedContext,
    async recordSynchronizationError(error) {
      await requestHub("/synchronization", {
        method: "POST",
        body: JSON.stringify({ error }),
      });
    },
  });

  const publishPlan = (
    markdown: string,
    providerEventId: string,
  ): Promise<void> => {
    return publicationQueue.enqueue(async (operationSignal) => {
      await activity.setPublicationActive(true);
      try {
        await publicationCoordinator.publish(
          markdown,
          providerEventId,
          launch.conversationId,
          operationSignal,
        );
      } finally {
        await activity.setPublicationActive(false);
      }
    });
  };

  const reconcileCodexOnce = async () => {
    if (!launch.appServer || !launch.threadId) return null;
    const effective = await launch.appServer.readEffectiveSettings(
      launch.threadId,
    );
    const threadSettings = launch.appServer.currentThreadSettings(
      launch.threadId,
    );
    if (
      !hasManagedCodexSettings(effective, {
        threadId: launch.threadId,
        cwd: config.checkoutDir,
      }) ||
      !threadSettings ||
      !hasManagedCodexThreadSettings(threadSettings, {
        cwd: config.checkoutDir,
      })
    ) {
      await stopRuntime("mode_invalidated");
      return null;
    }
    const thread = await launch.appServer.readThread(launch.threadId);
    if (
      thread.thread.id !== launch.threadId ||
      thread.thread.parentThreadId !== null ||
      thread.thread.cwd !== config.checkoutDir
    ) {
      await stopRuntime("mode_invalidated");
      return null;
    }
    const turnActive = isCodexTurnActive(thread);
    const plan = newestCompletedPlan(thread, publicationCoordinator.lastProviderEventId);
    if (plan) {
      await publishPlan(plan.markdown, plan.eventId);
      // Codex 0.144.x always opens its native “Implement this plan?” popup
      // after a completed Plan-mode turn. This writer cannot leave Plan mode,
      // so dismiss the popup after the canonical artifact is safely updated.
      await agent?.writeStdin("\x1b").catch((error) => {
        console.error(
          "[plan-writer] Could not dismiss Codex implementation prompt:",
          error,
        );
      });
    }
    return {
      turnActive,
      restingLifecycle: turnActive ? null : codexThreadRestingLifecycle(thread),
    };
  };

  const performCodexReconciliation = async (
    options: { observeActivity?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof reconcileCodexOnce>>> => {
    if (shuttingDown) return null;
    const reconciled = await reconcileCodexOnce();
    if (
      options.observeActivity !== false &&
      reconciled?.turnActive &&
      !shuttingDown
    ) {
      await activity.handleTurnLifecycle("started");
    }
    return reconciled;
  };

  const codexTurnQueue = new CodexPlanWriterTurnQueue(async (lifecycle) => {
    if (lifecycle === "started") {
      await activity.handleTurnLifecycle("started");
      return;
    }
    if (lifecycle === "cancelled") {
      await activity.handleTurnLifecycle("cancelled");
      return;
    }
    const completion = await reconcileCodexCompletionWithRetry({
      reconcile: () => performCodexReconciliation({ observeActivity: false }),
      shouldContinue: () => !shuttingDown,
      sleep: waitForCodexReconciliationRetry,
      maxAttempts: CODEX_COMPLETION_RECONCILIATION_ATTEMPTS,
      onError: (error) => {
        console.error(
          "[plan-writer] Codex completion reconciliation attempt failed:",
          error,
        );
      },
    });
    if (!completion.completed) {
      if (completion.reason === "exhausted" && !shuttingDown) {
        console.error(
          `[plan-writer] Codex completion reconciliation failed after ${completion.attempts} attempts; settling the completed turn.`,
        );
        // The provider emitted a definitive completion notification. Closing
        // this turn preserves that user-visible boundary and lets later queued
        // lifecycle events continue even if reconciliation remains unavailable.
        await activity.handleTurnLifecycle("settled");
      }
      return;
    }
    if (!completion.value || shuttingDown) return;
    // Commit the completed turn only after publication, context refresh,
    // synchronization cleanup, and every retry have drained. If a newer turn
    // started during that work, reopen it after settling the prior boundary.
    await activity.handleTurnLifecycle("settled");
    if (completion.value.turnActive && !shuttingDown) {
      await activity.handleTurnLifecycle("started");
    }
  });

  const reconcileCodex = (
    options: { observeActivity?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof reconcileCodexOnce>>> =>
    codexTurnQueue.enqueueOperation(() => performCodexReconciliation(options));

  const drainCodexTurnQueueWithin = async (
    timeoutMs: number,
  ): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const drained = await Promise.race([
      codexTurnQueue.drain().then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return drained;
  };

  let openCodeFence: OpenCodeGenerationFence | null = null;
  let markOpenCodeReady: (() => void) | null = null;
  const openCodeReady = new Promise<void>((resolve) => {
    markOpenCodeReady = resolve;
  });

  server.on("request", async (request, response) => {
    try {
      if (shuttingDown) {
        json(response, 409, planWriterStoppingError(request));
        return;
      }
      if (
        await proxyRepoPlanCommand({
          request,
          response,
          enabled: repoPlansFrozen,
          callbackBase: config.callbackBase,
          token: config.token,
          headers: cfTransportHeaders,
          signal: generationAbort.signal,
        })
      ) {
        return;
      }
      const raw = await readPlanWriterLocalBody(request);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (request.url === "/opencode-hook") {
        if (config.provider !== "opencode" || !openCodeFence) {
          json(response, 409, {
            error: "No OpenCode writer generation owns this hook.",
          });
          return;
        }
        const action = openCodeFence.accept(body);
        if (action.kind === "violation") {
          json(response, 409, { error: action.message });
          void stopRuntime(
            "mode_invalidated",
            `OpenCode invariant violation: ${action.message}`,
          );
          return;
        }
        if (action.kind === "ready") {
          markOpenCodeReady?.();
          markOpenCodeReady = null;
          json(response, 200, { ok: true });
          return;
        }
        if (action.kind === "bound") {
          json(response, 200, { ok: true });
          return;
        }
        if (action.kind === "activity") {
          await activity.handleTurnLifecycle(action.lifecycle);
          json(response, 200, { ok: true });
          return;
        }
        try {
          await publishPlan(action.markdown, action.callID);
          json(response, 200, { ok: true });
        } catch (error) {
          json(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (request.url === "/codex-notify") {
        json(response, 200, { ok: true });
        const notifiedThreadId = codexNotificationThreadId(body);
        if (!notifiedThreadId || !launch.appServer || !launch.threadId) {
          void stopRuntime("mode_invalidated");
          return;
        }
        if (notifiedThreadId !== launch.threadId) {
          void launch.appServer.readThread(notifiedThreadId).then(
            async (notifiedThread) => {
              if (notifiedThread.thread.parentThreadId !== null) return;
              await stopRuntime("mode_invalidated");
            },
            () => stopRuntime("mode_invalidated"),
          );
          return;
        }
        void reconcileCodex().catch(scheduleCodexReconciliationRetry);
        return;
      }
      if (request.url !== "/claude-hook") {
        json(response, 404, { error: "Not found" });
        return;
      }
      const sessionId =
        typeof body.session_id === "string" ? body.session_id : "";
      const permissionMode =
        typeof body.permission_mode === "string" ? body.permission_mode : "";
      if (sessionId !== launch.conversationId || permissionMode !== "plan") {
        await stopRuntime("mode_invalidated");
        json(
          response,
          200,
          claudeDenial(
            "Writer ownership changed; this generation was stopped.",
          ),
        );
        return;
      }
      const event =
        typeof body.hook_event_name === "string" ? body.hook_event_name : "";
      if (event === "UserPromptSubmit") {
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const command = prompt.match(/^\/([a-z0-9-]+)$/u)?.[1]?.toLowerCase();
        const skill = command
          ? context.skills.find((candidate) => candidate.command === command)
          : null;
        if (skill) {
          const requestId = skillRequestIds.acquire(skill.command);
          try {
            await requestHub(`/skills/${encodeURIComponent(skill.command)}/invoke`, {
              method: "POST",
              body: JSON.stringify({ requestId }),
            });
            skillRequestIds.confirm(skill.command, requestId);
            json(response, 200, {
              decision: "block",
              reason: planWriterSkillStartedReason(skill),
            });
          } catch (error) {
            json(response, 200, {
              decision: "block",
              reason: `/${skill.command} could not start: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          return;
        }
      }
      const lifecycle = planWriterTurnLifecycleForClaudeHook(event);
      if (lifecycle !== null) await activity.handleTurnLifecycle(lifecycle);
      if (event === "SessionStart") {
        json(response, 200, {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: `Tiller managed context: ${contextPath}\nSHA-256: ${context.plan.digest}`,
          },
        });
        return;
      }
      if (
        event === "PreToolUse" &&
        repoPlansFrozen &&
        isClaudeRepoPlanMutationTool(body.tool_name)
      ) {
        json(
          response,
          200,
          claudeApproval(
            "The managed repository-plan mutation is authorized for this writer generation.",
          ),
        );
        return;
      }
      if (event === "PreToolUse" && body.tool_name === "ExitPlanMode") {
        const toolInput =
          body.tool_input && typeof body.tool_input === "object"
            ? (body.tool_input as Record<string, unknown>)
            : {};
        const plan = [
          toolInput.plan,
          toolInput.markdown,
          toolInput.content,
        ].find((value) => typeof value === "string") as string | undefined;
        if (!plan) {
          json(
            response,
            200,
            claudeDenial(
              "Tiller could not read a complete plan. Retry ExitPlanMode.",
            ),
          );
          return;
        }
        const eventId =
          typeof body.tool_use_id === "string"
            ? body.tool_use_id
            : sha256Hex(plan);
        try {
          await publishPlan(plan, eventId);
          json(
            response,
            200,
            claudeDenial("Saved to Tiller. Continue in Plan Mode."),
          );
        } catch (error) {
          json(
            response,
            200,
            claudeDenial(
              `Tiller sync failed; retry ExitPlanMode. ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        return;
      }
      json(response, 200, {});
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o660);
  chownSync(socketPath, 0, account.gid);

  launch =
    config.provider === "claude-code"
      ? await buildClaudeLaunch({
          context,
          checkoutDir: config.checkoutDir,
          home: providerHome,
          socketPath,
          contextPath,
          account,
        })
      : config.provider === "codex"
        ? await buildCodexLaunch({
            context,
            checkoutDir: config.checkoutDir,
            home: providerHome,
            socketPath,
            contextPath,
            appServerSocketPath: codexSocketPath,
            account,
            ...(process.env.TILLER_CODEX_RUNTIME_MODE === "app-server" &&
            process.env.TILLER_CODEX_AUTH_MODE === "subscription"
              ? {
                  getAuth: createCodexRuntimeAuthGetter({
                    url: `${config.callbackBase}/runtime-auth`,
                    tokenHeader: "X-Tiller-Plan-Writer-Token",
                    token: config.token,
                    headers: cfTransportHeaders,
                  }),
                }
              : {}),
          })
        : await buildOpenCodeLaunch({
            context,
            checkoutDir: config.checkoutDir,
            home: providerHome,
            socketPath,
            contextPath,
            terminalId: config.terminalId,
            account,
          });
  if (config.provider === "opencode") {
    openCodeFence = new OpenCodeGenerationFence({
      agent: "plan",
      providerId: launch.providerId!,
      modelId: launch.modelId!,
      variant: launch.variant!,
    });
  }
  if (launch.appServer) {
    void launch.appServer.closed.then(async (error) => {
      if (!error || shuttingDown) return;
      terminalInputReady = false;
      await drainCodexTurnQueueWithin(CODEX_NATURAL_EXIT_DRAIN_MS);
      await stopRuntime(
        "runtime_ended",
        `Codex app-server stopped: ${error.message}`,
      );
    });
  }
  const session = await createPlanWriterSession({
    id: config.terminalId,
    tag: "Plan Writer",
    machineId: MACHINE_ID,
    metadata: {
      cwd: config.checkoutDir,
      host: hostname(),
      platform: process.platform,
      harness: config.provider,
      role: "plan-writer",
      terminalScope: {
        kind: "plan-writer",
        repoId: config.repoId,
        planArtifactId: config.planArtifactId,
        generation: config.generation,
      },
    },
  }, config.token);
  const hub = new HubClient({
    hubUrl: HUB_URL,
    namespace: NAMESPACE,
    cfAccessHeaders: {
      ...cfTransportHeaders,
      "X-Tiller-Plan-Writer-Token": config.token,
    },
    wsScope: {
      kind: "planWriter",
      repoId: config.repoId,
      planArtifactId: config.planArtifactId,
      generation: config.generation,
      sessionId: session.id,
    },
  });
  hub.setSessionId(session.id);
  hub.on("connected", () => hub.sendSessionAlive(session.id));
  hub.on("terminal-input", (message) => {
    if (!agent || shuttingDown || !terminalInputReady) {
      hub.sendTerminalInputAck(
        message.sessionId,
        message.clientId,
        message.inputSeq,
        false,
        shuttingDown ? "Writer is not running" : "Writer is still starting",
      );
      return;
    }
    commandBuffer = `${commandBuffer}${message.data}`.slice(-512);
    if (containsUnsupportedConversationCommand(commandBuffer)) {
      hub.sendTerminalInputAck(
        message.sessionId,
        message.clientId,
        message.inputSeq,
        false,
        "This command replaces the managed writer conversation",
      );
      void stopRuntime("mode_invalidated");
      return;
    }
    const deliver = () =>
      agent!.writeInput(
        harnessInputFragments(config.provider, message.data),
        message.applyDimensions && message.cols && message.rows
          ? { cols: message.cols, rows: message.rows }
          : undefined,
      );
    const operation = deliverPlanWriterInput(activity, message.data, deliver);
    void operation.then(
      async (delivered) => {
        hub.sendTerminalInputAck(
          message.sessionId,
          message.clientId,
          message.inputSeq,
          delivered,
          delivered ? undefined : "Writer shutdown already started",
        );
        if (!delivered) return;
        if (config.provider === "codex" && /[\r\n]/u.test(message.data)) {
          setTimeout(() => {
            void reconcileCodex().catch(scheduleCodexReconciliationRetry);
          }, 250);
        }
      },
      (error) =>
        hub.sendTerminalInputAck(
          message.sessionId,
          message.clientId,
          message.inputSeq,
          false,
          error instanceof Error ? error.message : String(error),
        ),
    );
  });
  hub.on("terminal-control", (message) => {
    if (!agent || shuttingDown) {
      hub.sendTerminalControlAck(
        message.sessionId,
        message.clientId,
        message.controlSeq,
        false,
        "Writer is not running",
      );
      return;
    }
    const operation =
      message.action === "resize" && message.cols && message.rows
        ? agent.resize(message.cols, message.rows)
        : activity
            .handleTurnLifecycle("cancelled")
            .then(() => agent!.abortInput());
    void operation.then(
      () =>
        hub.sendTerminalControlAck(
          message.sessionId,
          message.clientId,
          message.controlSeq,
          true,
        ),
      (error) =>
        hub.sendTerminalControlAck(
          message.sessionId,
          message.clientId,
          message.controlSeq,
          false,
          error instanceof Error ? error.message : String(error),
        ),
    );
  });
  hub.connect();

  agent = new Agent(
    launch.command,
    launch.args,
    config.checkoutDir,
    launch.env,
    {
      inheritEnv: false,
      uid: account.uid,
      gid: account.gid,
    },
  );
  let markComposerReady: (() => void) | null = null;
  const composerReady = new Promise<void>((resolve) => {
    markComposerReady = resolve;
  });
  agent.on("output", (data) => {
    markComposerReady?.();
    markComposerReady = null;
    hub.sendMessage(crypto.randomUUID(), session.id, {
      role: "assistant",
      type: "terminal-output",
      data,
    });
  });
  const exit = new Promise<number>((resolve) => agent!.once("exit", resolve));
  const initializeTui = launch.initializeTui;
  const initialized = initializeTui
    ? composerReady.then(() => initializeTui((data) => agent!.writeStdin(data)))
    : Promise.resolve();
  const providerReady =
    config.provider === "opencode"
      ? Promise.all([
          composerReady,
          initialized,
          waitForOpenCodeReady([openCodeReady]),
        ])
      : Promise.all([composerReady, initialized]);
  const startup = await Promise.race([
    providerReady.then(
      () => ({ kind: "ready" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    ),
    exit.then((code) => ({ kind: "exited" as const, code })),
  ]);
  if (startup.kind === "failed") {
    const detail =
      startup.error instanceof Error
        ? startup.error.message
        : String(startup.error);
    await stopRuntime(
      "runtime_ended",
      `Provider failed to attach its managed native TUI: ${detail}`,
    );
    await exit;
    await activity.close();
    hub.sendSessionEnd(session.id);
    hub.close();
    server.close();
    await launch.afterExit?.();
    process.exitCode = 1;
    return;
  }
  if (startup.kind === "exited") {
    clearStartupDeadline();
    await activity.close();
    hub.sendSessionEnd(session.id);
    hub.close();
    server.close();
    await launch.afterExit?.();
    await stopRuntime(
      "runtime_ended",
      `Provider exited before the native composer became available (exit code ${startup.code}).`,
    );
    process.exitCode = startup.code === 0 ? 0 : 1;
    return;
  }
  let removeCodexSettingsListener: (() => void) | undefined;
  let removeCodexActivityListener: (() => void) | undefined;
  if (launch.appServer && launch.threadId) {
    const threadId = launch.threadId;
    const currentSettings = launch.appServer.currentThreadSettings(threadId);
    if (
      !currentSettings ||
      !hasManagedCodexThreadSettings(currentSettings, {
        cwd: config.checkoutDir,
      })
    ) {
      await stopRuntime(
        "mode_invalidated",
        "Codex did not remain in the managed Plan mode after attachment.",
      );
      await exit;
      await activity.close();
      hub.sendSessionEnd(session.id);
      hub.close();
      server.close();
      await launch.afterExit?.();
      process.exitCode = 1;
      return;
    }
    removeCodexSettingsListener = launch.appServer.onThreadSettingsUpdated(
      (updatedThreadId, settings) => {
        if (
          updatedThreadId !== threadId ||
          hasManagedCodexThreadSettings(settings, { cwd: config.checkoutDir })
        )
          return;
        void stopRuntime("mode_invalidated");
      },
    );
    removeCodexActivityListener = launch.appServer.onPlanWriterTurnLifecycle(
      threadId,
      (lifecycle) => {
        void codexTurnQueue
          .enqueue(lifecycle)
          .catch(scheduleCodexReconciliationRetry);
      },
    );
  }
  try {
    await requestHub("/register", {
      method: "POST",
      body: JSON.stringify({ providerConversationId: launch.conversationId }),
    });
  } catch (error) {
    await stopRuntime(
      "runtime_ended",
      `Plan Writer runtime registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await exit;
    removeCodexSettingsListener?.();
    removeCodexActivityListener?.();
    await codexTurnQueue.drain();
    await activity.close();
    hub.sendSessionEnd(session.id);
    hub.close();
    server.close();
    await launch.afterExit?.();
    throw error;
  }
  clearStartupDeadline();
  terminalInputReady = true;
  activity.startIdleTiming();
  if (config.provider === "codex") await reconcileCodex();
  const exitCode = await exit;
  removeCodexSettingsListener?.();
  terminalInputReady = false;
  if (!shuttingDown && config.provider === "codex") {
    const drained = await drainCodexTurnQueueWithin(
      CODEX_NATURAL_EXIT_DRAIN_MS,
    );
    if (drained && !shuttingDown) {
      const finalState = await reconcileCodex({ observeActivity: false }).catch(
        (error) => {
          console.error(
            "[plan-writer] Final Codex reconciliation failed:",
            error,
          );
          return null;
        },
      );
      if (finalState && !shuttingDown) {
        await activity.handleTurnLifecycle(
          finalState.turnActive
            ? "cancelled"
            : (finalState.restingLifecycle ?? "cancelled"),
        );
      }
    }
  }
  removeCodexActivityListener?.();
  if (!shuttingDown && config.provider === "codex") {
    await drainCodexTurnQueueWithin(CODEX_NATURAL_EXIT_DRAIN_MS);
  }
  if (!shuttingDown) await stopRuntime("runtime_ended");
  await codexTurnQueue.drain();
  await activity.close();
  hub.sendSessionEnd(session.id);
  hub.close();
  server.close();
  await launch.afterExit?.();
  process.exitCode = exitCode === 0 ? 0 : 1;
}

function claudeDenial(reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function claudeApproval(reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason,
    },
  };
}

function isCodexTurnActive(thread: CodexThreadRead): boolean {
  const status = thread.thread.status;
  if (typeof status === "string")
    return status !== "idle" && status !== "completed";
  if (status?.type && status.type !== "idle") return true;
  return thread.thread.turns.some(
    (turn) => turn.status === "inProgress" || turn.status === "running",
  );
}

async function reportUnhandledStartupFailure(error: unknown): Promise<void> {
  const callbackBase =
    process.env.TILLER_PLAN_WRITER_CALLBACK_BASE?.trim().replace(/\/+$/u, "");
  const token = process.env.TILLER_PLAN_WRITER_TOKEN?.trim();
  if (!callbackBase || !token) return;
  const message = `Plan Writer startup failed: ${error instanceof Error ? error.message : String(error)}`;
  await fetch(`${callbackBase}/stop`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tiller-Plan-Writer-Token": token,
      ...cfTransportHeaders,
    },
    body: JSON.stringify({ reason: "runtime_ended", startupError: message }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

main().catch(async (error) => {
  clearStartupDeadline();
  console.error(
    `[plan-writer] ${error instanceof Error ? error.stack || error.message : String(error)}`,
  );
  await reportUnhandledStartupFailure(error);
  process.exitCode = 1;
});
