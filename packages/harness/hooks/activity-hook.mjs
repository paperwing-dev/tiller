#!/usr/bin/env node
import http from "node:http";

const state = process.argv[2];
const socketPath = process.env.TILLER_HARNESS_CONTROL_SOCKET;
const generation = process.env.TILLER_ACTIVITY_GENERATION;

// Drain provider hook input before responding so the parent never races a
// short-lived child against a pending stdin write.
for await (const _chunk of process.stdin) {
  // The activity signal is fully described by argv + the launch generation.
}

if ((state !== "working" && state !== "idle" && state !== "completed") || !socketPath || !generation) {
  console.error("[tiller-activity-hook] activity control is unavailable");
  process.exit(1);
}

const body = JSON.stringify({ state, generation });
const accepted = await new Promise((resolve) => {
  const request = http.request({
    socketPath,
    path: "/activity",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, (response) => {
    let responseBody = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { responseBody += chunk; });
    response.on("end", () => {
      try {
        const parsed = JSON.parse(responseBody);
        resolve(response.statusCode === 200 && parsed.ok === true && parsed.accepted === true);
      } catch {
        resolve(false);
      }
    });
  });
  request.setTimeout(1_500, () => request.destroy(new Error("activity control timed out")));
  request.on("error", () => resolve(false));
  request.end(body);
});

if (!accepted) {
  console.error("[tiller-activity-hook] activity signal was not accepted");
  process.exit(1);
}

// Stop hooks accept an empty JSON object without changing provider behavior.
process.stdout.write("{}");
