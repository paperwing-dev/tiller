function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export interface RunnerReadyRetryOptions {
  attempts?: number;
  reportBootProgress?: (
    message: string,
    options?: {
      stepId?: "runner-ready";
      severity?: "warn";
    },
  ) => Promise<void>;
  onLog?: (message: string) => void;
  shouldAbort?: () => boolean;
  sleepFn?: (ms: number) => Promise<void>;
}

export async function reportRunnerReadyWithRetry(
  sendReady: () => Promise<void>,
  options: RunnerReadyRetryOptions = {},
): Promise<boolean> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const pause = options.sleepFn ?? sleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.shouldAbort?.()) {
      return false;
    }

    try {
      await sendReady();
      if (attempt > 1) {
        const message = `runner-ready callback succeeded after retry ${attempt}/${attempts}`;
        options.onLog?.(message);
        await options.reportBootProgress?.(`harness: ${message}`, { stepId: "runner-ready" });
      }
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const finalAttempt = attempt === attempts;
      const message = finalAttempt
        ? `runner-ready callback failed after ${attempts} attempts: ${detail}`
        : `runner-ready callback failed (${attempt}/${attempts}): ${detail}; retrying`;
      options.onLog?.(message);
      await options.reportBootProgress?.(`harness: ${message}`, {
        stepId: "runner-ready",
        severity: "warn",
      });
      if (!finalAttempt) {
        await pause(Math.min(1000 * attempt, 3000));
      }
    }
  }

  return false;
}
