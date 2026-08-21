import { HUB_URL, cfTransportHeaders, environmentRuntimeHeaders } from "./config.js";

const REPO_SLUG = process.env.REPO_SLUG || "";
const START_OP_ID = process.env.TILLER_LIFECYCLE_START_OP_ID || "";

type StartupDiagnosticStepId =
  | "workspace-sync"
  | "stop-control"
  | "prereq-check"
  | "harness-launch"
  | "hub-connect"
  | "runner-ready"
  | "startup-failed";

type StartupDiagnosticSeverity = "info" | "warn" | "error";

async function postStartupDiagnostics(payload: unknown): Promise<void> {
  if (!HUB_URL || !REPO_SLUG || !START_OP_ID) return;
  try {
    await fetch(`${HUB_URL}/api/envs/${REPO_SLUG}/startup-diagnostics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tiller-Lifecycle-Op-Id": START_OP_ID,
        ...environmentRuntimeHeaders,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget — don't let reporting failures break startup
  }
}

export async function reportBootProgress(
  msg: string,
  options?: {
    stepId?: StartupDiagnosticStepId;
    severity?: StartupDiagnosticSeverity;
    detail?: string | null;
  },
): Promise<void> {
  await postStartupDiagnostics({
    type: "event",
    stepId: options?.stepId ?? "harness-launch",
    severity: options?.severity ?? "info",
    message: msg,
    ...(options?.detail ? { detail: options.detail } : {}),
  });
}

export async function reportRunnerReady(): Promise<void> {
  await postStartupDiagnostics({
    type: "event",
    stepId: "runner-ready",
    severity: "info",
    message: "Harness runtime is ready",
  });
  if (!HUB_URL || !REPO_SLUG) return;
  const response = await fetch(`${HUB_URL}/api/envs/${REPO_SLUG}/runner-ready`, {
    method: "POST",
    headers: {
      ...environmentRuntimeHeaders,
      ...(START_OP_ID ? { "X-Tiller-Lifecycle-Op-Id": START_OP_ID } : {}),
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(detail || `HTTP ${response.status}`);
  }
}

export interface RuntimeSessionParams {
  id?: string;
  tag: string;
  cwd: string;
  host: string;
  platform: string;
  team?: string;
}

export async function createRuntimeSession(params: RuntimeSessionParams): Promise<{ id: string; tag: string }> {
  const res = await fetch(`${HUB_URL}/api/envs/${encodeURIComponent(REPO_SLUG)}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...environmentRuntimeHeaders,
    },
    body: JSON.stringify({
      ...(params.id ? { id: params.id } : {}),
      tag: params.tag,
      cwd: params.cwd,
      host: params.host,
      platform: params.platform,
      ...(params.team ? { team: params.team } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as { id: string; tag: string };
}

export interface PlanWriterSessionParams {
  id: string;
  tag: string;
  machineId: string;
  metadata: {
    cwd: string;
    host: string;
    platform: string;
    harness: string;
    role: "plan-writer";
    terminalScope: {
      kind: "plan-writer";
      repoId: string;
      planArtifactId: string;
      generation: number;
    };
  };
}

export async function createPlanWriterSession(
  params: PlanWriterSessionParams,
  token: string,
): Promise<{ id: string; tag: string }> {
  const res = await fetch(`${HUB_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Tiller-Plan-Writer-Token": token,
      ...cfTransportHeaders,
    },
    body: JSON.stringify({
      id: params.id,
      tag: params.tag,
      machine_id: params.machineId,
      metadata: params.metadata,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return (await res.json()) as { id: string; tag: string };
}
