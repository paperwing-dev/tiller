import http from "node:http";
import { REPO_PLAN_MCP_ATTEMPT_TIMEOUT_MS } from "./repo-plans.js";

export interface SupervisorResponse {
  status: number;
  body: unknown;
}

export type RepoPlanCommand =
  | { operation: "list" }
  | { operation: "read"; planId: string }
  | { operation: "create"; requestId: string; markdown: string }
  | {
      operation: "update";
      planId: string;
      expectedVersion: number;
      markdown: string;
    };

function requestOnce(
  socketPath: string,
  command: RepoPlanCommand,
  attemptTimeoutMs: number,
): Promise<SupervisorResponse> {
  const rawBody = JSON.stringify(command);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = http.request(
      {
        socketPath,
        path: "/repo-plans",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody),
        },
        signal: AbortSignal.timeout(attemptTimeoutMs),
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("error", (error) => settle(reject, error));
        response.on("aborted", () =>
          settle(
            reject,
            new Error("The Plan Writer supervisor response was aborted."),
          ),
        );
        response.on("close", () => {
          if (!response.complete) {
            settle(
              reject,
              new Error(
                "The Plan Writer supervisor response closed prematurely.",
              ),
            );
          }
        });
        response.on("end", () => {
          try {
            settle(resolve, {
              status: response.statusCode ?? 500,
              body: raw ? JSON.parse(raw) : {},
            });
          } catch (error) {
            settle(
              reject,
              error instanceof Error
                ? new Error(
                    `The Plan Writer supervisor returned invalid JSON: ${error.message}`,
                  )
                : new Error(
                    "The Plan Writer supervisor returned invalid JSON.",
                  ),
            );
          }
        });
      },
    );
    request.on("error", (error) => settle(reject, error));
    request.end(rawBody);
  });
}

export async function requestRepoPlanSupervisor(
  socketPath: string,
  command: RepoPlanCommand,
  options: { attemptTimeoutMs?: number } = {},
): Promise<SupervisorResponse> {
  const attemptTimeoutMs =
    options.attemptTimeoutMs ?? REPO_PLAN_MCP_ATTEMPT_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await requestOnce(
        socketPath,
        command,
        attemptTimeoutMs,
      );
      if (response.status < 500 || attempt === 2) return response;
      lastError = new Error(`Supervisor returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    }
  }
  throw lastError;
}
