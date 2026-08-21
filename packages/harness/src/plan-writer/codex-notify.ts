#!/usr/bin/env node
import { request } from "node:http";

async function main(): Promise<void> {
  const socketPath = process.env.TILLER_PLAN_WRITER_SOCKET?.trim() ?? "";
  if (!socketPath) throw new Error("TILLER_PLAN_WRITER_SOCKET is required");
  const raw = process.argv[process.argv.length - 1] ?? "{}";
  await new Promise<void>((resolve, reject) => {
    const req = request({ socketPath, path: "/codex-notify", method: "POST", headers: { "Content-Type": "application/json" } }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode && response.statusCode < 300
        ? resolve()
        : reject(new Error(`Supervisor returned ${response.statusCode}`)));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
