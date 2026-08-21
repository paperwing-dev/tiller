export const CLI_RECOVERY_PAGE_SIZE = 1000;
export const CLI_COLD_PAGE_SIZE = 200;
export const CLI_MAX_PENDING_MESSAGES = 4096;
export const CLI_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const CLI_RECOVERY_DEADLINE_MS = 15_000;
export const CLI_RECOVERY_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

export interface CliDurableMessage {
  id: string;
  sessionId: string;
  seq: number;
  content: unknown;
  localId?: string;
}

export type CliRecoveryFault =
  | "collision"
  | "overflow"
  | "deadline"
  | "non_progress"
  | "fetch_failed";

export type CliRecoveryState = "recovering" | "ready" | "fault";

export interface CliTerminalRecoveryFetchOptions {
  limit: number;
  afterSeq?: number;
  maxBytes: number;
  signal: AbortSignal;
  onBytes(receivedBytes: number): void;
}

export class CliTerminalRecoveryOverflowError extends Error {
  constructor() {
    super("terminal_recovery_overflow");
    this.name = "CliTerminalRecoveryOverflowError";
  }
}

interface Pending {
  message: CliDurableMessage;
  fingerprint: string;
  bytes: number;
}

interface CliTerminalRecoveryFetchRequest {
  limit: number;
  afterSeq?: number;
}

