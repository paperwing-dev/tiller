import type { ChildProcess } from "node:child_process";

export const DIRECT_CHILD_DEADLINE_MS = 60 * 60_000;
export const DIRECT_CHILD_STATUS_POLL_MS = 15_000;
export const DIRECT_CHILD_KILL_GRACE_MS = 5_000;

export type DirectChildOutcome =
  | { kind: "completed"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "cancelled" }
  | { kind: "timed_out" }
  | { kind: "spawn_failed"; error: Error };

interface DirectChildSupervisorOptions {
  spawnChild: () => ChildProcess;
  isCancelled: () => Promise<boolean>;
  onSpawn?: (child: ChildProcess) => void;
  deadlineMs?: number;
  statusPollMs?: number;
  killGraceMs?: number;
  killChild?: (child: ChildProcess, signal: NodeJS.Signals) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function killDirectChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
}

export async function superviseDirectChild(
  options: DirectChildSupervisorOptions,
): Promise<DirectChildOutcome> {
  const deadlineMs = options.deadlineMs ?? DIRECT_CHILD_DEADLINE_MS;
  const statusPollMs = options.statusPollMs ?? DIRECT_CHILD_STATUS_POLL_MS;
  const killGraceMs = options.killGraceMs ?? DIRECT_CHILD_KILL_GRACE_MS;
  const killChild = options.killChild ?? killDirectChild;

  return await new Promise<DirectChildOutcome>((resolve) => {
    let child: ChildProcess | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let statusPollTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let terminationOutcome: Extract<DirectChildOutcome, { kind: "cancelled" | "timed_out" | "spawn_failed" }> | null = null;
    let pollInFlight = false;
    let settled = false;
    let closed = false;

    const clearTimers = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (statusPollTimer) clearInterval(statusPollTimer);
      if (killTimer) clearTimeout(killTimer);
      deadlineTimer = null;
      statusPollTimer = null;
      killTimer = null;
    };

    const settle = (outcome: DirectChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(outcome);
    };

    const requestTermination = (
      outcome: Extract<DirectChildOutcome, { kind: "cancelled" | "timed_out" | "spawn_failed" }>,
    ) => {
      if (!child || closed || settled || terminationOutcome) return;
      terminationOutcome = outcome;
      killChild(child, "SIGTERM");
      if (closed || settled) return;
      killTimer = setTimeout(() => {
        if (!child || closed || settled) return;
        killChild(child, "SIGKILL");
      }, killGraceMs);
      killTimer.unref();
    };

    // The wall-clock deadline starts immediately before the spawn attempt, so
    // process creation time is included in the bounded run.
    deadlineTimer = setTimeout(() => requestTermination({ kind: "timed_out" }), deadlineMs);
    deadlineTimer.unref();

    try {
      child = options.spawnChild();
    } catch (error) {
      settle({ kind: "spawn_failed", error: asError(error) });
      return;
    }

    child.once("error", (error) => {
      if (terminationOutcome) return;
      settle({ kind: "spawn_failed", error: asError(error) });
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      clearTimers();
      if (terminationOutcome) {
        settle(terminationOutcome);
      } else {
        settle({ kind: "completed", exitCode, signal });
      }
    });

    try {
      options.onSpawn?.(child);
    } catch (error) {
      requestTermination({ kind: "spawn_failed", error: asError(error) });
      return;
    }
    if (closed || settled) return;

    statusPollTimer = setInterval(() => {
      if (pollInFlight || terminationOutcome || closed || settled) return;
      pollInFlight = true;
      void options.isCancelled()
        .then((cancelled) => {
          if (cancelled) requestTermination({ kind: "cancelled" });
        })
        .catch(() => {
          // A transient callback failure is not a cancellation signal.
        })
        .finally(() => {
          pollInFlight = false;
        });
    }, statusPollMs);
    statusPollTimer.unref();
  });
}
