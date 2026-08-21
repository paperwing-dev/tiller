import { hubControlHeaders } from "./config.js";
import { parseManagedLocalRunnerImageSourceId } from "./managed-runner-image.js";

export interface HostReleaseInfo {
  schemaVersion: 1;
  channel: "development" | "release";
  hubVersion: string;
  releaseId?: string;
  selfHostRuntimeImage?: string;
}

export interface HostUpdateCheckResult {
  kind: "installer-managed" | "unmanaged";
  currentRelease: HostReleaseInfo;
  errors?: Array<{ code: string; message: string }>;
}

function resolveSelfHostRuntimeImage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Malformed Hub release info response: `currentRelease.selfHostRuntimeImage` must be present.");
  }
  const image = value.trim();
  const imageDigest = parseManagedLocalRunnerImageSourceId(image);
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? "")) {
    throw new Error(
      "Malformed Hub release info response: `currentRelease.selfHostRuntimeImage` must be "
      + "docker.io/jamieatlason/tiller-sandbox@sha256:<64-character lowercase digest>.",
    );
  }
  return image;
}

export function resolveHostUpdateTargetImage(currentRelease: HostReleaseInfo): string {
  return resolveSelfHostRuntimeImage(currentRelease.selfHostRuntimeImage);
}

export async function fetchHostUpdateCheck(
  hubUrl: string,
  headers: Record<string, string> = hubControlHeaders,
): Promise<HostUpdateCheckResult> {
  const response = await fetch(`${hubUrl}/api/update/check`, {
    headers: { Accept: "application/json", ...headers },
  });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    : { error: `HTTP ${response.status}` };
  if (response.status === 401 || response.status === 403 || !contentType.includes("application/json")) {
    throw new Error(
      "The saved Hub service credential is invalid. Run "
      + "`tiller host setup --hub-url https://<exact-host>.workers.dev`.",
    );
  }
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${response.status}`;
    throw new Error(`Failed to check Hub release info: ${message}`);
  }
  if (
    typeof body !== "object"
    || body === null
    || !("currentRelease" in body)
    || typeof body.currentRelease !== "object"
    || body.currentRelease === null
    || !("selfHostRuntimeImage" in body.currentRelease)
  ) {
    throw new Error("Malformed Hub release info response.");
  }
  return body as HostUpdateCheckResult;
}
