import type { RuntimeActivityState } from "./activity-controller.js";

export interface HarnessActivityTransitionDiagnostic {
  component: "harness_activity";
  event: "activity_transition";
  generation: string | null;
  source:
    | "generation_started"
    | "provider_working"
    | "provider_idle"
    | "provider_completed"
    | "provider_exit"
    | "input_accepted";
  accepted: true;
  previous: RuntimeActivityState;
  current: RuntimeActivityState;
  timestamp: string;
}

const CODEX_LIFECYCLE_EVENTS = [
  "thread_started",
  "thread_classified",
  "turn_started",
  "turn_completed",
] as const;
export const CODEX_THREAD_STATUSES = [
  "active",
  "idle",
  "notLoaded",
  "systemError",
] as const;
export const CODEX_TURN_STATUSES = [
  "completed",
  "interrupted",
  "failed",
  "inProgress",
] as const;
const CODEX_LIFECYCLE_STATUSES = [
  ...CODEX_THREAD_STATUSES,
  ...CODEX_TURN_STATUSES,
  "unknown",
] as const;
const CODEX_THREAD_CLASSIFICATIONS = ["root", "child", "unknown", "invalid"] as const;
const CODEX_DIAGNOSTIC_ACTIVITIES = ["working", "idle", "completed", "ignored"] as const;
const CODEX_DIAGNOSTIC_SOURCES = ["notification", "discovery", "subscription"] as const;

type CodexLifecycleEvent = typeof CODEX_LIFECYCLE_EVENTS[number];
export type CodexLifecycleStatus = typeof CODEX_LIFECYCLE_STATUSES[number];
export type CodexThreadClassification = typeof CODEX_THREAD_CLASSIFICATIONS[number];
type CodexDiagnosticActivity = typeof CODEX_DIAGNOSTIC_ACTIVITIES[number];
export type CodexDiagnosticSource = typeof CODEX_DIAGNOSTIC_SOURCES[number];

export interface CodexLifecycleDiagnostic {
  component: "codex_lifecycle";
  event: CodexLifecycleEvent;
  threadId: string | null;
  parentThreadId?: string | null;
  turnId?: string | null;
  status: CodexLifecycleStatus;
  classification: CodexThreadClassification;
  activity: CodexDiagnosticActivity;
  source?: CodexDiagnosticSource;
  timestamp: string;
}

export type HarnessRuntimeDiagnostic =
  | HarnessActivityTransitionDiagnostic
  | CodexLifecycleDiagnostic;

export type HarnessDiagnosticSink = (diagnostic: HarnessRuntimeDiagnostic) => void;
export type CodexDiagnosticSink = (diagnostic: CodexLifecycleDiagnostic) => void;

function includesValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isDiagnosticId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDiagnosticTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

/** Reconstruct a lifecycle diagnostic from selected, validated fields only. */
export function parseCodexLifecycleDiagnostic(value: unknown): CodexLifecycleDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.component !== "codex_lifecycle"
    || !includesValue(CODEX_LIFECYCLE_EVENTS, candidate.event)
    || (candidate.threadId !== null && !isDiagnosticId(candidate.threadId))
    || !includesValue(CODEX_LIFECYCLE_STATUSES, candidate.status)
    || !includesValue(CODEX_THREAD_CLASSIFICATIONS, candidate.classification)
    || !includesValue(CODEX_DIAGNOSTIC_ACTIVITIES, candidate.activity)
    || !isDiagnosticTimestamp(candidate.timestamp)
  ) return null;
  if (
    "parentThreadId" in candidate
    && candidate.parentThreadId !== null
    && !isDiagnosticId(candidate.parentThreadId)
  ) return null;
  if (
    "turnId" in candidate
    && candidate.turnId !== null
    && !isDiagnosticId(candidate.turnId)
  ) return null;
  if (
    "source" in candidate
    && !includesValue(CODEX_DIAGNOSTIC_SOURCES, candidate.source)
  ) return null;

  return {
    component: "codex_lifecycle",
    event: candidate.event,
    threadId: candidate.threadId,
    ...(candidate.parentThreadId === null || isDiagnosticId(candidate.parentThreadId)
      ? { parentThreadId: candidate.parentThreadId }
      : {}),
    ...(candidate.turnId === null || isDiagnosticId(candidate.turnId)
      ? { turnId: candidate.turnId }
      : {}),
    status: candidate.status,
    classification: candidate.classification,
    activity: candidate.activity,
    ...(includesValue(CODEX_DIAGNOSTIC_SOURCES, candidate.source)
      ? { source: candidate.source }
      : {}),
    timestamp: candidate.timestamp,
  };
}

export function writeHarnessDiagnostic(diagnostic: HarnessRuntimeDiagnostic): void {
  console.error(JSON.stringify(diagnostic));
}
