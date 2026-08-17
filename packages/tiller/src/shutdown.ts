import type { ChildProcess } from "node:child_process";
import type http from "node:http";

const DEFAULT_CHILD_TERM_GRACE_MS = 2_000;
const DEFAULT_CHILD_KILL_GRACE_MS = 2_000;
const DEFAULT_HTTP_FORCE_CLOSE_MS = 1_000;
const DEFAULT_HTTP_RESOLVE_CLOSE_MS = 3_000;

function setShutdownTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timeout = setTimeout(callback, ms);
  if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
    timeout.unref();
  }
  return timeout;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function cleanupChildHandles(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
  child.unref();
}

function sendChildSignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) {
    return true;
  }
  if (timeoutMs <= 0) {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setShutdownTimeout(() => finish(childHasExited(child)), timeoutMs);

    child.once("exit", onExit);
    child.once("close", onExit);
    if (childHasExited(child)) {
      finish(true);
    }
  });
}

export async function stopChildProcess(
  child: ChildProcess | null,
  options: {
    signal?: NodeJS.Signals;
    termGraceMs?: number;
    killGraceMs?: number;
  } = {},
): Promise<void> {
  if (!child?.pid) return;

  const termGraceMs = options.termGraceMs ?? DEFAULT_CHILD_TERM_GRACE_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_CHILD_KILL_GRACE_MS;
  const signal = options.signal ?? "SIGTERM";

  if (!childHasExited(child) && !sendChildSignal(child, signal)) {
    cleanupChildHandles(child);
    return;
  }

  if (!await waitForChildExit(child, termGraceMs)) {
    if (!sendChildSignal(child, "SIGKILL")) {
      cleanupChildHandles(child);
      return;
    }
    await waitForChildExit(child, killGraceMs);
  }

  cleanupChildHandles(child);
}

export function closeHttpServer(
  server: http.Server,
  options: {
    forceAfterMs?: number;
    resolveAfterMs?: number;
  } = {},
): Promise<void> {
  const forceAfterMs = options.forceAfterMs ?? DEFAULT_HTTP_FORCE_CLOSE_MS;
  const resolveAfterMs = options.resolveAfterMs ?? DEFAULT_HTTP_RESOLVE_CLOSE_MS;

  return new Promise<void>((resolve) => {
    let settled = false;
    const forceClose = () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(resolveTimer);
      resolve();
    };

    const forceTimer = setShutdownTimeout(forceClose, forceAfterMs);
    const resolveTimer = setShutdownTimeout(() => {
      forceClose();
      finish();
    }, resolveAfterMs);

    server.close(() => finish());
    server.closeIdleConnections?.();
  });
}
