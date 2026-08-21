import type { Harness } from "./harness.js";

const OPENCODE_ENTER_KEY = "\r";
const SUBMITTED_TEXT_ENTER_DELAY_MS = 10;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const UNSAFE_TERMINAL_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

function encodeSubmittedText(harness: Harness, data: string): string {
  if (harness !== "codex") return data;

  // Codex treats a rapid raw write as a paste burst and suppresses Enter while
  // that burst is active. An explicit bracketed-paste boundary makes the
  // following Enter a submission without relying on a timing delay.
  const sanitized = data
    .replaceAll(BRACKETED_PASTE_END, "")
    .replace(UNSAFE_TERMINAL_CONTROLS, "");
  return `${BRACKETED_PASTE_START}${sanitized}${BRACKETED_PASTE_END}`;
}

function splitOpenCodeInput(data: string): string[] {
  if (!data) return [];

  // Preserve raw control/key sequences that are already encoded for the TUI.
  if (data.includes("\x1b")) {
    return [data];
  }

  if (data === "\r" || data === "\n" || data === "\r\n") {
    return [OPENCODE_ENTER_KEY];
  }

  let submit = false;
  let body = data;

  if (body.endsWith("\r\n")) {
    submit = true;
    body = body.slice(0, -2);
  } else if (body.endsWith("\r") || body.endsWith("\n")) {
    submit = true;
    body = body.slice(0, -1);
  }

  body = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = body ? [body] : [];
  if (submit) parts.push(OPENCODE_ENTER_KEY);
  return parts;
}

function splitCodexSubmittedInput(data: string): string[] {
  const suffix = `${BRACKETED_PASTE_END}\r`;
  if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(suffix)) {
    return data ? [data] : [];
  }

  const body = data.slice(BRACKETED_PASTE_START.length, -suffix.length);
  if (body.includes(BRACKETED_PASTE_START) || body.includes(BRACKETED_PASTE_END)) {
    return [data];
  }

  return [data.slice(0, -1), "\r"];
}

export function splitHarnessInput(harness: Harness, data: string): string[] {
  if (harness === "opencode") {
    return splitOpenCodeInput(data);
  }

  if (harness === "codex") {
    return splitCodexSubmittedInput(data);
  }

  return data ? [data] : [];
}

export function harnessInputFragments(
  harness: Harness,
  data: string,
): Array<{ data: string; delayMs: number }> {
  return splitHarnessInput(harness, data)
    .filter((part) => part.length > 0)
    .map((part, index) => ({
      data: part,
      delayMs: index === 0 ? 0 : SUBMITTED_TEXT_ENTER_DELAY_MS,
    }));
}

export function normalizeHarnessInput(harness: Harness, data: string): string {
  return splitHarnessInput(harness, data).join("");
}

export interface HarnessInputTarget {
  writeInput(
    fragments: Array<{ data: string; delayMs: number }>,
    dimensions?: { cols: number; rows: number },
  ): void | Promise<void>;
  abortInput(): void | Promise<void>;
}

export type HarnessInputResult = { ok: true } | { ok: false; error: string };

export interface HarnessInputWriterOptions {
  onComplete?: (result: HarnessInputResult) => void;
  dimensions?: { cols: number; rows: number };
}

export interface HarnessInputActivityController {
  deliverInput(operation: () => void | Promise<void>): Promise<void>;
}

interface InputJob {
  onComplete?: HarnessInputWriterOptions["onComplete"];
  completed: boolean;
}

export class HarnessInputWriter {
  private jobs = new Set<InputJob>();
  private drainWaiters = new Set<() => void>();

  constructor(
    private readonly harness: Harness,
    private readonly getTarget: () => HarnessInputTarget | null,
    private readonly activityController?: HarnessInputActivityController,
  ) {}

  enqueue(data: string, options: HarnessInputWriterOptions = {}): void {
    this.enqueueFragments(harnessInputFragments(this.harness, data), options);
  }

  enqueueSubmittedText(data: string, options: HarnessInputWriterOptions = {}): void {
    this.enqueueFragments([
      ...(data ? [{ data: encodeSubmittedText(this.harness, data), delayMs: 0 }] : []),
      { data: "\r", delayMs: SUBMITTED_TEXT_ENTER_DELAY_MS },
    ], options);
  }

  private enqueueFragments(
    fragments: Array<{ data: string; delayMs: number }>,
    options: HarnessInputWriterOptions,
  ): void {
    const job: InputJob = {
      ...(options.onComplete ? { onComplete: options.onComplete } : {}),
      completed: false,
    };

    if (fragments.length === 0) {
      queueMicrotask(() => this.finishJob(job, { ok: true }));
      return;
    }

    this.jobs.add(job);
    try {
      const deliver = () => {
        const target = this.getTarget();
        if (!target) throw new Error("No active PTY");
        return target.writeInput(fragments, options.dimensions);
      };
      const result = this.activityController
        ? this.activityController.deliverInput(deliver)
        : deliver();
      void Promise.resolve(result).then(
        () => {
          this.jobs.delete(job);
          this.finishJob(job, { ok: true });
        },
        (error) => {
          this.jobs.delete(job);
          this.finishJob(job, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    } catch (error) {
      this.jobs.delete(job);
      this.finishJob(job, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Priority path: fail pending input ACKs before the abort ACK, while the
  // authoritative terminal queue invalidates fragments and writes Ctrl+C.
  abort(options: HarnessInputWriterOptions = {}): void {
    for (const job of this.jobs) {
      this.finishJob(job, { ok: false, error: "Aborted" });
    }
    this.jobs.clear();
    this.resolveDrainWaiters();

    try {
      const deliver = () => {
        const target = this.getTarget();
        if (!target) throw new Error("No active PTY");
        return target.abortInput();
      };
      const result = this.activityController
        ? this.activityController.deliverInput(deliver)
        : deliver();
      if (result && typeof (result as Promise<void>).then === "function") {
        void Promise.resolve(result).then(
          () => options.onComplete?.({ ok: true }),
          (error) => options.onComplete?.({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        options.onComplete?.({ ok: true });
      }
    } catch (err) {
      options.onComplete?.({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Waits until every input accepted before a Stop fence has settled. */
  drain(): Promise<void> {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.add(resolve));
  }

  /** Graceful Stop path after input has been fenced by the controller. */
  async abortForStop(): Promise<void> {
    await this.drain();
    const target = this.getTarget();
    if (!target) return;
    await target.abortInput();
  }

  private finishJob(job: InputJob, result: HarnessInputResult): void {
    if (job.completed) return;
    job.completed = true;
    job.onComplete?.(result);
    if (this.jobs.size === 0) this.resolveDrainWaiters();
  }

  private resolveDrainWaiters(): void {
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}
