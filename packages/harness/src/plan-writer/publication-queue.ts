/**
 * Serializes publications while giving each one a single absolute deadline
 * that starts before it waits in the queue.
 */
export const PLAN_WRITER_PUBLICATION_DEADLINE_MS = 120_000;

export class PlanWriterPublicationQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly generationSignal: AbortSignal,
    private readonly deadlineMs = PLAN_WRITER_PUBLICATION_DEADLINE_MS,
  ) {}

  enqueue(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = AbortSignal.any([
      this.generationSignal,
      AbortSignal.timeout(this.deadlineMs),
    ]);
    const queued = this.tail.then(async () => {
      signal.throwIfAborted();
      await operation(signal);
    });
    this.tail = queued.catch(() => undefined);

    return new Promise<void>((resolve, reject) => {
      const onAbort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Plan publication deadline expired."),
        );
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      void queued.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
