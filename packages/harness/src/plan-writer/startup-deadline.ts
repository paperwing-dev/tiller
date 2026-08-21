export function startPlanWriterStartupDeadline(
  timeoutMs: number,
  onExpired: () => void | Promise<void>,
): () => void {
  const timer = setTimeout(() => {
    void onExpired();
  }, timeoutMs);
  return () => clearTimeout(timer);
}
