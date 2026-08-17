export interface TerminalMetricSummary {
  label: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  operationsPerSecond: number;
  bytes: number;
  maxQueueDepth: number;
  maxParserBacklogBytes: number;
  userCpuMicros: number;
  systemCpuMicros: number;
}
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export class TerminalMetricRecorder {
  private readonly samples = new Map<string, number[]>();
  private readonly bytes = new Map<string, number>();
  private maxQueueDepth = 0;
  private maxParserBacklogBytes = 0;
  private windowStartedAt = performance.now();
  private cpuStartedAt = process.cpuUsage();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly enabled = process.env.TILLER_TERMINAL_METRICS === "1") {}

  record(label: string, durationMs: number, bytes = 0): void {
    if (!this.enabled) return;
    const samples = this.samples.get(label) ?? [];
    samples.push(Math.max(0, durationMs));
    this.samples.set(label, samples);
    this.bytes.set(label, (this.bytes.get(label) ?? 0) + Math.max(0, bytes));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 30_000);
    }
    if (durationMs >= 100) {
      console.error("[tiller] slow terminal metric", JSON.stringify({ label, durationMs, bytes }));
    }
    const sampleCount = [...this.samples.values()].reduce((sum, values) => sum + values.length, 0);
    if (sampleCount >= 64 || performance.now() - this.windowStartedAt >= 30_000) {
      this.flush();
    }
  }

  observeQueueDepth(depth: number): void {
    if (this.enabled) this.maxQueueDepth = Math.max(this.maxQueueDepth, depth);
  }

  observeParserBacklog(bytes: number): void {
    if (this.enabled) this.maxParserBacklogBytes = Math.max(this.maxParserBacklogBytes, bytes);
  }

  flush(): TerminalMetricSummary[] {
    if (!this.enabled) return [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const now = performance.now();
    const elapsedSeconds = Math.max(0.001, (now - this.windowStartedAt) / 1000);
    const cpu = process.cpuUsage(this.cpuStartedAt);
    const summaries: TerminalMetricSummary[] = [];
    for (const [label, values] of this.samples) {
      const sorted = [...values].sort((left, right) => left - right);
      summaries.push({
        label,
        count: sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        p99Ms: percentile(sorted, 0.99),
        operationsPerSecond: sorted.length / elapsedSeconds,
        bytes: this.bytes.get(label) ?? 0,
        maxQueueDepth: this.maxQueueDepth,
        maxParserBacklogBytes: this.maxParserBacklogBytes,
        userCpuMicros: cpu.user,
        systemCpuMicros: cpu.system,
      });
    }
    if (summaries.length > 0) console.error("[tiller] terminal metrics", JSON.stringify(summaries));
    this.samples.clear();
    this.bytes.clear();
    this.maxQueueDepth = 0;
    this.maxParserBacklogBytes = 0;
    this.windowStartedAt = now;
    this.cpuStartedAt = process.cpuUsage();
    return summaries;
  }
}
