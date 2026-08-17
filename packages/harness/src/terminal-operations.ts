import HeadlessPackage from "@xterm/headless";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import { CursorPositionDsrFilter } from "./vt-dsr-filter.js";

const CPR_PATTERN = /\x1b\[(?:\?)?[1-9][0-9]*;[1-9][0-9]*R/g;

export const MAX_PARSER_ITEM_BYTES = 64 * 1024;
export const PARSER_PAUSE_BYTES = 8 * 1024 * 1024;
export const PARSER_RESUME_BYTES = 4 * 1024 * 1024;
export const DSR_DEADLINE_MS = 2_000;

export function parseWhitelistedCprReplies(reply: string): string[] {
  const matches = [...reply.matchAll(CPR_PATTERN)].map((match) => match[0]);
  return matches.join("") === reply ? matches : [];
}

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalInputFragment {
  data: string;
  delayMs: number;
}

export interface TerminalOperationTarget {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pauseOutput?(): void;
  resumeOutput?(): void;
}

export interface TerminalOperationHooks {
  onFilteredOutput(data: string): void;
  onHeadlessParse?: (durationMs: number, bytes: number) => void;
  onInputWrite?: (durationMs: number, bytes: number) => void;
  onQueueDepth?: (depth: number) => void;
  onParserBacklog?: (bytes: number, items: number) => void;
  createHeadless?: (options: { cols: number; rows: number; scrollback: number }) => HeadlessTerminalType;
}

type Waiter = { resolve: () => void; reject: (error: Error) => void };

type ControlOperation =
  | { type: "dsr-barrier"; completion: Promise<string[]> }
  | {
      type: "input";
      fragments: TerminalInputFragment[];
      dimensions?: TerminalDimensions;
      abortGeneration: number;
      enqueuedAt: number;
      waiter: Waiter;
    }
  | {
      type: "resize";
      dimensions: TerminalDimensions;
      waiters: Waiter[];
    };

interface ParserCompletion {
  promise: Promise<string[]>;
  resolve(replies: string[]): void;
  reject(error: Error): void;
}

type ParserOperation =
  | {
      type: "output";
      data: string;
      bytes: number;
      expectedReplies: number;
      completion?: ParserCompletion;
    }
  | {
      type: "resize";
      dimensions: TerminalDimensions;
      bytes: 0;
      completion?: never;
    };

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

function abortedError(): Error {
  return new Error("Aborted");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function parserFaultError(cause: unknown): Error {
  const message = asError(cause).message || "unknown parser failure";
  return new Error(
    `Terminal protocol fault: ${message}. Input and resize are disabled; abort remains available. Restart the terminal session to recover.`,
  );
}

function deferredParserCompletion(): ParserCompletion {
  let resolve!: (replies: string[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string[]>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  // Most parser items do not need a control barrier. Keep their rejection
  // observed while retaining the same promise for DSR barriers that do.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Split by UTF-8 size without bisecting a valid UTF-16 surrogate pair. */
export function splitParserItems(value: string): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index) ?? value.charCodeAt(index);
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const nextBytes = utf8CodePointBytes(codePoint);
    if (bytes > 0 && bytes + nextBytes > MAX_PARSER_ITEM_BYTES) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += nextBytes;
    index += codeUnits;
  }
  chunks.push(value.slice(start));
  return chunks;
}

/**
 * PTY controls and headless parsing use separate serial lanes. Only an output
 * item that removed a cursor-position request inserts a control-lane barrier.
 */
export class TerminalOperationQueue {
  private readonly headless: HeadlessTerminalType;
  private readonly filter = new CursorPositionDsrFilter();
  private readonly controls: ControlOperation[] = [];
  private readonly parser: ParserOperation[] = [];
  private activeGeneratedReplies: string[] | null = null;
  private controlDraining = false;
  private parserDraining = false;
  private abortGeneration = 0;
  private closed = false;
  private dimensions: TerminalDimensions;
  private parserBytes = 0;
  private outputPaused = false;
  private protocolFault: Error | null = null;

  constructor(
    private readonly target: TerminalOperationTarget,
    initialDimensions: TerminalDimensions,
    private readonly hooks: TerminalOperationHooks,
  ) {
    this.dimensions = { ...initialDimensions };
    this.headless = hooks.createHeadless?.({ ...initialDimensions, scrollback: 0 })
      ?? new HeadlessPackage.Terminal({ ...initialDimensions, scrollback: 0 });
    this.headless.onData((reply) => {
      if (!this.activeGeneratedReplies || !reply) return;
      this.activeGeneratedReplies.push(...parseWhitelistedCprReplies(reply));
      // All non-CPR headless-generated replies are intentionally discarded.
    });
  }

  enqueueOutput(output: string): void {
    if (this.closed || output.length === 0) return;
    let filteredOutput = "";
    const barriers: ControlOperation[] = [];
    for (const chunk of splitParserItems(output)) {
      const filtered = this.filter.pushWithReport(chunk);
      filteredOutput += filtered.output;
      if (this.protocolFault) continue;
      const completion = this.enqueueParserOutput(chunk, filtered.removedCount);
      if (completion) {
        barriers.push({ type: "dsr-barrier", completion });
      }
    }

    // CPR is causally required by the PTY event just observed. Put its
    // barriers ahead of normal controls that have not started yet.
    if (barriers.length > 0) {
      let barrierIndex = 0;
      while (this.controls[barrierIndex]?.type === "dsr-barrier") barrierIndex += 1;
      this.controls.splice(barrierIndex, 0, ...barriers);
    }

    // A listener may enqueue controls reentrantly. At this point every parser
    // item and DSR barrier for the PTY event is already visible to both lanes.
    if (filteredOutput) this.hooks.onFilteredOutput(filteredOutput);
    this.reportQueueUsage();
    void this.drainControls();
  }

  enqueueInput(
    fragments: TerminalInputFragment[],
    dimensions?: TerminalDimensions,
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("PTY closed"));
    if (this.protocolFault) return Promise.reject(this.protocolFault);
    return new Promise((resolve, reject) => {
      this.controls.push({
        type: "input",
        fragments: fragments.filter((fragment) => fragment.data.length > 0),
        ...(dimensions ? { dimensions } : {}),
        abortGeneration: this.abortGeneration,
        enqueuedAt: performance.now(),
        waiter: { resolve, reject },
      });
      this.reportQueueUsage();
      void this.drainControls();
    });
  }

  enqueueResize(cols: number, rows: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error("PTY closed"));
    if (this.protocolFault) return Promise.reject(this.protocolFault);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const last = this.controls[this.controls.length - 1];
      if (last?.type === "resize") {
        last.dimensions = { cols, rows };
        last.waiters.push(waiter);
      } else {
        this.controls.push({
          type: "resize",
          dimensions: { cols, rows },
          waiters: [waiter],
        });
      }
      this.reportQueueUsage();
      void this.drainControls();
    });
  }

  /** Priority boundary: invalidate pending input and write Ctrl+C immediately. */
  abort(): void {
    if (this.closed) throw new Error("PTY closed");
    this.abortGeneration += 1;
    this.target.write("\x03");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const trailing = this.filter.end();
    if (trailing) this.hooks.onFilteredOutput(trailing);
    await this.whenIdle();
    this.closed = true;
    if (this.outputPaused) {
      this.outputPaused = false;
      this.target.resumeOutput?.();
    }
    this.headless.dispose();
  }

  whenIdle(): Promise<void> {
    if (
      !this.controlDraining &&
      !this.parserDraining &&
      this.controls.length === 0 &&
      this.parser.length === 0
    ) return Promise.resolve();
    return new Promise((resolve) => {
      const poll = () => {
        if (
          !this.controlDraining &&
          !this.parserDraining &&
          this.controls.length === 0 &&
          this.parser.length === 0
        ) resolve();
        else setTimeout(poll, 0);
      };
      poll();
    });
  }

  private enqueueParserOutput(data: string, expectedReplies: number): Promise<string[]> | undefined {
    const completion = expectedReplies > 0 ? deferredParserCompletion() : undefined;
    const bytes = Buffer.byteLength(data);
    this.parser.push({
      type: "output",
      data,
      bytes,
      expectedReplies,
      ...(completion ? { completion } : {}),
    });
    this.parserBytes += bytes;
    this.applyParserBackpressure();
    this.reportQueueUsage();
    void this.drainParser();
    return completion?.promise;
  }

  private enqueueHeadlessResize(dimensions: TerminalDimensions): void {
    this.parser.push({ type: "resize", dimensions: { ...dimensions }, bytes: 0 });
    this.reportQueueUsage();
    void this.drainParser();
  }

  private writeHeadless(output: string, deadline: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = deadline
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`cursor-position response timed out after ${DSR_DEADLINE_MS}ms`));
          }, DSR_DEADLINE_MS)
        : null;
      const complete = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      try {
        this.headless.write(output, complete);
      } catch (error) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(asError(error));
      }
    });
  }

  private async drainParser(): Promise<void> {
    if (this.parserDraining || this.protocolFault) return;
    this.parserDraining = true;
    try {
      while (this.parser.length > 0 && !this.protocolFault) {
        const operation = this.parser.shift();
        if (!operation) break;
        try {
          if (operation.type === "resize") {
            this.headless.resize(operation.dimensions.cols, operation.dimensions.rows);
            continue;
          }

          const replies: string[] = [];
          this.activeGeneratedReplies = replies;
          const parseStartedAt = performance.now();
          await this.writeHeadless(operation.data, operation.expectedReplies > 0);
          this.hooks.onHeadlessParse?.(
            performance.now() - parseStartedAt,
            operation.bytes,
          );
          if (replies.length !== operation.expectedReplies) {
            throw new Error(
              `cursor-position reply mismatch (expected ${operation.expectedReplies}, received ${replies.length})`,
            );
          }
          operation.completion?.resolve(replies);
        } catch (error) {
          const fault = this.enterProtocolFault(error);
          operation.completion?.reject(fault);
        } finally {
          this.activeGeneratedReplies = null;
          this.parserBytes = Math.max(0, this.parserBytes - operation.bytes);
          this.applyParserBackpressure();
          this.reportQueueUsage();
        }
      }
    } finally {
      this.parserDraining = false;
      if (this.parser.length > 0 && !this.protocolFault) void this.drainParser();
    }
  }

  private async drainControls(): Promise<void> {
    if (this.controlDraining) return;
    this.controlDraining = true;
    try {
      while (this.controls.length > 0) {
        const operation = this.controls.shift();
        if (!operation) break;
        this.reportQueueUsage();

        if (operation.type === "dsr-barrier") {
          await this.applyDsrBarrier(operation);
          continue;
        }

        if (this.protocolFault) {
          this.rejectControl(operation, this.protocolFault);
          continue;
        }

        if (operation.type === "resize") {
          try {
            this.applyResize(operation.dimensions);
            for (const waiter of operation.waiters) waiter.resolve();
          } catch (error) {
            const failure = asError(error);
            for (const waiter of operation.waiters) waiter.reject(failure);
          }
          continue;
        }

        try {
          if (operation.abortGeneration !== this.abortGeneration) throw abortedError();
          if (operation.dimensions) this.applyResize(operation.dimensions);
          let recordedWrite = false;
          for (const fragment of operation.fragments) {
            if (fragment.delayMs > 0) await delay(fragment.delayMs);
            if (this.controls[0]?.type === "dsr-barrier") {
              await this.drainLeadingDsrBarriers();
            }
            if (operation.abortGeneration !== this.abortGeneration) throw abortedError();
            if (this.protocolFault) throw this.protocolFault;
            this.target.write(fragment.data);
            if (!recordedWrite) {
              recordedWrite = true;
              this.hooks.onInputWrite?.(
                performance.now() - operation.enqueuedAt,
                Buffer.byteLength(fragment.data),
              );
            }
          }
          operation.waiter.resolve();
        } catch (error) {
          operation.waiter.reject(asError(error));
        }
      }
    } finally {
      this.controlDraining = false;
      if (this.controls.length > 0) void this.drainControls();
    }
  }

  private applyResize(dimensions: TerminalDimensions): void {
    if (
      this.dimensions.cols === dimensions.cols &&
      this.dimensions.rows === dimensions.rows
    ) return;
    // The marker is appended before the real resize. Any output event observed
    // synchronously from resize is therefore appended after the marker.
    this.enqueueHeadlessResize(dimensions);
    this.target.resize(dimensions.cols, dimensions.rows);
    this.dimensions = { ...dimensions };
  }

  private async applyDsrBarrier(
    operation: Extract<ControlOperation, { type: "dsr-barrier" }>,
  ): Promise<void> {
    try {
      const replies = await operation.completion;
      for (const reply of replies) this.target.write(reply);
    } catch (error) {
      this.enterProtocolFault(error);
    }
  }

  private async drainLeadingDsrBarriers(): Promise<void> {
    while (this.controls[0]?.type === "dsr-barrier") {
      const barrier = this.controls.shift();
      if (!barrier || barrier.type !== "dsr-barrier") return;
      this.reportQueueUsage();
      await this.applyDsrBarrier(barrier);
      if (this.protocolFault) throw this.protocolFault;
    }
  }

  private rejectControl(
    operation: Exclude<ControlOperation, { type: "dsr-barrier" }>,
    error: Error,
  ): void {
    if (operation.type === "input") operation.waiter.reject(error);
    else for (const waiter of operation.waiters) waiter.reject(error);
  }

  private enterProtocolFault(cause: unknown): Error {
    if (this.protocolFault) return this.protocolFault;
    const fault = parserFaultError(cause);
    this.protocolFault = fault;
    for (const operation of this.parser.splice(0)) {
      this.parserBytes = Math.max(0, this.parserBytes - operation.bytes);
      operation.completion?.reject(fault);
    }
    this.applyParserBackpressure();
    this.reportQueueUsage();
    return fault;
  }

  private applyParserBackpressure(): void {
    if (!this.outputPaused && this.parserBytes >= PARSER_PAUSE_BYTES) {
      this.outputPaused = true;
      this.target.pauseOutput?.();
    } else if (this.outputPaused && this.parserBytes < PARSER_RESUME_BYTES) {
      this.outputPaused = false;
      this.target.resumeOutput?.();
    }
  }

  private reportQueueUsage(): void {
    this.hooks.onQueueDepth?.(this.controls.length + this.parser.length);
    this.hooks.onParserBacklog?.(this.parserBytes, this.parser.length);
  }
}
