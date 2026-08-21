#!/usr/bin/env node

import { reportPlanExecutionCompleteWithRetry } from "./scheduled-run.js";

async function main(): Promise<void> {
  const command = process.argv[2]?.trim();
  if (command !== "complete") {
    console.error("Usage: tiller-plan complete");
    process.exitCode = 2;
    return;
  }
  const repoSlug = process.env.REPO_SLUG?.trim() ?? "";
  const lifecycleOpId = process.env.TILLER_LIFECYCLE_START_OP_ID?.trim() ?? "";
  if (!repoSlug || !lifecycleOpId) {
    console.error("tiller-plan complete requires an active Tiller plan execution.");
    process.exitCode = 2;
    return;
  }
  const result = await reportPlanExecutionCompleteWithRetry({
    repoSlug,
    lifecycleOpId,
    onLog: (message) => console.error(`[tiller-plan] ${message}`),
  });
  if (result !== "accepted") process.exitCode = 2;
}

void main();
