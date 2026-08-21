import type { PlanWriterContext, PublicationCursor } from "./contract.js";
import { normalizePlanMarkdown, sha256Hex } from "./context.js";

export interface FrozenPlanPublication {
  providerConversationId: string;
  sequence: number;
  providerEventId: string;
  markdown: string;
  bodyDigest: string;
}

export interface PublicationPostResult {
  status: number;
  cursor?: PublicationCursor;
  error?: string;
}

interface PublicationCoordinatorDependencies {
  initialCursor?: PublicationCursor | null;
  post(payload: FrozenPlanPublication, signal: AbortSignal): Promise<PublicationPostResult>;
  readContext(signal: AbortSignal): Promise<PlanWriterContext>;
  refreshManagedContext(signal: AbortSignal): Promise<void>;
  recordSynchronizationError(error: string): Promise<void>;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  attemptTimeoutMs?: number;
}

const RETRY_DELAYS_MS = [1_000, 2_000] as const;
export const PLAN_PUBLICATION_ATTEMPT_TIMEOUT_MS = 120_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Publication aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
    function done() {
      cleanup();
      resolve();
    }
    function aborted() {
      cleanup();
      reject(signal.reason ?? new Error("Publication aborted"));
    }
  });
}

function cursorMatchesPublication(cursor: PublicationCursor | null | undefined, publication: FrozenPlanPublication): boolean {
  return Boolean(cursor
    && cursor.providerEventId === publication.providerEventId
    && cursor.bodyDigest === publication.bodyDigest);
}

function cursorConflict(cursor: PublicationCursor, publication: FrozenPlanPublication): boolean {
  return cursor.providerEventId === publication.providerEventId
    || cursor.sequence >= publication.sequence;
}

function cursorConflictError(cursor: PublicationCursor, publication: FrozenPlanPublication): string {
  return `Plan publication cursor conflict for ${publication.providerEventId}: canonical sequence ${cursor.sequence} identifies ${cursor.providerEventId} with digest ${cursor.bodyDigest}.`;
}

export class PlanPublicationCoordinator {
  private cursor: PublicationCursor | null;
  private latchedError: string | null = null;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly attemptTimeoutMs: number;

  constructor(private readonly dependencies: PublicationCoordinatorDependencies) {
    this.cursor = dependencies.initialCursor ?? null;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.attemptTimeoutMs = dependencies.attemptTimeoutMs ?? PLAN_PUBLICATION_ATTEMPT_TIMEOUT_MS;
  }

  get publicationCursor(): PublicationCursor | null {
    return this.cursor;
  }

  get lastProviderEventId(): string | undefined {
    return this.cursor?.providerEventId;
  }

  get synchronizationError(): string | null {
    return this.latchedError;
  }

  private async latch(error: string): Promise<never> {
    this.latchedError = error;
    await this.dependencies.recordSynchronizationError(error).catch(() => undefined);
    throw new Error(error);
  }

  private async confirm(
    cursor: PublicationCursor,
    publication: FrozenPlanPublication,
    signal: AbortSignal,
  ): Promise<void> {
    this.cursor = cursor;
    try {
      await this.dependencies.refreshManagedContext(signal);
    } catch (error) {
      await this.latch(
        `Plan publication ${publication.providerEventId} committed, but managed context refresh failed: ${errorText(error)}`,
      );
    }
  }

  private async postWithTimeout(
    publication: FrozenPlanPublication,
    signal: AbortSignal,
  ): Promise<PublicationPostResult> {
    const controller = new AbortController();
    const aborted = () => controller.abort(signal.reason ?? new Error("Publication aborted"));
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => {
      controller.abort(new Error(`Plan publication attempt timed out after ${this.attemptTimeoutMs}ms`));
    }, this.attemptTimeoutMs);
    try {
      return await this.dependencies.post(publication, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
    }
  }

  async publish(
    markdown: string,
    providerEventId: string,
    providerConversationId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.latchedError) {
      throw new Error(`Plan publication is latched after synchronization failure: ${this.latchedError}`);
    }
    const normalized = normalizePlanMarkdown(markdown);
    if (!normalized.trim()) throw new Error("Provider emitted an empty plan");
    const digest = sha256Hex(normalized);
    if (this.cursor?.providerEventId === providerEventId) {
      if (this.cursor.bodyDigest !== digest) {
        await this.latch(cursorConflictError(this.cursor, {
          providerConversationId,
          sequence: this.cursor.sequence,
          providerEventId,
          markdown: normalized,
          bodyDigest: digest,
        }));
      }
      await this.confirm(this.cursor, {
        providerConversationId,
        sequence: this.cursor.sequence,
        providerEventId,
        markdown: normalized,
        bodyDigest: digest,
      }, signal);
      return;
    }

    const publication: FrozenPlanPublication = {
      providerConversationId,
      sequence: (this.cursor?.sequence ?? 0) + 1,
      providerEventId,
      markdown: normalized,
      bodyDigest: digest,
    };
    let lastFailure = "publication result was not confirmed";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let retryableOrAmbiguous = false;
      try {
        const result = await this.postWithTimeout(publication, signal);
        if (result.status >= 200 && result.status < 300) {
          if (cursorMatchesPublication(result.cursor, publication)) {
            await this.confirm(result.cursor!, publication, signal);
            return;
          }
          if (result.cursor) {
            await this.latch(
              `Plan publication ${providerEventId} returned a conflicting cursor: sequence ${result.cursor.sequence} identifies ${result.cursor.providerEventId} with digest ${result.cursor.bodyDigest}.`,
            );
          }
          lastFailure = "Hub returned a successful response without the matching publication cursor";
          retryableOrAmbiguous = true;
        } else if (retryableStatus(result.status)) {
          lastFailure = `HTTP ${result.status}${result.error ? `: ${result.error}` : ""}`;
          retryableOrAmbiguous = true;
        } else {
          await this.latch(
            `Plan publication ${providerEventId} was rejected with HTTP ${result.status}${result.error ? `: ${result.error}` : ""}.`,
          );
        }
      } catch (error) {
        if (this.latchedError) throw error;
        lastFailure = `transport failure: ${errorText(error)}`;
        retryableOrAmbiguous = true;
      }

      if (!retryableOrAmbiguous) continue;
      try {
        const canonical = (await this.dependencies.readContext(signal)).writer.publicationCursor ?? null;
        if (cursorMatchesPublication(canonical, publication)) {
          await this.confirm(canonical!, publication, signal);
          return;
        }
        if (canonical && cursorConflict(canonical, publication)) {
          await this.latch(cursorConflictError(canonical, publication));
        }
      } catch (error) {
        if (this.latchedError) throw error;
        lastFailure = `${lastFailure}; canonical context refetch failed: ${errorText(error)}`;
      }

      if (attempt < RETRY_DELAYS_MS.length) {
        try {
          await this.sleep(RETRY_DELAYS_MS[attempt]!, signal);
        } catch (error) {
          lastFailure = `${lastFailure}; retry delay failed: ${errorText(error)}`;
          break;
        }
      }
    }

    await this.latch(
      `Plan publication ${providerEventId} could not be confirmed after at most three attempts: ${lastFailure}.`,
    );
  }
}
