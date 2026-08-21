#!/usr/bin/env node
import { request } from "node:http";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
}

function post(socketPath: string, path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: "POST", headers: { "Content-Type": "application/json" } }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => response.statusCode && response.statusCode < 300
        ? resolve(responseBody)
        : reject(new Error(responseBody || `Supervisor returned ${response.statusCode}`)));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function main(): Promise<void> {
  const socketPath = process.env.TILLER_PLAN_WRITER_SOCKET?.trim() ?? "";
  if (!socketPath) throw new Error("TILLER_PLAN_WRITER_SOCKET is required");
  const body = await readStdin();
  const response = await post(socketPath, "/claude-hook", body || "{}");
  process.stdout.write(response || "{}");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
