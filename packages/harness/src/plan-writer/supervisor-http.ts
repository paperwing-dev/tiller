import type { IncomingMessage, ServerResponse } from "node:http";
import { REPO_PLAN_COMMAND_PROXY_TIMEOUT_MS } from "./repo-plans.js";

export const MAX_PLAN_WRITER_LOCAL_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_REPO_PLAN_COMMAND_BODY_BYTES = 8 * 1024 * 1024;

export async function readPlanWriterLocalBody(
  request: IncomingMessage,
  maxBytes = MAX_PLAN_WRITER_LOCAL_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      request.destroy();
    };
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        fail(new Error("Plan Writer local request body is too large"));
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(body);
    });
    request.on("error", fail);
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export function isRepoPlanCommandRequest(
  request: Pick<IncomingMessage, "method" | "url">,
): boolean {
  return request.method === "POST" && request.url === "/repo-plans";
}

export function planWriterStoppingError(
  request: Pick<IncomingMessage, "method" | "url">,
): { error: string; code?: "source_inactive" } {
  return {
    error: "This Plan Writer generation is stopping.",
    ...(isRepoPlanCommandRequest(request)
      ? { code: "source_inactive" as const }
      : {}),
  };
}

/** Proxy the one capability-gated repository-plan command endpoint. */
export async function proxyRepoPlanCommand(input: {
  request: IncomingMessage;
  response: ServerResponse;
  enabled: boolean;
  callbackBase: string;
  token: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!input.enabled || !isRepoPlanCommandRequest(input.request)) {
    return false;
  }
  let rawBody: string;
  try {
    rawBody = await readPlanWriterLocalBody(
      input.request,
      MAX_REPO_PLAN_COMMAND_BODY_BYTES,
    );
  } catch {
    json(input.response, 413, {
      error: "Repository-plan command body is too large.",
      code: "invalid_request",
    });
    return true;
  }
  try {
    const signal = input.signal
      ? AbortSignal.any([
          input.signal,
          AbortSignal.timeout(REPO_PLAN_COMMAND_PROXY_TIMEOUT_MS),
        ])
      : AbortSignal.timeout(REPO_PLAN_COMMAND_PROXY_TIMEOUT_MS);
    const hubResponse = await fetch(`${input.callbackBase}/repo-plans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Tiller-Plan-Writer-Token": input.token,
        ...(input.headers ?? {}),
      },
      body: rawBody,
      signal,
    });
    const responseBody = await hubResponse.text();
    input.response.writeHead(hubResponse.status, {
      "Content-Type":
        hubResponse.headers.get("Content-Type") ?? "application/json",
    });
    input.response.end(responseBody);
  } catch (error) {
    json(input.response, 503, {
      error: error instanceof Error ? error.message : "Hub request failed.",
      code: "source_inactive",
    });
  }
  return true;
}
