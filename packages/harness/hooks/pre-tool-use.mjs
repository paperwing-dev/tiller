#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook — intercepts tool permissions and routes them
 * through the Tiller hub (Cloudflare Durable Object) for remote approval.
 *
 * Uses long-polling: each request blocks up to 25s, retries until resolved
 * or 5-minute total timeout (~12 requests max).
 */

const SESSION_ID = process.env.TILLER_SESSION_ID;
const ENV_SLUG = process.env.TILLER_ENV_SLUG;
const HUB_URL = process.env.TILLER_HUB_URL;
const CF_CLIENT_ID = process.env.TILLER_CF_CLIENT_ID;
const CF_CLIENT_SECRET = process.env.TILLER_CF_CLIENT_SECRET;
const RUNTIME_CAPABILITY = process.env.TILLER_RUNTIME_CAPABILITY;

// Not a tiller session — let Claude Code handle normally
if (!SESSION_ID || !ENV_SLUG || !HUB_URL) process.exit(0);

const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const headers = {
  "Content-Type": "application/json",
  ...(CF_CLIENT_ID && { "CF-Access-Client-Id": CF_CLIENT_ID }),
  ...(CF_CLIENT_SECRET && { "CF-Access-Client-Secret": CF_CLIENT_SECRET }),
  ...(RUNTIME_CAPABILITY && { "X-Tiller-Capability": RUNTIME_CAPABILITY }),
};
const sessionUrl = `${HUB_URL}/api/envs/${encodeURIComponent(ENV_SLUG)}/sessions/${encodeURIComponent(SESSION_ID)}`;

// SIGTERM handler: exit with code 2 to block the tool call
process.on("SIGTERM", () => process.exit(2));

async function main() {
  // Read hook input from stdin
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const hookInput = JSON.parse(input);

  const { tool_name, tool_input } = hookInput;

  // Check if tool is already session-allowed
  try {
    const sessionRes = await fetch(sessionUrl, { headers });
    if (sessionRes.ok) {
      const session = await sessionRes.json();
      const allowed = JSON.parse(session.allowed_tools || "[]");
      if (allowed.includes(tool_name)) {
        outputDecision("allow");
        return;
      }
    }
  } catch { /* continue to create permission */ }

  // Create permission request
  const permId = crypto.randomUUID();
  const createRes = await fetch(`${sessionUrl}/permissions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: permId, tool_name, tool_input }),
  });

  if (!createRes.ok) {
    // Can't reach hub — deny to be safe
    outputDecision("deny", "Failed to create permission request");
    return;
  }

  // Long-poll loop
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${sessionUrl}/permissions/${encodeURIComponent(permId)}?wait=true`,
        { headers },
      );
      if (!res.ok) {
        outputDecision("deny", `Hub returned ${res.status}`);
        return;
      }
      const result = await res.json();

      if (result.status === "allowed") {
        outputDecision("allow");
        return;
      }
      if (result.status === "denied") {
        outputDecision("deny", result.decision_reason || "Denied by user");
        return;
      }
      // status === "timeout" — retry
    } catch {
      // Network error — retry after brief pause
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Total timeout exceeded
  outputDecision("deny", "Timed out waiting for approval");
}

function outputDecision(decision, reason) {
  if (decision === "deny" && reason) {
    console.error(`[tiller-hook] ${reason}`);
  }
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...(reason && { reason }),
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  outputDecision("deny", `Hook error: ${err.message}`);
});
