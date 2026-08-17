import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { isPlacementRegion } from "../shared/placement.ts";
import { MAINTAINER_DEV_WORKER_NAME } from "./maintainer-dev-target.mjs";

export const MAINTAINER_DEV_PROFILE_NAME = "maintainer-dev";
export const MAINTAINER_DEV_ACCOUNT_ID =
  process.env.TILLER_MAINTAINER_DEV_ACCOUNT_ID?.trim().toLowerCase() || "0".repeat(32);
export const MAINTAINER_DEV_ACCOUNT_SUBDOMAIN =
  process.env.TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN?.trim().toLowerCase() || "maintainer-preview";
export { MAINTAINER_DEV_WORKER_NAME };
export const MAINTAINER_DEV_HOSTNAME = `${MAINTAINER_DEV_WORKER_NAME}.${MAINTAINER_DEV_ACCOUNT_SUBDOMAIN}.workers.dev`;
export const MAINTAINER_DEV_ORIGIN = `https://${MAINTAINER_DEV_HOSTNAME}`;
export const MAINTAINER_DEV_SCHEMA_BINDING = "TILLER_MAINTAINER_DEV_SCHEMA";
export const MAINTAINER_DEV_CHECKPOINT_FILE = ".tiller-dev-bootstrap.json";

const INSTALLATION_ID = /^[a-z2-7]{26}$/;
const RELEASE_ID = /^[0-9a-f]{40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROBE_REQUEST_TIMEOUT_MS = 10_000;
const PROBE_RESPONSE_MAX_BYTES = 16 * 1_024;

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredString(value, label, max = 4_096) {
  if (typeof value !== "string") throw new Error(`${label} is missing.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} is missing.`);
  return normalized;
}

function optionalString(value, label, max = 4_096) {
  if (value === undefined) return undefined;
  return requiredString(value, label, max);
}

function exact(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}.`);
  }
  return value;
}

export function defaultMaintainerDevCheckpointPath(hubRoot) {
  return path.resolve(hubRoot, "..", "..", MAINTAINER_DEV_CHECKPOINT_FILE);
}

export function normalizeMaintainerDevCheckpoint(value, { requireReady = false } = {}) {
  const checkpoint = record(value, "Maintainer dev checkpoint");
  if (checkpoint.schemaVersion !== 1) throw new Error("Maintainer dev checkpoint schema is invalid.");
  const state = checkpoint.state;
  if (state !== "seeding" && state !== "provisioning" && state !== "ready") {
    throw new Error("Maintainer dev checkpoint state is invalid.");
  }
  if (requireReady && state !== "ready") {
    throw new Error("Maintainer dev Access is not ready. Run `npm run bootstrap:dev` first.");
  }
  const accessMutationPending = checkpoint.accessMutationPending;
  if (accessMutationPending !== undefined && accessMutationPending !== true) {
    throw new Error("Maintainer dev Access mutation marker is invalid.");
  }
  if (accessMutationPending && state !== "provisioning") {
    throw new Error("Maintainer dev Access mutation marker requires provisioning state.");
  }
  const placementRegion = checkpoint.placementRegion;
  if (placementRegion !== undefined && !isPlacementRegion(placementRegion)) {
    throw new Error("Maintainer dev placement region is invalid.");
  }

  const resources = record(checkpoint.resources, "Maintainer dev checkpoint resources");
  const installationId = requiredString(resources.installationId, "Installation ID", 128);
  if (!INSTALLATION_ID.test(installationId)) throw new Error("Installation ID is invalid.");
  const ownerEmail = requiredString(resources.ownerEmail, "Owner email", 320).toLowerCase();
  if (!EMAIL.test(ownerEmail)) throw new Error("Owner email is invalid.");

  const normalizedResources = {
    installationId,
    ownerEmail,
    workersDevHostname: exact(
      requiredString(resources.workersDevHostname, "workers.dev hostname", 253).toLowerCase(),
      MAINTAINER_DEV_HOSTNAME,
      "workers.dev hostname",
    ),
    workerId: state === "seeding"
      ? optionalString(resources.workerId, "Worker ID", 128)
      : requiredString(resources.workerId, "Worker ID", 128),
    accessOrganizationCreatedAt: optionalString(
      resources.accessOrganizationCreatedAt,
      "Access organization creation timestamp",
      128,
    ),
    accessIdentityProviderId: optionalString(resources.accessIdentityProviderId, "Access identity provider ID", 512),
    accessServiceTokenId: optionalString(resources.accessServiceTokenId, "Access service token ID", 512),
    accessServiceClientId: optionalString(resources.accessServiceClientId, "Access service client ID", 512),
    accessTokenExpiresAt: optionalString(resources.accessTokenExpiresAt, "Access token expiration", 128),
    accessIssuer: optionalString(resources.accessIssuer, "Access issuer", 512),
    accessApplicationId: optionalString(resources.accessApplicationId, "Access application ID", 512),
    accessAudience: optionalString(resources.accessAudience, "Access audience", 512),
    accessOwnerPolicyId: optionalString(resources.accessOwnerPolicyId, "Access owner policy ID", 512),
    accessServicePolicyId: optionalString(resources.accessServicePolicyId, "Access service policy ID", 512),
    accessPublicApplicationId: optionalString(
      resources.accessPublicApplicationId,
      "Access public application ID",
      512,
    ),
    accessPublicPolicyId: optionalString(resources.accessPublicPolicyId, "Access public policy ID", 512),
  };

  const normalized = {
    schemaVersion: 1,
    state,
    accountId: exact(
      requiredString(checkpoint.accountId, "Cloudflare account ID", 64),
      MAINTAINER_DEV_ACCOUNT_ID,
      "Cloudflare account ID",
    ),
    workerName: exact(
      requiredString(checkpoint.workerName, "Worker name", 64),
      MAINTAINER_DEV_WORKER_NAME,
      "Worker name",
    ),
    placementRegion,
    resources: normalizedResources,
    serviceClientSecret: optionalString(
      checkpoint.serviceClientSecret,
      "Access service client secret",
      4_096,
    ),
    accessMutationPending,
  };

  if (state === "ready") {
    for (const [key, label] of [
      ["accessIdentityProviderId", "Access identity provider ID"],
      ["accessServiceTokenId", "Access service token ID"],
      ["accessServiceClientId", "Access service client ID"],
      ["accessTokenExpiresAt", "Access token expiration"],
      ["accessIssuer", "Access issuer"],
      ["accessApplicationId", "Access application ID"],
      ["accessAudience", "Access audience"],
      ["accessOwnerPolicyId", "Access owner policy ID"],
      ["accessServicePolicyId", "Access service policy ID"],
      ["accessPublicApplicationId", "Access public application ID"],
      ["accessPublicPolicyId", "Access public policy ID"],
    ]) {
      requiredString(normalizedResources[key], label, 512);
    }
    requiredString(normalized.serviceClientSecret, "Access service client secret", 4_096);
    const expiration = Date.parse(normalizedResources.accessTokenExpiresAt);
    if (!Number.isFinite(expiration)) throw new Error("Access token expiration is invalid.");
    const issuer = new URL(normalizedResources.accessIssuer);
    if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com")) {
      throw new Error("Access issuer is invalid.");
    }
  }

  return normalized;
}

export function readMaintainerDevCheckpoint(checkpointPath, options) {
  let descriptor;
  let content;
  try {
    descriptor = openSync(checkpointPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const fileStat = fstatSync(descriptor);
    if (!fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) {
      throw new Error("Maintainer dev checkpoint must be a regular file with mode 0600.");
    }
    content = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("Maintainer dev Access is not bootstrapped. Run `npm run bootstrap:dev` first.");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return normalizeMaintainerDevCheckpoint(JSON.parse(content), options);
}

export function maintainerDevRuntimeVars(checkpoint, releaseId) {
  const ready = normalizeMaintainerDevCheckpoint(checkpoint, { requireReady: true });
  const normalizedReleaseId = requiredString(releaseId, "Dev release ID", 40);
  if (!RELEASE_ID.test(normalizedReleaseId)) throw new Error("Dev release ID must be a source commit SHA.");
  const resources = ready.resources;
  const runtimeVars = {
    [MAINTAINER_DEV_SCHEMA_BINDING]: "1",
    // keep_vars preserves unrelated dashboard configuration; explicitly
    // clear the mutually exclusive installer marker on the fixed dev Worker.
    TILLER_INSTALLER_SCHEMA: "",
    TILLER_INSTALLATION_ID: resources.installationId,
    TILLER_RELEASE_ID: normalizedReleaseId,
    TILLER_TERMINAL_METRICS: "1",
    TILLER_WORKERS_DEV_HOSTNAME: resources.workersDevHostname,
    CF_ACCESS_ISSUER: resources.accessIssuer,
    CF_ACCESS_AUDIENCE: resources.accessAudience,
    CF_ACCESS_IDENTITY_PROVIDER_ID: resources.accessIdentityProviderId,
    CF_ACCESS_APPLICATION_ID: resources.accessApplicationId,
    CF_ACCESS_OWNER_POLICY_ID: resources.accessOwnerPolicyId,
    CF_ACCESS_SERVICE_POLICY_ID: resources.accessServicePolicyId,
    CF_ACCESS_PUBLIC_APPLICATION_ID: resources.accessPublicApplicationId,
    CF_ACCESS_PUBLIC_POLICY_ID: resources.accessPublicPolicyId,
    CF_ACCESS_SERVICE_TOKEN_ID: resources.accessServiceTokenId,
    CF_ACCESS_SERVICE_CLIENT_ID: resources.accessServiceClientId,
    CF_ACCESS_TOKEN_EXPIRES_AT: resources.accessTokenExpiresAt,
    TILLER_OWNER_EMAIL: resources.ownerEmail,
  };
  return runtimeVars;
}

export function resolveMaintainerDevDeployment({ hubRoot, workerName, env = process.env }) {
  const profile = env.TILLER_DEPLOY_PROFILE?.trim() ?? "";
  if (!profile) return null;
  if (profile !== MAINTAINER_DEV_PROFILE_NAME) {
    throw new Error(`Unsupported TILLER_DEPLOY_PROFILE: ${profile}`);
  }
  if (env.WRANGLER_CI_OVERRIDE_NAME?.trim()) {
    throw new Error("WRANGLER_CI_OVERRIDE_NAME is not allowed for the fixed maintainer dev deployment.");
  }
  if (workerName !== MAINTAINER_DEV_WORKER_NAME) {
    throw new Error(`Maintainer dev deployment must target Worker ${MAINTAINER_DEV_WORKER_NAME}.`);
  }
  if (env.CLOUDFLARE_ACCOUNT_ID?.trim() !== MAINTAINER_DEV_ACCOUNT_ID) {
    throw new Error(`Maintainer dev deployment must target account ${MAINTAINER_DEV_ACCOUNT_ID}.`);
  }

  const checkpointPath = env.TILLER_DEV_CHECKPOINT_PATH?.trim()
    || defaultMaintainerDevCheckpointPath(hubRoot);
  if (env.TILLER_DEV_ALLOW_UNTRUSTED_SEED?.trim() === "1") {
    const checkpoint = readMaintainerDevCheckpoint(checkpointPath);
    if (checkpoint.state !== "seeding") {
      throw new Error("Untrusted seed deployment requires a seeding checkpoint created by bootstrap:dev.");
    }
    return {
      kind: "seed",
      checkpointPath,
      placementRegion: checkpoint.placementRegion,
      runtimeVars: {},
      checkpoint,
    };
  }
  const checkpoint = readMaintainerDevCheckpoint(checkpointPath, { requireReady: true });
  return {
    kind: "ready",
    checkpointPath,
    checkpoint,
    placementRegion: checkpoint.placementRegion,
    runtimeVars: maintainerDevRuntimeVars(checkpoint, env.TILLER_DEV_RELEASE_ID),
  };
}

function expectedAccessLoginRedirect(response, checkpoint, targetPath) {
  if (response.status !== 302) return false;
  const locationValue = response.headers.get("location");
  if (!locationValue) return false;
  try {
    const location = new URL(locationValue);
    const issuer = new URL(checkpoint.resources.accessIssuer);
    return location.origin === issuer.origin
      && location.pathname === `/cdn-cgi/access/login/${MAINTAINER_DEV_HOSTNAME}`
      && location.searchParams.get("kid") === checkpoint.resources.accessAudience
      && location.searchParams.get("redirect_url") === targetPath;
  } catch {
    return false;
  }
}

async function withRequestTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`request timed out after ${timeoutMs}ms`));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response, maxBytes, signal) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`response exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`response exceeded ${maxBytes} bytes`);
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content);
  } catch {
    if (bytes > maxBytes) throw new Error(`response exceeded ${maxBytes} bytes`);
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function probeMaintainerDevDeployment(
  deployment,
  {
    fetchImpl = fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    attempts = 60,
    intervalMs = 2_000,
    requestTimeoutMs = PROBE_REQUEST_TIMEOUT_MS,
    maxResponseBytes = PROBE_RESPONSE_MAX_BYTES,
  } = {},
) {
  if (!Number.isSafeInteger(attempts) || attempts < 1
    || !Number.isSafeInteger(intervalMs) || intervalMs < 0
    || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("Maintainer dev probe limits are invalid.");
  }
  const targetPath = "/api/installer/probe";
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { response: health, body: healthBody } = await withRequestTimeout(async (signal) => {
        const response = await fetchImpl(`${MAINTAINER_DEV_ORIGIN}/health`, {
          redirect: "manual",
          signal,
        });
        return { response, body: await responseJson(response, maxResponseBytes, signal) };
      }, requestTimeoutMs);
      if (health.status !== 200
        || healthBody?.ok !== true
        || Object.keys(healthBody).join(",") !== "ok") {
        throw new Error(`health returned HTTP ${health.status}`);
      }

      const unauthenticated = await withRequestTimeout(
        (signal) => fetchImpl(`${MAINTAINER_DEV_ORIGIN}${targetPath}`, {
          redirect: "manual",
          signal,
        }),
        requestTimeoutMs,
      );
      void unauthenticated.body?.cancel().catch(() => undefined);
      if (deployment.kind === "seed") {
        if (unauthenticated.status >= 200 && unauthenticated.status < 300) {
          throw new Error("untrusted seed unexpectedly accepted a protected request");
        }
        return;
      }

      if (unauthenticated.status !== 401
        && unauthenticated.status !== 403
        && !expectedAccessLoginRedirect(unauthenticated, deployment.checkpoint, targetPath)) {
        throw new Error(`unauthenticated probe returned HTTP ${unauthenticated.status}`);
      }

      const { response: service, body: serviceBody } = await withRequestTimeout(async (signal) => {
        const response = await fetchImpl(`${MAINTAINER_DEV_ORIGIN}${targetPath}`, {
          redirect: "manual",
          headers: {
            "CF-Access-Client-Id": deployment.checkpoint.resources.accessServiceClientId,
            "CF-Access-Client-Secret": deployment.checkpoint.serviceClientSecret,
          },
          signal,
        });
        return { response, body: await responseJson(response, maxResponseBytes, signal) };
      }, requestTimeoutMs);
      if (service.status !== 200
        || serviceBody?.ok !== true
        || serviceBody?.releaseId !== deployment.runtimeVars.TILLER_RELEASE_ID
        || Object.keys(serviceBody).sort().join(",") !== "ok,releaseId") {
        throw new Error(`service probe returned HTTP ${service.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(intervalMs);
    }
  }
  throw new Error(
    `Maintainer dev deployment did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
