#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultMaintainerDevCheckpointPath,
  MAINTAINER_DEV_ACCOUNT_ID,
  MAINTAINER_DEV_HOSTNAME,
  MAINTAINER_DEV_PROFILE_NAME,
  MAINTAINER_DEV_WORKER_NAME,
  readMaintainerDevCheckpoint,
} from "./maintainer-dev-profile.mjs";

function npxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function commandOutput(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

export function assertMaintainerDevEnvironment(env = process.env) {
  if (env.WRANGLER_CI_OVERRIDE_NAME?.trim()) {
    throw new Error("WRANGLER_CI_OVERRIDE_NAME is not allowed for maintainer dev deploys.");
  }
  if (env.TILLER_DEPLOY_PROFILE?.trim() !== MAINTAINER_DEV_PROFILE_NAME) {
    throw new Error(`TILLER_DEPLOY_PROFILE must be ${MAINTAINER_DEV_PROFILE_NAME}.`);
  }
  if (env.TILLER_WORKER_NAME?.trim() !== MAINTAINER_DEV_WORKER_NAME) {
    throw new Error(`TILLER_WORKER_NAME must be ${MAINTAINER_DEV_WORKER_NAME}.`);
  }
  if (env.CLOUDFLARE_ACCOUNT_ID?.trim() !== MAINTAINER_DEV_ACCOUNT_ID) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID must be ${MAINTAINER_DEV_ACCOUNT_ID}.`);
  }
}

export function assertWranglerIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.loggedIn !== true) {
    throw new Error("Wrangler is not authenticated.");
  }
  if (!Array.isArray(value.accounts)) throw new Error("Wrangler did not return its account scope.");
  const accountIds = value.accounts
    .map((account) => account?.id?.trim())
    .filter(Boolean);
  if (accountIds.length !== 1 || accountIds[0] !== MAINTAINER_DEV_ACCOUNT_ID) {
    throw new Error(
      `Wrangler credentials must expose only the maintainer dev account ${MAINTAINER_DEV_ACCOUNT_ID}.`,
    );
  }
  return value;
}

/**
 * @param {{env?: NodeJS.ProcessEnv, hubRoot?: string, requireCheckpoint?: boolean, requireSeedingCheckpoint?: boolean}} [options]
 */
export async function verifyMaintainerDevTarget({
  env = process.env,
  hubRoot,
  requireCheckpoint = false,
  requireSeedingCheckpoint = false,
} = {}) {
  assertMaintainerDevEnvironment(env);
  const root = hubRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const stdout = await commandOutput(npxCommand(), ["wrangler", "whoami", "--json"], {
    cwd: root,
    env,
  });
  const identity = assertWranglerIdentity(JSON.parse(stdout));
  if (requireCheckpoint || requireSeedingCheckpoint) {
    const checkpoint = readMaintainerDevCheckpoint(
      env.TILLER_DEV_CHECKPOINT_PATH?.trim() || defaultMaintainerDevCheckpointPath(root),
      { requireReady: requireCheckpoint },
    );
    if (requireSeedingCheckpoint && checkpoint.state !== "seeding") {
      throw new Error("Seed deployment requires the seeding checkpoint created by bootstrap:dev.");
    }
  }
  return {
    authType: typeof identity.authType === "string" ? identity.authType : "unknown",
    accountId: MAINTAINER_DEV_ACCOUNT_ID,
    workerName: MAINTAINER_DEV_WORKER_NAME,
    hostname: MAINTAINER_DEV_HOSTNAME,
  };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const requireCheckpoint = args.length === 1 && args[0] === "--require-checkpoint";
  const requireSeedingCheckpoint = args.length === 1 && args[0] === "--require-seeding-checkpoint";
  if (args.length > (requireCheckpoint || requireSeedingCheckpoint ? 1 : 0)) {
    console.error(
      "Usage: node scripts/verify-maintainer-dev-target.mjs [--require-checkpoint|--require-seeding-checkpoint]",
    );
    process.exitCode = 1;
  } else verifyMaintainerDevTarget({ requireCheckpoint, requireSeedingCheckpoint }).then((result) => {
    console.log(`Verified ${result.authType} deployment credentials.`);
    console.log(`Fixed dev target: https://${result.hostname}`);
  }).catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
