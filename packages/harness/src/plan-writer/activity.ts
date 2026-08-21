interface PlanWriterActivity {
  lastMeaningfulActivityAt: number;
  turnActive: boolean;
  publicationActive: boolean;
  turnCyclePending: boolean;
  settledSequence: number;
}

export interface PlanWriterActivityControllerOptions {
  idleMs: number | null;
  now?: () => number;
  /** Return false for authoritative activity, or deferred when activity could not be determined. */
  onIdle: () => boolean | "deferred" | void | Promise<boolean | "deferred" | void>;
  /** Called once for each observed inactive -> active -> fully inactive turn. */
  onSettled?: (sequence: number) => void | Promise<void>;
}

export type PlanWriterTurnLifecycle = "started" | "settled" | "cancelled";

export interface PlanWriterSettlementRetryOptions {
  retryWindowMs?: number;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Reports one immutable settlement sequence. Only transport failures and 5xx
 * responses are retried; 204 accepts both a new record and a replay, while
 * 409 definitively fences stale generations or ordering.
 */
export async function reportPlanWriterSettlement(
  sequence: number,
  send: (sequence: number, signal: AbortSignal) => Promise<number>,
  options: PlanWriterSettlementRetryOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  const retryWindowMs = options.retryWindowMs ?? 5_000;
  const deadline = now() + retryWindowMs;
  let lastFailure: unknown = new Error("Plan Writer settlement was not accepted.");

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure));
    }
    let status: number;
    try {
      status = await send(sequence, AbortSignal.timeout(Math.max(1, remaining)));
    } catch (error) {
      lastFailure = error;
      const retryDelay = Math.min(250, Math.max(0, deadline - now()));
      if (retryDelay > 0) await sleep(retryDelay);
      continue;
    }
    if (status === 204 || status === 409) return;
    if (status < 500 || status > 599) {
      throw new Error(`Hub rejected Plan Writer settlement with HTTP ${status}.`);
    }
    lastFailure = new Error(`Hub returned HTTP ${status} while recording Plan Writer settlement.`);
    const retryDelay = Math.min(250, Math.max(0, deadline - now()));
    if (retryDelay <= 0) continue;
    await sleep(retryDelay);
  }
}

/**
 * Owns the supervisor's ordered lifecycle queue. Input already delivered to
 * the PTY runs before an idle decision queued after it; once shutdown begins,
 * later input is rejected by the supervisor.
 */
export class PlanWriterActivityController {
  private readonly now: () => number;
  private readonly state: PlanWriterActivity;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private idleTimingStarted = false;

  constructor(private readonly options: PlanWriterActivityControllerOptions) {
    this.now = options.now ?? Date.now;
    this.state = {
      lastMeaningfulActivityAt: this.now(),
      turnActive: false,
      publicationActive: false,
      turnCyclePending: false,
      settledSequence: 0,
    };
  }

  /** Start idle timing only once the native composer has produced output. */
  startIdleTiming(): void {
    if (this.closed || this.idleTimingStarted) return;
    this.idleTimingStarted = true;
    this.state.lastMeaningfulActivityAt = this.now();
    this.restartIdleTimer();
  }

  /**
   * Orders PTY delivery and its activity update as one lifecycle operation.
   * If this is queued before the idle decision, delivery wins and resets the
   * deadline; once shutdown starts, the delivery callback is never invoked.
   */
  deliverMeaningfulActivity(deliver: () => void | Promise<void>): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed) return false;
      await deliver();
      this.state.lastMeaningfulActivityAt = this.now();
      if (!this.state.turnActive && !this.state.publicationActive) this.restartIdleTimer();
      return true;
    });
  }

  handleTurnLifecycle(lifecycle: PlanWriterTurnLifecycle): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed) return false;
      if (lifecycle === "started") {
        if (!this.state.turnActive) this.state.turnCyclePending = true;
        this.state.turnActive = true;
        this.clearIdleTimer();
        return true;
      }
      this.state.turnActive = false;
      if (lifecycle === "cancelled") this.state.turnCyclePending = false;
      await this.completedSuspendingActivity();
      return true;
    });
  }

  setPublicationActive(active: boolean): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.closed) return false;
      this.state.publicationActive = active;
      if (active) this.clearIdleTimer();
      else await this.completedSuspendingActivity();
      return true;
    });
  }

  close(): Promise<void> {
    return this.enqueue(async () => {
      this.closed = true;
      this.clearIdleTimer();
    });
  }

  private async completedSuspendingActivity(): Promise<void> {
    if (this.state.turnActive || this.state.publicationActive) return;
    if (this.state.turnCyclePending) {
      this.state.turnCyclePending = false;
      const sequence = ++this.state.settledSequence;
      await this.options.onSettled?.(sequence);
    }
    this.state.lastMeaningfulActivityAt = this.now();
    this.restartIdleTimer();
  }

  private restartIdleTimer(): void {
    this.clearIdleTimer();
    const idleMs = this.options.idleMs;
    if (idleMs === null || !this.idleTimingStarted || this.closed || this.state.turnActive || this.state.publicationActive) return;
    const dueAt = this.state.lastMeaningfulActivityAt + idleMs;
    this.idleTimer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.closed || this.state.turnActive || this.state.publicationActive) return;
        const remaining = this.state.lastMeaningfulActivityAt + idleMs - this.now();
        if (remaining > 0) {
          this.restartIdleTimer();
          return;
        }
        this.closed = true;
        this.clearIdleTimer();
        const stopped = await this.options.onIdle();
        if (stopped === "deferred") {
          this.closed = false;
          this.state.lastMeaningfulActivityAt = this.now();
          this.restartIdleTimer();
          return;
        }
        if (stopped === false) {
          this.closed = false;
          if (!this.state.turnActive) this.state.turnCyclePending = true;
          this.state.turnActive = true;
          return;
        }
      });
    }, Math.max(0, dueAt - this.now()));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function deliverPlanWriterInput(
  activity: Pick<PlanWriterActivityController, "deliverMeaningfulActivity" | "handleTurnLifecycle">,
  data: string,
  deliver: () => void | Promise<void>,
): Promise<boolean> {
  if (!data.length) {
    await deliver();
    return true;
  }
  if (data.includes("\x03")) {
    await activity.handleTurnLifecycle("cancelled");
  }
  return await activity.deliverMeaningfulActivity(deliver);
}

export function planWriterTurnLifecycleForClaudeHook(event: string): PlanWriterTurnLifecycle | null {
  if (event === "UserPromptSubmit") return "started";
  if (event === "Stop" || event === "StopFailure") return "settled";
  return null;
}