export interface CliTerminalRecoveryOptions {
  sessionId: string;
  fetchPage(options: CliTerminalRecoveryFetchOptions): Promise<CliDurableMessage[]>;
  write(message: CliDurableMessage): Promise<void>;
  onSequenceComplete(seq: number): void;
  onStateChange(state: CliRecoveryState, fault?: CliRecoveryFault): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxMessages?: number;
  maxBytes?: number;
  deadlineMs?: number;
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const normalized = normalize((candidate as Record<string, unknown>)[key]);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function fingerprint(message: CliDurableMessage): string {
  return stableJson({
    id: message.id,
    sessionId: message.sessionId,
    seq: message.seq,
    content: message.content,
    localId: message.localId ?? null,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readJsonResponseWithinLimit(
  response: Response,
  maxBytes: number,
  onBytes: (receivedBytes: number) => void,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CliTerminalRecoveryOverflowError();
  }

  if (!response.body) {
    const text = await response.text();
    const receivedBytes = Buffer.byteLength(text);
    if (receivedBytes > maxBytes) throw new CliTerminalRecoveryOverflowError();
    onBytes(receivedBytes);
    return JSON.parse(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CliTerminalRecoveryOverflowError();
      }
      onBytes(totalBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(payload));
}

export class CliTerminalRecovery {
  private readonly bySeq = new Map<number, Pending>();
  private readonly seqById = new Map<string, number>();
  private bytes = 0;
  private fetchReservedBytes = 0;
  private fetchReservedMessages = 0;
  private activeFetchAbort: AbortController | null = null;
  private lastCompletedSeq = 0;
  private baselineKnown = false;
  private state: CliRecoveryState = "recovering";
  private faultCode: CliRecoveryFault | undefined;
  private fetching = false;
  private draining = false;
  private recoveryRequested = false;
  private disposed = false;
  private generation = 0;
  private deadlineAt = 0;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CliTerminalRecoveryOptions) {
    options.onStateChange(this.state);
  }

  get recoveryState(): CliRecoveryState {
    return this.state;
  }

  get recoveryFault(): CliRecoveryFault | undefined {
    return this.faultCode;
  }

  get lastSeq(): number {
    return this.lastCompletedSeq;
  }

  get pendingCount(): number {
    return this.bySeq.size;
  }

  async startCold(): Promise<void> {
    const generation = this.begin(0, false, true);
    const request = this.createFetchRequest(CLI_COLD_PAGE_SIZE);
    if (!request) return;
    const page = await this.fetchWithRetry(request, generation);
    if (!page || !this.current(generation)) return;
    if (page.length > request.limit) {
      this.fail("overflow");
      return;
    }
    this.releaseFetchReservation();
    const ordered = [...page].sort((left, right) => left.seq - right.seq);
    this.lastCompletedSeq = ordered.length > 0 ? Math.max(0, ordered[0].seq - 1) : 0;
    this.baselineKnown = true;
    this.discardBaseline();
    for (const message of ordered) if (!this.accept(message)) return;
    this.fetching = false;
    await this.drain(generation, false);
  }

  recover(): void {
    if (this.disposed || this.state === "fault" || !this.baselineKnown || this.fetching) return;
    if (this.draining) {
      this.recoveryRequested = true;
      if (this.state !== "recovering") {
        this.state = "recovering";
        this.faultCode = undefined;
        this.options.onStateChange("recovering");
        this.armDeadline(this.generation, true);
      }
      return;
    }
    const preserveDeadline = this.state === "recovering" && this.deadlineTimer !== null;
    const generation = this.begin(this.lastCompletedSeq, true, false, preserveDeadline);
    void this.fetchForward(this.lastCompletedSeq, generation);
  }

  acceptLive(message: CliDurableMessage): void {
    if (this.disposed || this.state === "fault" || message.sessionId !== this.options.sessionId) return;
    if (this.baselineKnown && message.seq <= this.lastCompletedSeq) return;
    if (!this.accept(message) || !this.baselineKnown || this.fetching) return;
    if (!this.draining && message.seq > this.lastCompletedSeq + 1) {
      this.recover();
      return;
    }
    void this.drain(this.generation, false);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.abortActiveFetch();
    this.clearDeadline();
    this.clearPending();
  }

  private begin(baseline: number, known: boolean, clear: boolean, preserveDeadline = false): number {
    this.abortActiveFetch();
    this.generation += 1;
    if (clear) this.clearPending();
    this.lastCompletedSeq = baseline;
    this.baselineKnown = known;
    this.fetching = true;
    this.recoveryRequested = false;
    const notifyRecovering = this.state !== "recovering";
    this.state = "recovering";
    this.faultCode = undefined;
    if (notifyRecovering) this.options.onStateChange("recovering");
    const generation = this.generation;
    this.armDeadline(generation, !preserveDeadline);
    return generation;
  }

  private armDeadline(generation: number, resetDeadline: boolean): void {
    const now = (this.options.now ?? Date.now)();
    if (resetDeadline) {
      this.deadlineAt = now + (this.options.deadlineMs ?? CLI_RECOVERY_DEADLINE_MS);
    }
    this.clearDeadline();
    this.deadlineTimer = setTimeout(() => {
      if (this.current(generation) && this.state === "recovering") this.fail("deadline");
    }, Math.max(0, this.deadlineAt - now));
  }

  private accept(message: CliDurableMessage): boolean {
    if (
      message.sessionId !== this.options.sessionId ||
      !message.id ||
      !Number.isInteger(message.seq) ||
      message.seq < 1
    ) {
      this.fail("collision");
      return false;
    }
    if (this.baselineKnown && message.seq <= this.lastCompletedSeq) return true;
    const digest = fingerprint(message);
    const bySequence = this.bySeq.get(message.seq);
    if (bySequence) {
      if (bySequence.fingerprint !== digest) this.fail("collision");
      return bySequence.fingerprint === digest;
    }
    const knownSeq = this.seqById.get(message.id);
    if (knownSeq !== undefined) {
      const byId = this.bySeq.get(knownSeq);
      if (!byId || byId.fingerprint !== digest) this.fail("collision");
      return byId?.fingerprint === digest;
    }
    const payloadBytes = Buffer.byteLength(digest);
    if (
      this.bySeq.size + this.fetchReservedMessages + 1 >
        (this.options.maxMessages ?? CLI_MAX_PENDING_MESSAGES) ||
      this.bytes + this.fetchReservedBytes + payloadBytes >
        (this.options.maxBytes ?? CLI_MAX_PENDING_BYTES)
    ) {
      this.fail("overflow");
      return false;
    }
    this.bySeq.set(message.seq, { message, fingerprint: digest, bytes: payloadBytes });
    this.seqById.set(message.id, message.seq);
    this.bytes += payloadBytes;
    return true;
  }

  private async fetchForward(cursor: number, generation: number): Promise<void> {
    let nextCursor = cursor;
    while (this.current(generation)) {
      const request = this.createFetchRequest(CLI_RECOVERY_PAGE_SIZE, nextCursor);
      if (!request) return;
      const page = await this.fetchWithRetry(request, generation);
      if (!page || !this.current(generation)) return;
      if (page.length > request.limit) {
        this.fail("overflow");
        return;
      }
      this.releaseFetchReservation();
      const ordered = [...page].sort((left, right) => left.seq - right.seq);
      const advanced = ordered.reduce((max, message) => Math.max(max, message.seq), nextCursor);
      if (ordered.length > 0 && advanced <= nextCursor) {
        this.fail("non_progress");
        return;
      }
      for (const message of ordered) if (!this.accept(message)) return;
      if (ordered.length < request.limit) break;
      nextCursor = advanced;
    }
    if (!this.current(generation)) return;
    this.fetching = false;
    if (this.bySeq.size > 0 && !this.bySeq.has(this.lastCompletedSeq + 1)) {
      this.fail("non_progress");
      return;
    }
    void this.drain(generation, true);
  }

  private async fetchWithRetry(
    request: CliTerminalRecoveryFetchRequest,
    generation: number,
  ): Promise<CliDurableMessage[] | null> {
    this.fetchReservedMessages = request.limit;
    let attempt = 0;
    while (this.current(generation)) {
      if (this.expired()) {
        this.fail("deadline");
        return null;
      }
      const remainingBytes = (this.options.maxBytes ?? CLI_MAX_PENDING_BYTES) - this.bytes;
      if (remainingBytes <= 0) {
        this.fail("overflow");
        return null;
      }
      this.fetchReservedBytes = 0;
      const abortController = new AbortController();
      this.activeFetchAbort = abortController;
      try {
        const page = await this.options.fetchPage({
          ...request,
          maxBytes: remainingBytes,
          signal: abortController.signal,
          onBytes: (receivedBytes) => this.reserveFetchBytes(receivedBytes, generation),
        });
        if (this.activeFetchAbort === abortController) this.activeFetchAbort = null;
        if (this.expired()) {
          this.fail("deadline");
          return null;
        }
        return page;
      } catch (error) {
        if (this.activeFetchAbort === abortController) this.activeFetchAbort = null;
        this.fetchReservedBytes = 0;
        if (!this.current(generation)) return null;
        if (error instanceof CliTerminalRecoveryOverflowError) {
          this.fail("overflow");
          return null;
        }
        const delayMs = CLI_RECOVERY_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined) {
          this.fail("fetch_failed");
          return null;
        }
        attempt += 1;
        if ((this.options.now ?? Date.now)() + delayMs >= this.deadlineAt) {
          this.fail("deadline");
          return null;
        }
        await (this.options.sleep ?? sleep)(delayMs);
      }
    }
    return null;
  }

  private createFetchRequest(
    pageSize: number,
    afterSeq?: number,
  ): CliTerminalRecoveryFetchRequest | null {
    const remainingMessages = (this.options.maxMessages ?? CLI_MAX_PENDING_MESSAGES) - this.bySeq.size;
    const remainingBytes = (this.options.maxBytes ?? CLI_MAX_PENDING_BYTES) - this.bytes;
    if (remainingMessages <= 0 || remainingBytes <= 0) {
      this.fail("overflow");
      return null;
    }
    return {
      limit: Math.min(pageSize, remainingMessages),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    };
  }

  private reserveFetchBytes(receivedBytes: number, generation: number): void {
    if (
      !this.current(generation) ||
      !Number.isInteger(receivedBytes) ||
      receivedBytes < this.fetchReservedBytes ||
      this.bytes + receivedBytes > (this.options.maxBytes ?? CLI_MAX_PENDING_BYTES)
    ) {
      throw new CliTerminalRecoveryOverflowError();
    }
    this.fetchReservedBytes = receivedBytes;
  }

  private releaseFetchReservation(): void {
    this.fetchReservedBytes = 0;
    this.fetchReservedMessages = 0;
  }

  private abortActiveFetch(): void {
    const active = this.activeFetchAbort;
    this.activeFetchAbort = null;
    active?.abort();
    this.releaseFetchReservation();
  }

  private async drain(generation: number, fetchedForward: boolean): Promise<void> {
    if (!this.current(generation) || this.draining || this.fetching) return;
    this.draining = true;
    try {
      while (this.current(generation)) {
        const pending = this.bySeq.get(this.lastCompletedSeq + 1);
        if (!pending) break;
        await this.options.write(pending.message);
        if (!this.current(generation)) return;
        if (this.expired() && this.state === "recovering") {
          this.fail("deadline");
          return;
        }
        this.bySeq.delete(pending.message.seq);
        this.seqById.delete(pending.message.id);
        this.bytes -= pending.bytes;
        this.lastCompletedSeq = pending.message.seq;
        this.options.onSequenceComplete(this.lastCompletedSeq);
      }
    } catch {
      this.fail("non_progress");
      return;
    } finally {
      this.draining = false;
    }
    if (!this.current(generation)) return;
    if (this.recoveryRequested) {
      this.recoveryRequested = false;
      this.recover();
      return;
    }
    if (this.bySeq.size > 0) {
      if (fetchedForward) this.fail("non_progress");
      else this.recover();
      return;
    }
    this.fetching = false;
    this.recoveryRequested = false;
    this.clearDeadline();
    this.state = "ready";
    this.options.onStateChange("ready");
  }

  private fail(code: CliRecoveryFault): void {
    if (this.disposed || this.state === "fault") return;
    this.generation += 1;
    this.fetching = false;
    this.recoveryRequested = false;
    this.abortActiveFetch();
    this.clearDeadline();
    this.state = "fault";
    this.faultCode = code;
    this.options.onStateChange("fault", code);
  }

  private discardBaseline(): void {
    for (const [seq, pending] of this.bySeq) {
      if (seq > this.lastCompletedSeq) continue;
      this.bySeq.delete(seq);
      this.seqById.delete(pending.message.id);
      this.bytes -= pending.bytes;
    }
  }

  private clearPending(): void {
    this.bySeq.clear();
    this.seqById.clear();
    this.bytes = 0;
    this.releaseFetchReservation();
  }

  private expired(): boolean {
    return (this.options.now ?? Date.now)() >= this.deadlineAt;
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.state !== "fault";
  }

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}

/** Wait for both the stdout callback and drain when Node reports backpressure. */
export function writeStdoutWithBackpressure(data: string): Promise<void> {
  if (!data) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let callbackComplete = false;
    let drainComplete = true;
    let settled = false;
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      process.stdout.removeListener("error", onError);
      reject(error);
    };
    const finish = () => {
      if (!settled && callbackComplete && drainComplete) {
        settled = true;
        process.stdout.removeListener("error", onError);
        resolve();
      }
    };
    try {
      process.stdout.once("error", onError);
      const accepted = process.stdout.write(data, () => {
        callbackComplete = true;
        finish();
      });
      if (!accepted) {
        drainComplete = false;
        process.stdout.once("drain", () => {
          drainComplete = true;
          finish();
        });
      }
    } catch (error) {
      process.stdout.removeListener("error", onError);
      reject(error);
    }
  });
}
