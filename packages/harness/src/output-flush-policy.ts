export const TINY_OUTPUT_BYTES = 256;
export const INTERACTIVE_IDLE_GAP_MS = 20;
export const BULK_OUTPUT_BYTES = 32 * 1024;
export const BULK_FLUSH_CANDIDATES_MS = [500, 250, 16, 8] as const;
export type BulkFlushWindowMs = (typeof BULK_FLUSH_CANDIDATES_MS)[number];
export const INPUT_ECHO_FLUSH_MS = 1;
export const INPUT_ECHO_WINDOW_MS = 100;

export function resolveBulkFlushWindow(value = process.env.TILLER_OUTPUT_FLUSH_MS): BulkFlushWindowMs {
  if (value === "500") return 500;
  if (value === "250") return 250;
  if (value === "8") return 8;
  if (value === "16") return 16;
  return 16;
}

/** Keep redraws responsive without multiplying durable terminal writes. */
export const BULK_FLUSH_MS = resolveBulkFlushWindow();
export const INTERACTIVE_FLUSH_MS = 8;
export const MAX_BUFFER_MS = BULK_FLUSH_MS;
export const MAX_BUFFER_BYTES = 65_536;

export interface OutputFlushPolicy {
  interactiveFlushMs: number;
  bulkFlushMs: number;
  bulkOutputBytes: number;
  maxBufferMs: number;
  maxBufferBytes: number;
  inputEchoFlushMs: number;
  inputEchoWindowMs: number;
}

export const DEFAULT_OUTPUT_FLUSH_POLICY: OutputFlushPolicy = {
  interactiveFlushMs: INTERACTIVE_FLUSH_MS,
  bulkFlushMs: BULK_FLUSH_MS,
  bulkOutputBytes: BULK_OUTPUT_BYTES,
  maxBufferMs: MAX_BUFFER_MS,
  maxBufferBytes: MAX_BUFFER_BYTES,
  inputEchoFlushMs: INPUT_ECHO_FLUSH_MS,
  inputEchoWindowMs: INPUT_ECHO_WINDOW_MS,
};

export interface OutputFlushPolicyInput {
  bufferBytes: number;
  chunkBytes: number;
  nowMs: number;
  bufferStartedAtMs: number;
  previousOutputAtMs: number | null;
  inputEchoActive?: boolean;
}

export type OutputFlushPolicyDecision =
  | { flushNow: true }
  | {
      flushNow: false;
      flushDelayMs: number;
    };

export function decideOutputFlush(
  input: OutputFlushPolicyInput,
  policy: OutputFlushPolicy = DEFAULT_OUTPUT_FLUSH_POLICY,
): OutputFlushPolicyDecision {
  const bufferAgeMs = input.nowMs - input.bufferStartedAtMs;
  if (
    input.bufferBytes >= policy.maxBufferBytes ||
    input.bufferBytes >= policy.bulkOutputBytes ||
    bufferAgeMs >= policy.maxBufferMs
  ) {
    return { flushNow: true };
  }

  const idleGapMs = input.previousOutputAtMs == null
    ? Infinity
    : input.nowMs - input.previousOutputAtMs;
  const isolatedOutput =
    input.bufferBytes === input.chunkBytes &&
    idleGapMs >= INTERACTIVE_IDLE_GAP_MS;

  const ordinaryDelayMs = isolatedOutput ? policy.interactiveFlushMs : policy.bulkFlushMs;
  const selectedDelayMs = input.inputEchoActive
    ? Math.min(ordinaryDelayMs, policy.inputEchoFlushMs)
    : ordinaryDelayMs;
  return {
    flushNow: false,
    flushDelayMs: Math.min(selectedDelayMs, policy.maxBufferMs),
  };
}
