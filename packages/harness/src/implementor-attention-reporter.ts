import {
  reportLifecycleEventWithRetry,
  type LifecycleReportResult,
} from "./lifecycle-reporter.js";

export type ImplementorCompletionReportResult = LifecycleReportResult;

export interface ImplementorAttentionReporterOptions {
  repoSlug: string;
  lifecycleOpId: string;
  hubUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  retryDelaysMs?: number[];
  onLog?: (message: string) => void;
}

export class ImplementorAttentionReporter {
  private readonly abortController = new AbortController();
  private queueTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ImplementorAttentionReporterOptions) {}

  report(sequence: number): Promise<ImplementorCompletionReportResult> {
    if (this.closed) return Promise.resolve("aborted");
    const pending = this.queueTail.then(
      () => this.sendWithRetry(sequence),
      () => this.sendWithRetry(sequence),
    );
    this.queueTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.queueTail;
  }

  async abort(): Promise<void> {
    this.closed = true;
    this.abortController.abort();
    await this.queueTail;
  }

  private async sendWithRetry(sequence: number): Promise<ImplementorCompletionReportResult> {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return "rejected";
    return reportLifecycleEventWithRetry({
      repoSlug: this.options.repoSlug,
      lifecycleOpId: this.options.lifecycleOpId,
      endpoint: "implementor-attention/completions",
      label: `Implementor completion ${sequence}`,
      body: { sequence },
      acceptedStatuses: [204],
      hubUrl: this.options.hubUrl,
      headers: this.options.headers,
      fetch: this.options.fetch,
      retryDelaysMs: this.options.retryDelaysMs,
      signal: this.abortController.signal,
      onLog: this.options.onLog,
    });
  }
}
