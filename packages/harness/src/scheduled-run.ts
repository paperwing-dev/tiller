import {
  reportLifecycleEventWithRetry,
  type LifecycleReportResult,
} from "./lifecycle-reporter.js";
import { buildStartupPlanDocument } from "./launch-config.js";

export function buildScheduledRunReplacementPrompt(planText: string): string {
  return [
    "You are replacing an agent process that exited before this Scheduled Run finished.",
    "Inspect the existing workspace first and continue the saved work instead of starting over.",
    "Implement and verify the same approved startup plan below.",
    "Only when implementation and verification are complete, run `tiller-plan complete`.",
    "",
    "Approved startup plan:",
    buildStartupPlanDocument(planText),
  ].join("\n");
}

export function shouldArmScheduledRunIdleTimer(
  startCause: string,
  promptDelivered: boolean,
): boolean {
  return startCause === "scheduled" && promptDelivered;
}

export function reportScheduledRunIdleWithRetry(options: {
  repoSlug: string;
  lifecycleOpId: string;
  shouldAbort?: () => boolean;
  onLog?: (message: string) => void;
}): Promise<LifecycleReportResult> {
  return reportLifecycleEventWithRetry({
    ...options,
    endpoint: "scheduled-run/idle",
    label: "Scheduled Run idle report",
  });
}

export function reportPlanExecutionCompleteWithRetry(options: {
  repoSlug: string;
  lifecycleOpId: string;
  shouldAbort?: () => boolean;
  onLog?: (message: string) => void;
}): Promise<LifecycleReportResult> {
  return reportLifecycleEventWithRetry({
    ...options,
    endpoint: "plan-execution/complete",
    label: "plan completion",
  });
}
