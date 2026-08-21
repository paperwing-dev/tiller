#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAINTAINER_DEV_WORKER_NAME = "tiller-dev";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const ACCOUNT_SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function requiredAccountId(value, label) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ACCOUNT_ID.test(normalized)) {
    throw new Error(
      `${label} must be a 32-character lowercase hexadecimal Cloudflare account ID.`,
    );
  }
  return normalized;
}

function requiredAccountSubdomain(value, label) {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ACCOUNT_SUBDOMAIN.test(normalized)) {
    throw new Error(`${label} must be a valid workers.dev account subdomain.`);
  }
  return normalized;
}

function checkpointTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Maintainer dev checkpoint is invalid.");
  }
  const accountId = requiredAccountId(value.accountId, "Checkpoint account ID");
  if (value.workerName !== MAINTAINER_DEV_WORKER_NAME) {
    throw new Error(
      `Checkpoint Worker name must be ${MAINTAINER_DEV_WORKER_NAME}.`,
    );
  }
  const hostname =
    typeof value.resources?.workersDevHostname === "string"
      ? value.resources.workersDevHostname.trim().toLowerCase()
      : "";
  const prefix = `${MAINTAINER_DEV_WORKER_NAME}.`;
  const suffix = ".workers.dev";
  if (!hostname.startsWith(prefix) || !hostname.endsWith(suffix)) {
    throw new Error(
      `Checkpoint hostname must target ${MAINTAINER_DEV_WORKER_NAME} on workers.dev.`,
    );
  }
  const accountSubdomain = requiredAccountSubdomain(
    hostname.slice(prefix.length, -suffix.length),
    "Checkpoint workers.dev account subdomain",
  );
  return {
    accountId,
    accountSubdomain,
    workerName: MAINTAINER_DEV_WORKER_NAME,
    hostname,
  };
}

function readCheckpointOptional(checkpointPath) {
  let descriptor;
  try {
    descriptor = openSync(
      checkpointPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
      throw new Error(
        "Maintainer dev checkpoint must be a regular file with mode 0600.",
      );
    }
    return checkpointTarget(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT")
      return null;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function resolveMaintainerDevTarget({
  checkpointPath,
  env = process.env,
} = {}) {
  const configuredAccountId =
    env.TILLER_MAINTAINER_DEV_ACCOUNT_ID?.trim() ?? "";
  const configuredAccountSubdomain =
    env.TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN?.trim() ?? "";
  const fromCheckpoint = checkpointPath
    ? readCheckpointOptional(checkpointPath)
    : null;

  if (fromCheckpoint) {
    if (
      configuredAccountId &&
      requiredAccountId(configuredAccountId, "Configured account ID") !==
        fromCheckpoint.accountId
    ) {
      throw new Error(
        "Configured maintainer account ID differs from the local checkpoint.",
      );
    }
    if (
      configuredAccountSubdomain &&
      requiredAccountSubdomain(
        configuredAccountSubdomain,
        "Configured account subdomain",
      ) !== fromCheckpoint.accountSubdomain
    ) {
      throw new Error(
        "Configured workers.dev account subdomain differs from the local checkpoint.",
      );
    }
    return fromCheckpoint;
  }

  if (!configuredAccountId || !configuredAccountSubdomain) {
    throw new Error(
      "Fresh maintainer bootstrap requires TILLER_MAINTAINER_DEV_ACCOUNT_ID and " +
        "TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN in the environment or .tiller-maintainer-dev.env.",
    );
  }
  const accountId = requiredAccountId(
    configuredAccountId,
    "Configured account ID",
  );
  const accountSubdomain = requiredAccountSubdomain(
    configuredAccountSubdomain,
    "Configured workers.dev account subdomain",
  );
  return {
    accountId,
    accountSubdomain,
    workerName: MAINTAINER_DEV_WORKER_NAME,
    hostname: `${MAINTAINER_DEV_WORKER_NAME}.${accountSubdomain}.workers.dev`,
  };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node maintainer-dev-target.mjs <checkpoint-path>");
    process.exitCode = 1;
  } else {
    try {
      const target = resolveMaintainerDevTarget({
        checkpointPath: process.argv[2],
      });
      process.stdout.write(`${target.accountId}\t${target.accountSubdomain}\n`);
    } catch (error) {
      console.error(
        `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
