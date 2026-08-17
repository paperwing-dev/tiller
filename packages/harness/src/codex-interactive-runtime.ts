#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import {
  CodexAppServerClient,
  createCodexAppServerSocketLease,
  sanitizeCodexChildEnvironment,
} from "./codex-app-server-client.js";
import { createCodexRuntimeAuthGetter } from "./codex-runtime-auth.js";
import { codexRuntimeExitCode } from "./harness-supervisor.js";
import { environmentRuntimeHeaders } from "./config.js";
import { splitCodexRemoteRuntimeArgs } from "./codex-config.js";
import {
  reportRuntimeDiagnostic,
  reportRuntimeActivity,
} from "./activity-reporter.js";
import { CodexActivityMonitor } from "./codex-activity-monitor.js";

async function main(): Promise<number> {
  const cwd = process.cwd();
  const runtimeArgs = splitCodexRemoteRuntimeArgs(process.argv.slice(2));
  const runtimeAuthUrl = process.env.TILLER_CODEX_RUNTIME_AUTH_URL?.trim() ?? "";
  const runtimeCapability = process.env.TILLER_RUNTIME_CAPABILITY?.trim() ?? "";
  if (Boolean(runtimeAuthUrl) !== Boolean(runtimeCapability)) {
    throw new Error(
      "TILLER_CODEX_RUNTIME_AUTH_URL and TILLER_RUNTIME_CAPABILITY must be provided together",
    );
  }
  const usesSubscriptionAuth = Boolean(runtimeAuthUrl && runtimeCapability);
  const socketLease = createCodexAppServerSocketLease("tiller-codex-runtime-");
  const childEnv = sanitizeCodexChildEnvironment(process.env, {
    authMode: usesSubscriptionAuth ? "subscription" : "api-key",
    githubRepoAccess: true,
  });
  const appServer = new CodexAppServerClient({
    socketPath: socketLease.socketPath,
    cwd,
    env: childEnv,
    ...(usesSubscriptionAuth
      ? {
          getAuth: createCodexRuntimeAuthGetter({
            url: runtimeAuthUrl,
            tokenHeader: "X-Tiller-Capability",
            token: runtimeCapability,
            headers: environmentRuntimeHeaders,
          }),
        }
      : {}),
    clientName: "tiller-implementor",
    appServerArgs: runtimeArgs.appServerArgs,
  });
  let tui: ChildProcess | null = null;
  let activityMonitor: CodexActivityMonitor | null = null;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    activityMonitor?.stop();
    if (tui && tui.exitCode === null) tui.kill("SIGTERM");
    await appServer.stop();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void stop(); });
  }
  try {
    await appServer.start();
    activityMonitor = new CodexActivityMonitor({
      client: appServer,
      onActivity: reportRuntimeActivity,
      onError: (error) => {
        console.error(
          `[tiller-codex-runtime] Activity subscription failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
      diagnosticSink: reportRuntimeDiagnostic,
    });
    appServer.on("notification", (method: string, params: unknown) => {
      activityMonitor?.handleNotification(method, params);
    });
    tui = spawn("codex", ["--remote", `unix://${socketLease.socketPath}`, ...runtimeArgs.tuiArgs], {
      cwd,
      env: childEnv,
      stdio: "inherit",
    });
    activityMonitor.start();
    const tuiExit = new Promise<number>((resolve) => {
      tui!.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
      tui!.once("error", () => resolve(1));
    });
    const appServerExit = appServer.closed.then((error) => ({ error }));
    const result = await Promise.race([
      tuiExit.then((code) => ({ code })),
      appServerExit,
    ]);
    if ("error" in result && result.error) {
      if (tui.exitCode === null) tui.kill("SIGTERM");
      console.error(`[tiller-codex-runtime] ${result.error.message}`);
      return codexRuntimeExitCode(result.error);
    }
    return "code" in result ? result.code : 0;
  } catch (error) {
    console.error(`[tiller-codex-runtime] ${error instanceof Error ? error.message : String(error)}`);
    return codexRuntimeExitCode(error);
  } finally {
    try {
      activityMonitor?.stop();
      await stop();
    } finally {
      socketLease.cleanup();
    }
  }
}

process.exitCode = await main();
