import { environmentRuntimeHeaders, HUB_URL } from "./config.js";

export type LifecycleReportResult = "accepted" | "rejected" | "aborted";

export interface ReportLifecycleEventWithRetryOptions {
  repoSlug: string;
  lifecycleOpId: string;
  endpoint: string;
  label: string;
  body?: unknown;
  hubUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  retryDelaysMs?: number[];
  acceptedStatuses?: number[];
  signal?: AbortSignal;
  shouldAbort?: () => boolean;
  onLog?: (message: string) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

function isAborted(options: ReportLifecycleEventWithRetryOptions): boolean {
  return options.signal?.aborted === true || options.shouldAbort?.() === true;
}

function waitForRetry(
  delayMs: number,
  options: ReportLifecycleEventWithRetryOptions,
): Promise<boolean> {
  if (isAborted(options)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(!isAborted(options)), Math.max(0, delayMs));
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function reportLifecycleEventWithRetry(
  options: ReportLifecycleEventWithRetryOptions,
): Promise<LifecycleReportResult> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const fetchImpl = options.fetch ?? fetch;
  let attempt = 0;
  while (!isAborted(options)) {
    try {
      const timeoutSignal = AbortSignal.timeout(5_000);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetchImpl(
        `${options.hubUrl ?? HUB_URL}/api/envs/${encodeURIComponent(options.repoSlug)}/${options.endpoint}`,
        {
          method: "POST",
          headers: {
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            "X-Tiller-Lifecycle-Op-Id": options.lifecycleOpId,
            ...environmentRuntimeHeaders,
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal,
        },
      );
      const accepted = options.acceptedStatuses
        ? options.acceptedStatuses.includes(response.status)
        : response.ok;
      if (accepted) {
        options.onLog?.(`${options.label} accepted`);
        return "accepted";
      }
      const retryable = response.status === 408
        || response.status === 425
        || response.status === 429
        || response.status >= 500;
      if (!retryable) {
        const detail = (await response.text().catch(() => "")).trim();
        options.onLog?.(
          `${options.label} permanently rejected: ${detail || `HTTP ${response.status}`}`,
        );
        return "rejected";
      }
      options.onLog?.(`${options.label} failed with HTTP ${response.status}; retrying`);
    } catch (error) {
      if (isAborted(options)) return "aborted";
      options.onLog?.(
        `${options.label} failed: ${error instanceof Error ? error.message : String(error)}; retrying`,
      );
    }
    const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 60_000;
    attempt += 1;
    if (!await waitForRetry(delay, options)) return "aborted";
  }
  return "aborted";
}
