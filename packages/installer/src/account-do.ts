import { DurableObject } from "cloudflare:workers";
import {
  AccessConflictError,
  AccessPropagationError,
  provisionFreshAccessStep,
  readManagedAccessExpiration,
  renewManagedAccess,
  validateFreshAccessPreflight,
  validateManagedAccess,
} from "./access";
import { fetchReleaseBundle, RetryableBundleDownloadError } from "./bundle";
import {
  CloudflareApiError,
  createDisabledWorker,
  createImmediateContainerRollout,
  createKvNamespace,
  createR2Bucket,
  getContainerApplication,
  getContainerRollout,
  getR2Bucket,
  getUser,
  getWorker,
  getWorkerSubdomain,
  getWorkersSubdomain,
  listContainerApplications,
  listContainerRegistries,
  listContainerRollouts,
  listKvNamespaces,
  listWorkers,
  patchContainerApplication,
  setWorkerSubdomain,
  type CloudflareApiOperation,
  type CloudflareAuthorization,
  type ContainerApplication,
  type ContainerRegistry,
  type ContainerRollout,
} from "./cloudflare-api";
import {
  decryptAccessServiceSecret,
  decryptOAuthToken,
  encryptAccessServiceSecret,
  encryptOAuthToken,
  randomBase64Url,
  randomInstallationId,
} from "./crypto";
import { revokeAccessToken } from "./oauth";
import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  readBoundedResponseText,
  withAbortDeadline,
} from "./outbound";
import { parseReleaseDescriptor, V1_CONTAINER_REGISTRY_DOMAIN } from "./release";
import { isPlacementRegion } from "../../hub/shared/placement";
import {
  assertManagedContainerTopology,
  containerApplicationName,
  createFreshContainerStep,
  installationAnchorPlacementRegion,
  installationResourceIdentity,
  matchesContainerTargetConfiguration,
  PlacementTopologyError,
  readAndVerifyManagedTopology,
  readAndVerifyMaintenanceWorker,
  readAndVerifyFreshWorker,
  resourceNames,
  stageFreshHubAssets,
  uploadFreshHub,
  uploadMaintenanceHub,
  verifyFreshContainers,
  WORKER_NAME,
  type RuntimeValues,
  type MaintenanceRuntimeValues,
} from "./topology";
import type {
  AccountOperationRecordV1,
  EncryptedAccessSecretV1,
  EncryptedTokenV1,
  Env,
  FixedContainerV1,
  InstallStep,
  InstallIssue,
  InstallationAnchorV1,
  InstallationResourcesV1,
  JobProjection,
  LifecycleIntent,
  PlacementRegion,
  ReleaseDescriptorV1,
  VisibleLifecycleStage,
} from "./types";

const OPERATION_KEY = "active-operation:v1";
const AUTHORIZATION_KEY = "authorization:v1";
const ACCESS_SECRET_KEY = "access-secret:v1";
const ANCHOR_KEY = "installation-anchor:v1";
const RETRY_MS = 2_000;
const CONTAINER_APPLICATION_REGISTRY_RETRY_MS = 60_000;
const WORKER_READBACK_RECONCILIATION_MS = 10_000;
const MAX_REGISTRY_DIAGNOSTIC_ENTRIES = 16;
const MAX_INTERNAL_BODY = 32 * 1_024;
const AUTHORIZATION_CLEANUP_LEAD_MS = DEFAULT_OUTBOUND_TIMEOUT_MS + 1_000;
const ACCESS_SECRET_RECOVERY_MS = 24 * 60 * 60 * 1_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StoredOperationV1 extends AccountOperationRecordV1 {
  accountId: string;
  mutationRecoveryUntil?: string;
  workerReadback?: {
    workerId: string;
    firstMissingAt: string;
    retryUntil: string;
  };
  authorizationClosing?: true;
}

interface StoredAuthorizationV1 {
  operationId: string;
  current: {
    authorizationId: string;
    encryptedToken: EncryptedTokenV1;
  };
}

interface FreshMutationCheckpoint {
  resources: InstallationResourcesV1;
  step: InstallStep;
  delay?: number;
  accessServiceClientSecret?: string;
}

interface AuthorizeBody {
  authorizationId: string;
  accountId: string;
  intent: LifecycleIntent;
  placementRegion?: PlacementRegion;
  descriptor: ReleaseDescriptorV1;
  accessToken: string;
  authorizationExpiresAt: string;
}

type LifecycleStatusResponse = (
  | Exclude<JobProjection, { stage: VisibleLifecycleStage }>
  | { stage: VisibleLifecycleStage; detail?: string }
) & { intent?: LifecycleIntent };

class ActionRequiredError extends Error {
  constructor(readonly issue: InstallIssue) {
    super(issue);
    this.name = "ActionRequiredError";
  }
}

class ContainerRegistryUnavailableError extends ActionRequiredError {
  constructor(readonly cloudflareError?: CloudflareApiError) {
    super("container-registry-unavailable");
    this.name = "ContainerRegistryUnavailableError";
  }
}

class ContainerRegistryRepairRequiredError extends ActionRequiredError {
  constructor() {
    super("container-registry-repair-required");
    this.name = "ContainerRegistryRepairRequiredError";
  }
}

class AmbiguousMutationError extends Error {
  constructor() {
    super("A Cloudflare mutation did not complete unambiguously");
    this.name = "AmbiguousMutationError";
  }
}

class RetryableReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableReadError";
  }
}

class CheckpointedWorkerMissingError extends Error {
  constructor(
    readonly workerId: string,
    readonly cloudflareError: CloudflareApiError,
  ) {
    super("The checkpointed Worker is unavailable");
    this.name = "CheckpointedWorkerMissingError";
  }
}

class TopologyDriftError extends Error {
  constructor(message = "The installed Tiller topology changed") {
    super(message);
    this.name = "TopologyDriftError";
  }
}

class MaintenanceTerminalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MaintenanceTerminalError";
  }
}

type InstallOutcome = "completion" | "reauthorization" | "action-required" | "terminal-failure";

const CLOUDFLARE_OPERATION_LABELS: Record<CloudflareApiOperation, string> = {
  "workers.list": "the Worker list check",
  "workers.get": "the recorded Worker check",
  "container-registries.list": "the Container registry check",
  "container-applications.list": "the Container application check",
  "container-applications.create": "Container application creation",
  "container-applications.get": "Container application verification",
  "container-applications.patch": "the Container application update",
  "container-rollouts.create": "the Container rollout",
  "container-rollouts.list": "the Container rollout check",
  "container-rollouts.get": "Container rollout verification",
};

function installationRestartRequiredDetail(
  operationId: string,
  error: CloudflareApiError,
): string {
  const rayId = error.rayId ? ` Cloudflare Ray ID: ${error.rayId}.` : "";
  return "The Worker recorded by this installation no longer exists in Cloudflare, so the saved operation cannot continue. "
    + "If you already removed its partial Tiller resources, no more cleanup is needed. Start a fresh installation."
    + rayId
    + ` Support reference: ${operationId}. This reference identifies the installer log and is safe to share.`;
}

function installationRegionRestartRequiredDetail(operationId: string): string {
  return "The saved installation operation does not contain a valid regional placement. "
    + "That operation cannot continue safely. Start a fresh installation. "
    + `Support reference: ${operationId}. This reference identifies the installer log and is safe to share.`;
}

function replacementWorkerConflictDetail(
  operationId: string,
  error: CloudflareApiError,
): string {
  const rayId = error.rayId ? ` Cloudflare Ray ID: ${error.rayId}.` : "";
  return "The Worker recorded by this installation no longer exists, and a different Worker named tiller is now present. "
    + "Tiller did not adopt or change that Worker. Review it before starting a new installation."
    + rayId
    + ` Support reference: ${operationId}. This reference identifies the installer log and is safe to share.`;
}

function containerRegistryUnavailableDetail(
  operationId: string,
  error?: CloudflareApiError,
): string {
  const rayId = error?.rayId ? ` Cloudflare Ray ID: ${error.rayId}.` : "";
  return "Cloudflare could not verify Container image access. "
    + "No Tiller resources were created, so it is safe to try again."
    + rayId
    + ` Support reference: ${operationId}. This reference identifies the installer log and is safe to share.`;
}

export function isContainerImageRegistryNotConfigured(
  error: unknown,
): boolean {
  return error instanceof CloudflareApiError
    && error.status === 400
    && !error.uncertain
    && error.requestMethod === "POST"
    && error.operation === "container-applications.create"
    && error.errorCodes.includes(1605)
    && error.errorMessages.some((message) => message.includes("IMAGE_REGISTRY_NOT_CONFIGURED"));
}

function cloudflareFailureDetail(args: {
  operationId: string;
  step: AccountOperationRecordV1["step"];
  error: unknown;
  cleanupRequired: boolean;
}): string {
  const cleanup = args.cleanupRequired
    ? "Earlier Cloudflare resources may have been created; remove the partial Tiller resources before trying again."
    : "No existing Worker was changed.";
  const reference = `Support reference: ${args.operationId}. This reference identifies the installer log and is safe to share.`;
  if (!(args.error instanceof CloudflareApiError)) {
    return args.cleanupRequired
      ? `The deployment stopped after Cloudflare resources may have been created. Review and remove the partial Tiller resources before trying again. ${reference}`
      : `The deployment could not start. ${cleanup} ${reference}`;
  }

  const operation = args.error.operation
    ? CLOUDFLARE_OPERATION_LABELS[args.error.operation]
    : args.step === "containers"
      ? "the Cloudflare Containers step"
      : "the Cloudflare deployment request";
  if (isContainerImageRegistryNotConfigured(args.error)) {
    const rayId = args.error.rayId ? ` Cloudflare Ray ID: ${args.error.rayId}.` : "";
    return "Cloudflare reported that Container image access is not configured for this account "
      + "(HTTP 400, error code 1605)."
      + rayId
      + ` ${cleanup} ${reference}`;
  }
  const codes = args.error.errorCodes.length === 1
    ? `, error code ${args.error.errorCodes[0]}`
    : args.error.errorCodes.length > 1
      ? `, error codes ${args.error.errorCodes.join(", ")}`
      : "";
  const response = args.error.status > 0
    ? `Cloudflare ${args.error.uncertain ? "could not conclusively complete" : "rejected"} ${operation} (HTTP ${args.error.status}${codes}).`
    : `Tiller did not receive a response while performing ${operation}.`;
  const firstProviderMessage = args.error.errorMessages[0];
  const providerMessage = firstProviderMessage
    ? ` Cloudflare reported: “${firstProviderMessage}${/[.!?]$/.test(firstProviderMessage) ? "" : "."}”`
    : "";
  const rayId = args.error.rayId ? ` Cloudflare Ray ID: ${args.error.rayId}.` : "";
  return `${response}${providerMessage}${rayId} ${cleanup} ${reference}`;
}

export function installOutcomeEvent(args: {
  operationId: string;
  step: AccountOperationRecordV1["step"];
  outcome: InstallOutcome;
  intent: LifecycleIntent;
  releaseVersion: string;
  placementRegion?: PlacementRegion;
  issue?: InstallIssue;
  failureCode?: string;
  error?: unknown;
}): {
  event: "tiller.lifecycle.outcome";
  operationId: string;
  step: AccountOperationRecordV1["step"];
  outcome: InstallOutcome;
  intent: LifecycleIntent;
  releaseVersion: string;
  placementRegion?: PlacementRegion;
  issue?: InstallIssue;
  failureCode?: string;
  cloudflareStatus?: number;
  cloudflareUncertain?: boolean;
  cloudflareRequestMethod?: string;
  cloudflareOperation?: CloudflareApiOperation;
  cloudflareErrorCodes?: readonly number[];
  cloudflareErrorMessages?: readonly string[];
  cloudflareRayId?: string;
} {
  const cloudflare = args.error instanceof CloudflareApiError
    ? {
        cloudflareStatus: args.error.status,
        cloudflareUncertain: args.error.uncertain,
        ...(args.error.requestMethod
          ? { cloudflareRequestMethod: args.error.requestMethod }
          : {}),
        ...(args.error.operation
          ? { cloudflareOperation: args.error.operation }
          : {}),
        ...(args.error.errorCodes.length > 0
          ? { cloudflareErrorCodes: [...args.error.errorCodes] }
          : {}),
        ...(args.error.errorMessages.length > 0
          ? { cloudflareErrorMessages: [...args.error.errorMessages] }
          : {}),
        ...(args.error.rayId ? { cloudflareRayId: args.error.rayId } : {}),
      }
    : {};
  return {
    event: "tiller.lifecycle.outcome",
    operationId: args.operationId,
    step: args.step,
    outcome: args.outcome,
    intent: args.intent,
    releaseVersion: args.releaseVersion,
    ...(args.placementRegion ? { placementRegion: args.placementRegion } : {}),
    ...(args.issue ? { issue: args.issue } : {}),
    ...(args.failureCode ? { failureCode: args.failureCode } : {}),
    ...cloudflare,
  };
}

function workerReadbackRetryEvent(args: {
  record: StoredOperationV1;
  retryUntil: string;
  error: CloudflareApiError;
}) {
  const retryUntil = Date.parse(args.retryUntil);
  return {
    event: "tiller.worker_readback.retry" as const,
    operationId: args.record.operationId,
    step: args.record.step,
    intent: args.record.intent,
    releaseVersion: args.record.descriptor.version,
    retryRemainingMs: Number.isFinite(retryUntil)
      ? Math.max(0, Math.min(WORKER_READBACK_RECONCILIATION_MS, retryUntil - Date.now()))
      : 0,
    cloudflareStatus: args.error.status,
    cloudflareUncertain: args.error.uncertain,
    ...(args.error.requestMethod
      ? { cloudflareRequestMethod: args.error.requestMethod }
      : {}),
    ...(args.error.operation ? { cloudflareOperation: args.error.operation } : {}),
    ...(args.error.errorCodes.length > 0
      ? { cloudflareErrorCodes: [...args.error.errorCodes] }
      : {}),
    ...(args.error.rayId ? { cloudflareRayId: args.error.rayId } : {}),
  };
}

type ContainerRegistryReadinessPhase =
  | "fresh-initial"
  | "maintenance-observation"
  | "container-application";

type ContainerRegistryReadinessDecision =
  | "proceed-existing"
  | "repair-required"
  | "observation"
  | "observation-failed"
  | "retry-image-access"
  | "image-access-ready"
  | "image-access-deadline-expired";

function registryDiagnosticEntries(registries: readonly ContainerRegistry[]): Array<{
  domain: string;
  kind?: string;
}> {
  const entries: Array<{ domain: string; kind?: string }> = [];
  for (const registry of registries) {
    const domain = typeof registry?.domain === "string"
      ? registry.domain.trim().toLowerCase()
      : "";
    if (!/^[a-z0-9.-]{1,253}$/.test(domain)) continue;
    const kind = typeof registry.kind === "string" && /^[a-z0-9_-]{1,64}$/i.test(registry.kind.trim())
      ? registry.kind.trim()
      : undefined;
    entries.push({ domain, ...(kind ? { kind } : {}) });
    if (entries.length >= MAX_REGISTRY_DIAGNOSTIC_ENTRIES) break;
  }
  return entries.sort((left, right) => (
    `${left.domain}:${left.kind ?? ""}`.localeCompare(`${right.domain}:${right.kind ?? ""}`)
  ));
}

export function containerRegistryReadinessEvent(args: {
  operationId: string;
  intent: LifecycleIntent;
  releaseVersion: string;
  phase: ContainerRegistryReadinessPhase;
  decision: ContainerRegistryReadinessDecision;
  registries?: readonly ContainerRegistry[];
  retryUntil?: string;
  error?: unknown;
}) {
  const entries = args.registries ? registryDiagnosticEntries(args.registries) : undefined;
  const retryUntil = Date.parse(args.retryUntil ?? "");
  const retryRemainingMs = Number.isFinite(retryUntil)
    ? Math.max(0, Math.min(CONTAINER_APPLICATION_REGISTRY_RETRY_MS, retryUntil - Date.now()))
    : undefined;
  const cloudflare = args.error instanceof CloudflareApiError
    ? {
        cloudflareStatus: args.error.status,
        cloudflareUncertain: args.error.uncertain,
        ...(args.error.operation ? { cloudflareOperation: args.error.operation } : {}),
        ...(args.error.errorCodes.length > 0
          ? { cloudflareErrorCodes: [...args.error.errorCodes] }
          : {}),
        ...(args.error.rayId ? { cloudflareRayId: args.error.rayId } : {}),
      }
    : {};
  return {
    event: "tiller.container_registry.readiness" as const,
    operationId: args.operationId,
    intent: args.intent,
    releaseVersion: args.releaseVersion,
    phase: args.phase,
    decision: args.decision,
    ...(args.registries
      ? {
          registryCount: args.registries.length,
          registries: entries,
          ...(args.registries.length > (entries?.length ?? 0)
            ? { registryMetadataOmitted: true }
            : {}),
        }
      : {}),
    ...(retryRemainingMs !== undefined ? { retryRemainingMs } : {}),
    ...cloudflare,
  };
}

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isExpectedAccessLoginRedirect(args: {
  status: number;
  location: string | null;
  issuer: string;
  audience: string;
  hostname: string;
  targetPath: string;
}): boolean {
  if (args.status !== 302 || !args.location) return false;
  try {
    const location = new URL(args.location);
    const issuer = new URL(args.issuer);
    return location.protocol === "https:"
      && !location.username
      && !location.password
      && location.origin === issuer.origin
      && location.pathname === `/cdn-cgi/access/login/${args.hostname}`
      && location.searchParams.get("kid") === args.audience
      && location.searchParams.get("redirect_url") === args.targetPath;
  } catch {
    return false;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_INTERNAL_BODY) throw new Error("Request too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_INTERNAL_BODY) throw new Error("Request too large");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid request");
  return parsed;
}

function requiredString(value: unknown, max = 4_096): string {
  if (typeof value !== "string") throw new Error("Required value is missing");
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error("Required value is missing");
  return normalized;
}

function isLifecycleIntent(value: unknown): value is LifecycleIntent {
  return value === "install" || value === "update" || value === "renew";
}

function lifecycleIntent(value: unknown): LifecycleIntent {
  if (isLifecycleIntent(value)) return value;
  throw new Error("Lifecycle intent is invalid");
}

function optionalPlacementRegion(value: unknown): PlacementRegion | undefined {
  if (value === undefined) return undefined;
  if (isPlacementRegion(value)) return value;
  throw new Error("Placement region is invalid");
}

function activeOperation(projection: JobProjection): boolean {
  return projection.stage !== "completed"
    && projection.stage !== "failed"
    && (projection.stage !== "action-required" || projection.issue === "reauthorization-required");
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

function completedMilestonePrefix(groups: readonly (readonly unknown[])[]): number | undefined {
  let completed = 0;
  let foundGap = false;
  for (const group of groups) {
    const absent = group.every((value) => value === undefined);
    if (absent) {
      foundGap = true;
      continue;
    }
    if (!group.every(nonEmptyString) || foundGap) return undefined;
    completed += 1;
  }
  return completed;
}

function accessMilestoneCount(resources: unknown): number | undefined {
  if (!isRecord(resources)) return undefined;
  return completedMilestonePrefix([
    [resources.accessIssuer],
    [resources.accessIdentityProviderId],
    [resources.accessServiceTokenId, resources.accessServiceClientId],
    [resources.accessTokenExpiresAt],
    [resources.accessApplicationId, resources.accessAudience],
    [resources.accessOwnerPolicyId],
    [resources.accessServicePolicyId],
    [resources.accessPublicApplicationId],
    [resources.accessPublicPolicyId],
  ]);
}

function freshContainerCount(
  resources: unknown,
  descriptor: ReleaseDescriptorV1,
): number | undefined {
  if (!isRecord(resources)) return undefined;
  const applications = resources.containerApplications;
  if (applications === undefined) return 0;
  if (!isRecord(applications)) return undefined;

  const expectedClasses = new Set(descriptor.containers.map((container) => container.className));
  if (Object.keys(applications).some((className) => !expectedClasses.has(className))) return undefined;

  let completed = 0;
  let foundGap = false;
  for (const container of descriptor.containers) {
    if (!Object.prototype.hasOwnProperty.call(applications, container.className)) {
      foundGap = true;
      continue;
    }
    const application = applications[container.className];
    if (foundGap || !isRecord(application)
      || !nonEmptyString(application.id) || !nonEmptyString(application.name)) {
      return undefined;
    }
    completed += 1;
  }
  return completed;
}

function safeInstanceCount(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 100_000
    ? value
    : undefined;
}

function rolloutInstanceProgress(
  rollout: ContainerRollout,
): { readyInstances: number; totalInstances: number } | undefined {
  const totalInstances = safeInstanceCount(rollout.progress?.total_instances);
  const readyInstances = safeInstanceCount(rollout.health?.instances?.healthy);
  if (totalInstances === undefined || totalInstances === 0 || readyInstances === undefined) return undefined;
  return readyInstances <= totalInstances ? { readyInstances, totalInstances } : undefined;
}

/** Derive a curated, non-sensitive progress sentence from already-persisted state. */
export function statusDetail(
  record: AccountOperationRecordV1 & {
    mutationRecoveryUntil?: string;
    workerReadback?: StoredOperationV1["workerReadback"];
  },
): string | undefined {
  try {
    if (!isRecord(record) || !isRecord(record.projection)) return undefined;
    const descriptor = parseReleaseDescriptor(record.descriptor);
    const stage = record.projection.stage;
    const fresh = record.intent === "install";
    const maintenance = record.intent === "update" || record.intent === "renew";
    const deployStage = stage === "deploy-tiller";
    if (fresh && deployStage && record.workerReadback) {
      return "Confirming whether the previous Tiller Worker still exists";
    }

    switch (record.step) {
      case "preflight":
        return fresh && (stage === "connect-cloudflare" || deployStage)
          ? "Checking your Cloudflare account"
          : undefined;
      case "ensure-container-registry":
        return fresh && stage === "connect-cloudflare"
          ? "Preparing Cloudflare Container image access"
          : undefined;
      case "create-worker":
        return fresh && deployStage ? "Creating Cloudflare resources (1 of 3)" : undefined;
      case "create-kv":
        return fresh && deployStage ? "Creating Cloudflare resources (2 of 3)" : undefined;
      case "create-r2":
        return fresh && deployStage ? "Creating Cloudflare resources (3 of 3)" : undefined;
      case "access": {
        if (!fresh || !deployStage) return undefined;
        if (record.resources?.accessOrganizationCreatedAt
          && !record.resources.accessIdentityProviderId) {
          return "Waiting for Cloudflare Access to finish setup; this can take a few minutes.";
        }
        const completed = accessMilestoneCount(record.resources);
        return completed === undefined
          ? undefined
          : `Configuring Cloudflare Access (${completed} of 9)`;
      }
      case "upload-worker":
        return fresh && deployStage ? "Uploading your Hub" : undefined;
      case "verify-worker":
        return fresh && deployStage ? "Verifying your Hub upload" : undefined;
      case "containers": {
        if (!fresh || !deployStage) return undefined;
        if (record.mutationRecoveryUntil) {
          return "Waiting for Cloudflare to finish enabling Container image access";
        }
        const completed = freshContainerCount(record.resources, descriptor);
        return completed === undefined
          ? undefined
          : `Creating Containers (${completed} of ${descriptor.containers.length})`;
      }
      case "enable-worker":
        return fresh && deployStage ? "Publishing your Hub" : undefined;
      case "health-probe":
        return fresh && deployStage ? "Verifying your Hub (0 of 3)" : undefined;
      case "unauthenticated-probe":
        return fresh && deployStage ? "Verifying your Hub (1 of 3)" : undefined;
      case "service-probe":
        return fresh && deployStage ? "Verifying your Hub (2 of 3)" : undefined;
      case "maintenance-readback":
        return maintenance && (stage === "connect-cloudflare" || deployStage)
          ? "Checking your existing Hub"
          : undefined;
      case "maintenance-renew-access":
        return maintenance && deployStage ? "Renewing Cloudflare Access" : undefined;
      case "maintenance-upload-worker":
        return maintenance && deployStage ? "Uploading your Hub update" : undefined;
      case "maintenance-verify-worker":
        return maintenance && deployStage ? "Verifying your Hub update" : undefined;
      case "maintenance-container-patch":
        if (!maintenance || !deployStage || !isRecord(record.containerCursor)) return undefined;
        if (!Number.isSafeInteger(record.containerCursor.index)
          || record.containerCursor.index < 0
          || record.containerCursor.index > descriptor.containers.length) return undefined;
        return record.containerCursor.index === descriptor.containers.length
          ? `Containers updated (${descriptor.containers.length} of ${descriptor.containers.length})`
          : `Preparing Container ${record.containerCursor.index + 1} of ${descriptor.containers.length}`;
      case "maintenance-container-rollout":
        if (!maintenance || !deployStage || !isRecord(record.containerCursor)) return undefined;
        if (!Number.isSafeInteger(record.containerCursor.index)
          || record.containerCursor.index < 0
          || record.containerCursor.index >= descriptor.containers.length) return undefined;
        return `Starting Container ${record.containerCursor.index + 1} of ${descriptor.containers.length}`;
      case "maintenance-container-wait": {
        if (!maintenance || !deployStage || !isRecord(record.containerCursor)) return undefined;
        const index = record.containerCursor.index;
        const total = descriptor.containers.length;
        if (!Number.isSafeInteger(index) || index < 0 || index >= total) return undefined;
        const base = `Updating Container ${index + 1} of ${total}`;
        const readyInstances = safeInstanceCount(record.containerCursor.readyInstances);
        const totalInstances = safeInstanceCount(record.containerCursor.totalInstances);
        const progress = readyInstances !== undefined && totalInstances !== undefined
          && totalInstances > 0 && readyInstances <= totalInstances
          ? `${base} · ${readyInstances} of ${totalInstances} instances ready`
          : base;
        return `${progress}. Cloudflare may take several minutes to finish each Container.`;
      }
      case "maintenance-probe":
        return maintenance && deployStage ? "Verifying your updated Hub" : undefined;
      case "revoke":
        return (fresh || maintenance) && stage === "open-hub" ? "Finishing securely" : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function statusResponse(record: AccountOperationRecordV1): LifecycleStatusResponse {
  const projection = record.projection;
  const intent = isLifecycleIntent(record.intent) ? record.intent : undefined;
  const intentField = intent ? { intent } : {};

  switch (projection.stage) {
    case "connect-cloudflare":
    case "deploy-tiller":
    case "open-hub": {
      const stage = projection.stage;
      const detail = statusDetail(record);
      return detail
        ? { stage, detail, ...intentField }
        : { stage, ...intentField };
    }
    case "authorize":
      return {
        stage: "authorize",
        nextAction: {
          kind: projection.nextAction.kind,
          url: projection.nextAction.url,
        },
        ...intentField,
      };
    case "action-required":
      return {
        stage: "action-required",
        issue: projection.issue,
        ...(typeof projection.detail === "string" && projection.detail.length <= 2_048
          ? { detail: projection.detail }
          : {}),
        ...(projection.nextAction
          ? {
              nextAction: {
                kind: projection.nextAction.kind,
                url: projection.nextAction.url,
              },
            }
          : {}),
        ...intentField,
      };
    case "completed":
      return { stage: "completed", hubUrl: projection.hubUrl, ...intentField };
    case "failed":
      return {
        stage: "failed",
        error: {
          code: projection.error.code,
          message: projection.error.message,
        },
        ...intentField,
      };
  }
}

export function containerCapabilityIssue(error: unknown): InstallIssue | null {
  if (!(error instanceof CloudflareApiError)) return null;
  if (error.status === 403) return "workers-paid-required";
  if (error.status === 404) return "containers-required";
  return null;
}

/**
 * The only account-scoped lifecycle object. Browser sessions hand it a
 * short-lived grant; only alarm turns are allowed to mutate Cloudflare.
 */
export class AccountLifecycleDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/authorize") return await this.authorize(request);
      if (request.method === "GET" && url.pathname === "/status") return await this.status(url);
      return noStoreJson({ error: "not_found" }, 404);
    } catch {
      return noStoreJson({ error: "invalid_request" }, 400);
    }
  }

  async alarm(): Promise<void> {
    const record = await this.readOperation();
    if (!record || !activeOperation(record.projection)) return;

    // A request may have reached Cloudflare without its validated response
    // being checkpointed. Fresh resources are never rediscovered by name.
    if (record.freshMutationPending) {
      await this.failClosed(record);
      return;
    }

    // A fresh create cannot safely be repeated after an interruption. Every
    // maintenance mutation, by contrast, is recovered by authoritative
    // readback and forward reconciliation toward the pinned target.
    if (record.mutation) {
      if (record.intent === "install") {
        await this.failClosed(record);
        return;
      }
      record.mutation = undefined;
      record.mutationRecoveryUntil = new Date(Date.now() + 10_000).toISOString();
      await this.writeOperation(record);
    }

    const authorizationRecord = await this.readAuthorization();
    if (authorizationRecord?.operationId !== record.operationId) {
      await this.requireReauthorization(record);
      return;
    }
    let authorization: CloudflareAuthorization;
    try {
      authorization = {
        accessToken: await decryptOAuthToken(
          this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
          authorizationRecord.current.encryptedToken,
          { jobId: record.operationId },
        ),
        deadline: this.authorizationDeadline(authorizationRecord.current.encryptedToken),
      };
    } catch {
      await this.ctx.storage.delete(AUTHORIZATION_KEY);
      await this.requireReauthorization(record);
      return;
    }

    try {
      if (Date.now() >= authorization.deadline) {
        await this.requireReauthorization(record);
        return;
      }
      if (record.projection.stage === "action-required"
        && record.projection.issue === "reauthorization-required") {
        record.projection = record.step === "revoke"
          ? { stage: "open-hub" }
          : { stage: "deploy-tiller" };
        await this.writeOperation(record);
      }
      await this.runStep(record, authorization);
    } catch (error) {
      await this.handleStepError(record, authorization, error);
    }
  }

  private async authorize(request: Request): Promise<Response> {
    const body = await readJson(request);
    const input: AuthorizeBody = {
      authorizationId: requiredString(body.authorizationId, 128),
      accountId: requiredString(body.accountId, 128),
      intent: lifecycleIntent(body.intent),
      placementRegion: optionalPlacementRegion(body.placementRegion),
      descriptor: parseReleaseDescriptor(body.descriptor),
      accessToken: requiredString(body.accessToken, 16_384),
      authorizationExpiresAt: requiredString(body.authorizationExpiresAt, 128),
    };
    const expiresAt = Date.parse(input.authorizationExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || expiresAt > Date.now() + 30 * 60 * 1_000 + 5_000) {
      throw new Error("Authorization lifetime is invalid");
    }
    if (input.intent !== "install" && input.placementRegion !== undefined) {
      throw new Error("Maintenance cannot select a placement region");
    }

    let record = await this.readOperation();
    if (record && record.accountId !== input.accountId) throw new Error("Lifecycle account changed");
    if (record?.authorizationClosing) {
      return noStoreJson({ error: "authorization_handoff_busy" }, 409);
    }
    if (record
      && activeOperation(record.projection)
      && record.intent === "install"
      && record.projection.stage === "action-required"
      && record.projection.issue === "reauthorization-required"
      && !isPlacementRegion(record.placementRegion)) {
      await this.finishRestartRequiredInstall(record, {
        stage: "action-required",
        issue: "installation-restart-required",
        detail: installationRegionRestartRequiredDetail(record.operationId),
        nextAction: { kind: "start-fresh", url: "/deploy" },
      }, new Error("The abandoned installation placement region is invalid"));
    }
    if (input.intent === "install" && input.placementRegion === undefined) {
      throw new Error("Installation requires a placement region");
    }
    if (!record || !activeOperation(record.projection)) {
      record = {
        operationId: randomBase64Url(24),
        accountId: input.accountId,
        intent: input.intent,
        ...(input.placementRegion ? { placementRegion: input.placementRegion } : {}),
        descriptor: input.descriptor,
        projection: { stage: "connect-cloudflare" },
        step: input.intent === "install" ? "preflight" : "maintenance-readback",
      };
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredOperationV1>(OPERATION_KEY);
        if (current && activeOperation(current.projection)) throw new Error("Lifecycle operation changed");
        await transaction.put(OPERATION_KEY, record!);
      });
    }

    const encryptedToken = await encryptOAuthToken(
      this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
      input.accessToken,
      { jobId: record.operationId, jobExpiresAt: input.authorizationExpiresAt },
    );
    const authorizationOutcome = await this.ctx.storage.transaction(async (transaction) => {
      const currentOperation = await transaction.get<StoredOperationV1>(OPERATION_KEY);
      if (!currentOperation || currentOperation.operationId !== record!.operationId) return "retry" as const;
      if (currentOperation.authorizationClosing) return "retry" as const;
      const authorization = await transaction.get<StoredAuthorizationV1>(AUTHORIZATION_KEY);
      if (authorization?.operationId === record!.operationId
        && authorization.current.authorizationId === input.authorizationId) return "accepted" as const;
      // Another browser grant is unnecessary while this account operation
      // already has one. The browser session revokes its unused token and
      // observes the existing operation instead of creating a handoff queue.
      if (authorization?.operationId === record!.operationId) return "redundant" as const;
      const next: StoredAuthorizationV1 = {
        operationId: record!.operationId,
        current: { authorizationId: input.authorizationId, encryptedToken },
      };
      await transaction.put(AUTHORIZATION_KEY, next);
      return "accepted" as const;
    });
    if (authorizationOutcome === "retry") {
      return noStoreJson({ error: "authorization_handoff_busy" }, 409);
    }
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return noStoreJson({
      operationId: record.operationId,
      authorizationAccepted: authorizationOutcome === "accepted",
    });
  }

  private async status(url: URL): Promise<Response> {
    const operationId = requiredString(url.searchParams.get("operationId"), 128);
    const record = await this.readOperation();
    if (!record || record.operationId !== operationId) return noStoreJson({ error: "not_found" }, 404);
    return noStoreJson(statusResponse(record));
  }

  private async runStep(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    if (record.intent === "install") this.requiredRecordPlacementRegion(record);
    switch (record.step) {
      case "preflight": return this.preflight(record, authorization);
      case "ensure-container-registry": return this.ensureContainerRegistry(record, authorization);
      case "create-worker": return this.createWorker(record, authorization);
      case "create-kv": return this.createKv(record, authorization);
      case "create-r2": return this.createR2(record, authorization);
      case "access": return this.access(record, authorization);
      case "upload-worker": return this.uploadWorker(record, authorization);
      case "verify-worker": return this.verifyWorker(record, authorization);
      case "containers": return this.containers(record, authorization);
      case "enable-worker": return this.enableWorker(record, authorization);
      case "health-probe": return this.healthProbe(record, authorization);
      case "unauthenticated-probe": return this.unauthenticatedProbe(record, authorization);
      case "service-probe": return this.serviceProbe(record, authorization);
      case "revoke": return this.revoke(record, authorization);
      case "maintenance-readback":
        return this.maintenanceReadback(record, authorization);
      case "maintenance-renew-access": return this.maintenanceRenewAccess(record, authorization);
      case "maintenance-upload-worker": return this.maintenanceUploadWorker(record, authorization);
      case "maintenance-verify-worker": return this.maintenanceVerifyWorker(record, authorization);
      case "maintenance-container-patch": return this.maintenanceContainerPatch(record, authorization);
      case "maintenance-container-rollout": return this.maintenanceContainerRollout(record, authorization);
      case "maintenance-container-wait": return this.maintenanceContainerWait(record, authorization);
      case "maintenance-probe": return this.maintenanceProbe(record, authorization);
      default:
        throw new Error("Lifecycle cursor is invalid");
    }
  }

  private async preflight(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    const workers = await listWorkers(authorization, record.accountId);
    const existingWorker = workers.find((worker) => worker.name === WORKER_NAME);
    if (existingWorker) {
      const anchor = await this.readAnchor();
      if (!anchor || existingWorker.id?.trim() !== anchor.workerId) {
        throw new ActionRequiredError("foreign-worker-conflict");
      }
      this.loadAnchoredPlacementRegion(record, anchor);
      // Every known installation uses the same authoritative maintenance
      // reconciler, including an already-current Worker opened via /deploy.
      record.intent = "update";
      record.projection = { stage: "deploy-tiller" };
      record.step = "maintenance-readback";
      await this.writeAndSchedule(record);
      return;
    }
    const [user, workersDev] = await Promise.all([
      getUser(authorization),
      getWorkersSubdomain(authorization, record.accountId),
      listContainerApplications(authorization, record.accountId).catch((error) => {
        const issue = containerCapabilityIssue(error);
        if (issue) throw new ActionRequiredError(issue);
        throw error;
      }),
    ]);
    const ownerEmail = user.email?.trim().toLowerCase() ?? "";
    if (!EMAIL.test(ownerEmail)) throw new Error("Cloudflare owner email is unavailable");
    const subdomain = workersDev.subdomain?.trim().toLowerCase() ?? "";
    if (!subdomain) throw new ActionRequiredError("workers-dev-required");
    try {
      await validateFreshAccessPreflight({
        authorization,
        accountId: record.accountId,
        workersDevHostname: `${WORKER_NAME}.${subdomain}.workers.dev`,
      });
    } catch (error) {
      if (error instanceof AccessConflictError) {
        throw new ActionRequiredError("access-destination-conflict");
      }
      throw error;
    }
    // Artifact integrity is proven before the first account mutation. It is
    // fetched again immediately before the single Worker upload mutation.
    await fetchReleaseBundle(record.descriptor, authorization.deadline);
    const installationId = randomInstallationId();
    record.resources = {
      installationId,
      ownerEmail,
      workersDevHostname: `${WORKER_NAME}.${subdomain}.workers.dev`,
    };
    record.projection = { stage: "connect-cloudflare" };
    record.step = "ensure-container-registry";
    await this.writeAndSchedule(record);
  }

  private async ensureContainerRegistry(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    let registries: Awaited<ReturnType<typeof listContainerRegistries>>;
    try {
      registries = await listContainerRegistries(authorization, record.accountId);
    } catch (error) {
      throw new ContainerRegistryUnavailableError(
        error instanceof CloudflareApiError ? error : undefined,
      );
    }
    if (!Array.isArray(registries)) throw new ContainerRegistryUnavailableError();

    const registryDomains = registries.flatMap((registry) => {
      const domain = typeof registry?.domain === "string"
        ? registry.domain.trim().toLowerCase()
        : "";
      return domain ? [domain] : [];
    });
    if (registries.length > 0 && registryDomains.length === 0) {
      this.logContainerRegistryReadiness(record, {
        phase: "fresh-initial",
        decision: "observation-failed",
        registries,
      });
      throw new ContainerRegistryUnavailableError();
    }

    const dockerRegistries = registries.filter((registry) => (
      typeof registry?.domain === "string"
      && registry.domain.trim().toLowerCase() === V1_CONTAINER_REGISTRY_DOMAIN
    ));
    const malformedDockerRegistry = dockerRegistries.some((registry) => (
      typeof registry.kind !== "string"
      || registry.kind.trim().toLowerCase() !== "dockerhub"
    ));
    if (malformedDockerRegistry) {
      // Public Docker Hub images need no registry record or credentials. An
      // untyped docker.io record is stale shared-account state created by an
      // earlier installer and must be removed before anonymous pulls can work.
      this.logContainerRegistryReadiness(record, {
        phase: "fresh-initial",
        decision: "repair-required",
        registries,
      });
      throw new ContainerRegistryRepairRequiredError();
    }

    this.logContainerRegistryReadiness(record, {
      phase: "fresh-initial",
      decision: "proceed-existing",
      registries,
    });
    record.mutationRecoveryUntil = undefined;
    record.projection = { stage: "deploy-tiller" };
    record.step = "create-worker";
    await this.writeAndSchedule(record);
  }

  private async createWorker(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    if ((await listWorkers(authorization, record.accountId)).some((worker) => worker.name === WORKER_NAME)) {
      throw new ActionRequiredError("foreign-worker-conflict");
    }
    await this.freshMutation(record, authorization, () => createDisabledWorker(
      authorization,
      record.accountId,
      WORKER_NAME,
      record.descriptor.uploadTemplate.observability,
    ), (created) => {
      const workerId = requiredString(created.id, 128);
      if (created.name !== WORKER_NAME
        || created.subdomain?.enabled !== false
        || created.subdomain?.previews_enabled !== false
        || !Array.isArray(created.tags)
        || created.tags.length !== 1
        || created.tags[0] !== "tiller-installer-v1") {
        throw new AmbiguousMutationError();
      }
      return {
        resources: { ...this.resources(record), workerId },
        step: "create-kv",
      };
    });
  }

  private async createKv(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    const resources = this.resources(record);
    const title = resourceNames(resources.installationId).kvTitle;
    if ((await listKvNamespaces(authorization, record.accountId)).some((namespace) => namespace.title === title)) {
      throw new Error("The fresh KV namespace name already exists and will not be adopted");
    }
    await this.freshMutation(
      record,
      authorization,
      () => createKvNamespace(authorization, record.accountId, title),
      (created) => {
        const id = requiredString(created.id, 128);
        if (created.title !== title) throw new AmbiguousMutationError();
        return {
          resources: { ...resources, kvNamespaceId: id },
          step: "create-r2",
        };
      },
    );
  }

  private async createR2(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    await this.assertKv(record, authorization);
    const resources = this.resources(record);
    const name = resourceNames(resources.installationId).r2Bucket;
    try {
      await getR2Bucket(authorization, record.accountId, name);
      throw new Error("The fresh R2 bucket name already exists and will not be adopted");
    } catch (error) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    await this.freshMutation(
      record,
      authorization,
      () => createR2Bucket(authorization, record.accountId, name),
      (created) => {
        if (created.name !== name) throw new AmbiguousMutationError();
        return {
          resources: { ...resources, r2BucketName: name },
          step: "access",
        };
      },
    );
  }

  private async access(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    await this.assertStorage(record, authorization);
    let checkpointed = false;
    const result = await provisionFreshAccessStep({
      authorization,
      accountId: record.accountId,
      resources: this.resources(record),
      mutate: async (operation) => {
        const result = await this.freshMutation(record, authorization, operation, (value) => ({
          resources: value.resources,
          step: "access",
          delay: 500,
          ...(value.serviceClientSecret
            ? { accessServiceClientSecret: value.serviceClientSecret }
            : {}),
        }));
        checkpointed = true;
        return result;
      },
    });
    if (checkpointed) return;
    record.resources = result.resources;
    if (result.done) {
      if (!await this.readAccessSecret()) throw new Error("The one-time Access secret was not retained");
      record.step = "upload-worker";
    }
    await this.writeAndSchedule(record, result.done ? 50 : 500);
  }

  private async uploadWorker(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    await this.assertStorage(record, authorization);
    const bundle = await fetchReleaseBundle(record.descriptor, authorization.deadline);
    const values = await this.runtimeValues(record);
    let assetsJwt: string;
    try {
      assetsJwt = await stageFreshHubAssets({
        authorization,
        accountId: record.accountId,
        bundle,
      });
    } catch (error) {
      if (error instanceof CloudflareApiError && (error.uncertain
        || error.status === 0 || error.status === 404 || error.status === 408
        || error.status === 409 || error.status === 425
        || error.status === 429 || error.status >= 500)) {
        throw new RetryableReadError("Worker assets are still being staged");
      }
      throw error;
    }
    await this.freshMutation(record, authorization, () => uploadFreshHub({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources: this.resources(record),
      values,
      bundle,
      assetsJwt,
      placementRegion: this.requiredRecordPlacementRegion(record),
    }), () => ({
      resources: this.resources(record),
      step: "verify-worker",
      delay: 1_000,
    }));
  }

  private async verifyWorker(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    const resources = this.resources(record);
    const namespaces = await readAndVerifyFreshWorker({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources,
      values: await this.runtimeValues(record),
      placementRegion: this.requiredRecordPlacementRegion(record),
    });
    record.resources = { ...resources, durableObjectNamespaceIds: namespaces };
    record.step = "containers";
    await this.writeAndSchedule(record);
  }

  private async containers(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    let checkpointed = false;
    let result: Awaited<ReturnType<typeof createFreshContainerStep>>;
    try {
      result = await createFreshContainerStep({
        authorization,
        accountId: record.accountId,
        descriptor: record.descriptor,
        resources: this.resources(record),
        placementRegion: this.requiredRecordPlacementRegion(record),
        mutate: async (operation) => {
          const result = await this.freshMutation(record, authorization, operation, (value) => ({
            resources: value.resources,
            step: "containers",
            delay: 500,
          }));
          checkpointed = true;
          return result;
        },
      });
    } catch (error) {
      if (!(error instanceof CloudflareApiError)
        || !isContainerImageRegistryNotConfigured(error)) throw error;
      await this.retryContainerImageAccess(record, authorization, error);
      return;
    }
    if (checkpointed) {
      await this.finishContainerImageAccessRetry(record);
      return;
    }
    record.resources = result.resources;
    if (result.done) record.step = "enable-worker";
    await this.finishContainerImageAccessRetry(record);
    await this.writeAndSchedule(record, result.done ? 50 : 500);
  }

  private async retryContainerImageAccess(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    error: CloudflareApiError,
  ): Promise<void> {
    const alreadyRetrying = record.mutationRecoveryUntil !== undefined;
    if (!alreadyRetrying) {
      record.mutationRecoveryUntil = new Date(
        Date.now() + CONTAINER_APPLICATION_REGISTRY_RETRY_MS,
      ).toISOString();
    }
    const until = Date.parse(record.mutationRecoveryUntil ?? "");
    let registries: ContainerRegistry[] | undefined;
    try {
      registries = await listContainerRegistries(
        {
          ...authorization,
          deadline: Math.min(authorization.deadline, Number.isFinite(until) ? until : authorization.deadline),
        },
        record.accountId,
      );
    } catch {
      // The exact Container application rejection remains authoritative. A
      // best-effort diagnostic read must not replace it or broaden retries.
    }
    if (!Number.isFinite(until) || Date.now() >= until) {
      this.logContainerRegistryReadiness(record, {
        phase: "container-application",
        decision: "image-access-deadline-expired",
        ...(registries ? { registries } : {}),
        error,
      });
      record.mutationRecoveryUntil = undefined;
      await this.writeOperation(record);
      throw error;
    }
    this.logContainerRegistryReadiness(record, {
      phase: "container-application",
      decision: "retry-image-access",
      ...(registries ? { registries } : {}),
      retryUntil: record.mutationRecoveryUntil,
      error,
    });
    await this.writeAndSchedule(record, Math.min(RETRY_MS, until - Date.now()));
  }

  private async finishContainerImageAccessRetry(record: StoredOperationV1): Promise<void> {
    if (!record.mutationRecoveryUntil) return;
    this.logContainerRegistryReadiness(record, {
      phase: "container-application",
      decision: "image-access-ready",
    });
    record.mutationRecoveryUntil = undefined;
    await this.writeOperation(record);
  }

  private async enableWorker(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, false);
    const containersReady = await verifyFreshContainers({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources: this.resources(record),
      placementRegion: this.requiredRecordPlacementRegion(record),
    });
    if (!containersReady) {
      throw new RetryableReadError("The fresh Container application list is still propagating");
    }
    await this.freshMutation(record, authorization, () => setWorkerSubdomain(
      authorization,
      record.accountId,
      WORKER_NAME,
      true,
    ), (result) => {
      if (result.enabled !== true || result.previews_enabled !== false) throw new AmbiguousMutationError();
      return {
        resources: this.resources(record),
        step: "health-probe",
        delay: 1_000,
      };
    });
  }

  private async healthProbe(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, true, true);
    const response = await this.probe(`${this.hubOrigin(record)}/health`, authorization.deadline);
    if (response.status === 0 || response.status === 404 || response.status === 429 || response.status >= 500) {
      throw new RetryableReadError("The public health endpoint is still propagating");
    }
    if (response.status !== 200 || !isRecord(response.body) || response.body.ok !== true
      || Object.keys(response.body).length !== 1) {
      throw new Error("The public health endpoint did not return its minimal response");
    }
    record.step = "unauthenticated-probe";
    await this.writeAndSchedule(record);
  }

  private async unauthenticatedProbe(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, true);
    const targetPath = "/api/installer/probe";
    const response = await this.probe(`${this.hubOrigin(record)}${targetPath}`, authorization.deadline);
    if (response.status === 0 || response.status === 404 || response.status === 429
      || response.status >= 500) {
      throw new RetryableReadError("Cloudflare Access is still propagating");
    }
    const resources = this.resources(record);
    if (response.status !== 401 && response.status !== 403
      && !isExpectedAccessLoginRedirect({
        status: response.status,
        location: response.location,
        issuer: requiredString(resources.accessIssuer, 512),
        audience: requiredString(resources.accessAudience, 512),
        hostname: resources.workersDevHostname,
        targetPath,
      })) {
      throw new Error("The installer probe was not rejected without Cloudflare Access credentials");
    }
    record.step = "service-probe";
    await this.writeAndSchedule(record);
  }

  private async serviceProbe(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    await this.assertWorker(record, authorization, true);
    const resources = this.resources(record);
    const response = await this.probe(
      `${this.hubOrigin(record)}/api/installer/probe`,
      authorization.deadline,
      {
        "CF-Access-Client-Id": requiredString(resources.accessServiceClientId, 512),
        "CF-Access-Client-Secret": await this.accessSecret(record),
      },
    );
    if (response.status === 0 || response.status === 401 || response.status === 403
      || response.status === 404 || response.status === 429 || response.status >= 500
      || (response.status >= 300 && response.status < 400)) {
      throw new RetryableReadError("The authenticated installer probe is still propagating");
    }
    if (response.status !== 200
      || !isRecord(response.body)
      || response.body.ok !== true
      || response.body.releaseId !== record.descriptor.releaseId
      || Object.keys(response.body).sort().join(",") !== "ok,releaseId") {
      throw new Error("The authenticated installer probe returned the wrong release");
    }
    const placementRegion = this.requiredRecordPlacementRegion(record);
    const durableObjectNamespaceIds = await readAndVerifyFreshWorker({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources,
      values: await this.runtimeValues(record),
      placementRegion,
    });
    const verifiedResources = { ...resources, durableObjectNamespaceIds };
    if (!await verifyFreshContainers({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources: verifiedResources,
      placementRegion,
    })) {
      throw new RetryableReadError("The regional Container topology is still propagating");
    }
    record.resources = verifiedResources;
    const anchor: InstallationAnchorV1 = {
      schemaVersion: 1,
      installationId: verifiedResources.installationId,
      workerId: requiredString(verifiedResources.workerId, 128),
      placementRegion,
      resourceIdentity: installationResourceIdentity(verifiedResources),
      accessTokenExpiresAt: requiredString(verifiedResources.accessTokenExpiresAt, 128),
      containerImages: this.targetContainerImages(record.descriptor),
    };
    record.projection = { stage: "open-hub" };
    record.step = "revoke";
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(ANCHOR_KEY, anchor);
      await transaction.delete(ACCESS_SECRET_KEY);
      await transaction.put(OPERATION_KEY, record);
      await transaction.setAlarm(Date.now() + 50);
    });
  }

  private async maintenanceReadback(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const anchor = await this.requiredAnchor();
    this.loadAnchoredPlacementRegion(record, anchor);
    await this.observeContainerRegistries(record, authorization);
    const user = await getUser(authorization);
    const ownerEmail = user.email?.trim().toLowerCase() ?? "";
    if (!EMAIL.test(ownerEmail)) throw new Error("Cloudflare owner email is unavailable");
    let readback: Awaited<ReturnType<typeof readAndVerifyManagedTopology>>;
    try {
      readback = await readAndVerifyManagedTopology({
        authorization,
        accountId: record.accountId,
        descriptor: record.descriptor,
        anchor,
        placementRegion: this.requiredRecordPlacementRegion(record),
        ownerEmail,
      });
      readback.resources = await this.validateAccessWithAnchor(
        authorization,
        record.accountId,
        readback.resources,
        ownerEmail,
      );
    } catch (error) {
      if (error instanceof CloudflareApiError || error instanceof RetryableReadError) throw error;
      if (error instanceof AccessConflictError) throw new ActionRequiredError("access-repair-required");
      throw new TopologyDriftError();
    }

    record.resources = readback.resources;
    record.sourceVersionId = readback.sourceVersionId;
    record.containerCursor ??= { index: 0 };
    record.projection = { stage: "deploy-tiller" };
    record.step = "maintenance-renew-access";
    await this.writeAndSchedule(record);
  }

  private async maintenanceRenewAccess(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    this.loadAnchoredPlacementRegion(record, await this.requiredAnchor());
    const resources = this.resources(record);
    if (record.mutationRecoveryUntil) {
      const actualExpiration = await readManagedAccessExpiration({
        authorization,
        accountId: record.accountId,
        resources,
        ownerEmail: resources.ownerEmail,
      });
      if (actualExpiration !== resources.accessTokenExpiresAt) {
        const renewedResources = { ...resources, accessTokenExpiresAt: actualExpiration };
        await this.recordAccessRenewal(renewedResources);
        record.resources = renewedResources;
        record.mutation = undefined;
        record.mutationRecoveryUntil = undefined;
        record.step = "maintenance-upload-worker";
        await this.writeAndSchedule(record);
        return;
      }
      if (this.waitingForMutationReadback(record)) {
        await this.schedule(RETRY_MS);
        return;
      }
      // The persisted marker preceded a mutation that did not commit. Exact
      // readback proved it is safe to retry the in-place refresh.
      await this.writeOperation(record);
    }

    const renewed = await renewManagedAccess({
      authorization,
      accountId: record.accountId,
      resources: this.resources(record),
      ownerEmail: resources.ownerEmail,
      mutate: (operation) => this.mutate(record, authorization, operation),
    });
    await this.recordAccessRenewal(renewed);
    record.resources = renewed;
    record.mutation = undefined;
    record.mutationRecoveryUntil = undefined;
    record.step = "maintenance-upload-worker";
    await this.writeAndSchedule(record);
  }

  private async maintenanceUploadWorker(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const anchor = await this.requiredAnchor();
    const placementRegion = this.loadAnchoredPlacementRegion(record, anchor);
    const previousResources = this.resources(record);
    let readback: Awaited<ReturnType<typeof readAndVerifyManagedTopology>>;
    try {
      readback = await readAndVerifyManagedTopology({
        authorization,
        accountId: record.accountId,
        descriptor: record.descriptor,
        anchor,
        placementRegion,
        ownerEmail: previousResources.ownerEmail,
      });
      readback.resources = await this.validateAccessWithAnchor(
        authorization,
        record.accountId,
        readback.resources,
        previousResources.ownerEmail,
      );
    } catch (error) {
      if (error instanceof CloudflareApiError) throw error;
      if (error instanceof AccessConflictError) throw new ActionRequiredError("access-repair-required");
      throw new TopologyDriftError();
    }
    record.resources = readback.resources;
    const resources = readback.resources;

    const values = this.maintenanceRuntimeValues(record);
    if (readback.currentReleaseId === record.descriptor.releaseId) {
      try {
        const versionId = await readAndVerifyMaintenanceWorker({
          authorization,
          accountId: record.accountId,
          descriptor: record.descriptor,
          resources,
          values,
          placementRegion,
        });
        record.sourceVersionId = versionId;
        record.mutation = undefined;
        record.mutationRecoveryUntil = undefined;
        record.step = "maintenance-container-patch";
        await this.writeAndSchedule(record);
        return;
      } catch (error) {
        if (error instanceof CloudflareApiError) throw error;
        if (error instanceof PlacementTopologyError) throw new TopologyDriftError();
        // The marker may match while an allowed setting is stale. Re-upload
        // from the exact active version to reconcile it to the descriptor.
      }
    }
    if (record.sourceVersionId && readback.sourceVersionId !== record.sourceVersionId) {
      throw new TopologyDriftError("The active Worker version changed during maintenance");
    }
    record.sourceVersionId = readback.sourceVersionId;
    if (this.waitingForMutationReadback(record)) {
      await this.schedule(RETRY_MS);
      return;
    }

    const bundle = await fetchReleaseBundle(record.descriptor, authorization.deadline);
    await this.mutate(record, authorization, () => uploadMaintenanceHub({
      authorization,
      accountId: record.accountId,
      descriptor: record.descriptor,
      resources,
      values,
      bundle,
      sourceVersionId: readback.sourceVersionId,
      placementRegion,
    }));
    record.mutation = undefined;
    record.mutationRecoveryUntil = undefined;
    record.step = "maintenance-verify-worker";
    await this.writeAndSchedule(record, 1_000);
  }

  private async maintenanceVerifyWorker(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const placementRegion = this.loadAnchoredPlacementRegion(record, await this.requiredAnchor());
    let versionId: string;
    try {
      versionId = await readAndVerifyMaintenanceWorker({
        authorization,
        accountId: record.accountId,
        descriptor: record.descriptor,
        resources: this.resources(record),
        values: this.maintenanceRuntimeValues(record),
        placementRegion,
      });
    } catch (error) {
      if (error instanceof PlacementTopologyError) throw new TopologyDriftError();
      throw error;
    }
    record.sourceVersionId = versionId;
    record.step = "maintenance-container-patch";
    record.containerCursor ??= { index: 0 };
    await this.writeAndSchedule(record);
  }

  private async maintenanceContainerPatch(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    await this.assertTargetWorker(record, authorization);
    const cursor = record.containerCursor ?? { index: 0 };
    const target = record.descriptor.containers[cursor.index];
    if (!target) {
      record.containerCursor = cursor;
      record.step = "maintenance-probe";
      await this.writeAndSchedule(record);
      return;
    }
    const resources = this.resources(record);
    const installed = resources.containerApplications?.[target.className];
    const namespaceId = resources.durableObjectNamespaceIds?.[target.className];
    const name = containerApplicationName(resources.installationId, target.applicationNameSuffix);
    if (!installed || !namespaceId || installed.name !== name) throw new TopologyDriftError();
    const application = await getContainerApplication(authorization, record.accountId, installed.id);
    this.assertContainerIdentity(
      application,
      installed.id,
      target,
      namespaceId,
      name,
      this.requiredRecordPlacementRegion(record),
    );
    const anchor = await this.requiredAnchor();
    const completedImage = anchor.containerImages?.[target.className];

    if (!cursor.applicationId
      && application.configuration?.image === target.image
      && completedImage === target.image) {
      this.assertNoActiveRollout(await listContainerRollouts(
        authorization,
        record.accountId,
        installed.id,
      ));
      cursor.index += 1;
      record.containerCursor = cursor;
      await this.writeAndSchedule(record);
      return;
    }
    if (!cursor.applicationId) {
      cursor.applicationId = installed.id;
      record.containerCursor = cursor;
      // Persist the subcursor before PATCH so a committed response lost to an
      // interruption advances to rollout instead of being mistaken as done.
      await this.writeAndSchedule(record);
      return;
    }
    if (cursor.applicationId !== installed.id) throw new TopologyDriftError();
    if (application.configuration?.image !== target.image) {
      if (this.waitingForMutationReadback(record)) {
        await this.schedule(RETRY_MS);
        return;
      }
      const configuration = { image: target.image, instance_type: target.instanceType };
      const patched = await this.mutate(record, authorization, () => patchContainerApplication(
        authorization,
        record.accountId,
        installed.id,
        { configuration },
      ));
      this.assertContainerIdentity(
        patched,
        installed.id,
        target,
        namespaceId,
        name,
        this.requiredRecordPlacementRegion(record),
      );
      // Cloudflare keeps application.configuration on the currently deployed
      // image until the subsequent rollout completes. A successful PATCH can
      // therefore return the old image; the persisted next step is the proof
      // that configuration staging completed, while the rollout and its final
      // application readback prove that the target image was applied.
    }
    record.mutation = undefined;
    record.mutationRecoveryUntil = undefined;
    record.step = "maintenance-container-rollout";
    await this.writeAndSchedule(record);
  }

  private async maintenanceContainerRollout(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const { cursor, target, targetConfiguration } = await this.containerRolloutContext(
      record,
      authorization,
    );
    if (cursor.rolloutId) {
      record.step = "maintenance-container-wait";
      await this.writeAndSchedule(record);
      return;
    }
    if (this.waitingForMutationReadback(record)) {
      await this.schedule(RETRY_MS);
      return;
    }

    const rollouts = await listContainerRollouts(
      authorization,
      record.accountId,
      cursor.applicationId!,
    );
    const activeRollouts = rollouts.filter((rollout) => (
      rollout.status === "pending" || rollout.status === "progressing"
    ));
    if (activeRollouts.length > 0) {
      if (activeRollouts.length !== 1 || !this.matchesTargetRollout(activeRollouts[0], target)) {
        throw new TopologyDriftError("A different Container rollout is already active");
      }
      cursor.rolloutId = requiredString(activeRollouts[0].id, 128);
      record.containerCursor = cursor;
      record.mutation = undefined;
      record.mutationRecoveryUntil = undefined;
      record.step = "maintenance-container-wait";
      await this.writeAndSchedule(record, 1_000);
      return;
    }

    // A rollout response may be lost after Cloudflare commits it. Recover a
    // completed managed rollout by authoritative list/readback instead of
    // starting a duplicate rollout.
    const completed = rollouts.find((rollout) => (
      rollout.status === "completed" && this.matchesTargetRollout(rollout, target)
    ));
    if (completed) {
      cursor.rolloutId = requiredString(completed.id, 128);
      record.containerCursor = cursor;
      record.mutation = undefined;
      record.mutationRecoveryUntil = undefined;
      record.step = "maintenance-container-wait";
      await this.writeAndSchedule(record);
      return;
    }

    const rollout = await this.mutate(record, authorization, () => createImmediateContainerRollout(
      authorization,
      record.accountId,
      cursor.applicationId!,
      targetConfiguration,
    ));
    const rolloutId = requiredString(rollout.id, 128);
    if (!this.matchesTargetRollout(rollout, target)
      || (rollout.status !== "pending" && rollout.status !== "progressing" && rollout.status !== "completed")) {
      throw new AmbiguousMutationError();
    }
    cursor.rolloutId = rolloutId;
    record.containerCursor = cursor;
    record.mutation = undefined;
    record.mutationRecoveryUntil = undefined;
    record.step = "maintenance-container-wait";
    await this.writeAndSchedule(record, 1_000);
  }

  private async maintenanceContainerWait(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const { cursor, target, namespaceId, name } = await this.containerRolloutContext(record, authorization);
    const rollout = await getContainerRollout(
      authorization,
      record.accountId,
      cursor.applicationId!,
      requiredString(cursor.rolloutId, 128),
    );
    if (rollout.id?.trim() !== cursor.rolloutId) throw new TopologyDriftError("Cloudflare returned the wrong rollout");
    if (rollout.status === "pending" || rollout.status === "progressing") {
      const progress = rolloutInstanceProgress(rollout);
      if (progress
        && (cursor.readyInstances !== progress.readyInstances
          || cursor.totalInstances !== progress.totalInstances)) {
        cursor.readyInstances = progress.readyInstances;
        cursor.totalInstances = progress.totalInstances;
        record.containerCursor = cursor;
        await this.writeAndSchedule(record, RETRY_MS);
        return;
      }
      await this.schedule(RETRY_MS);
      return;
    }
    if (rollout.status === "reverted") {
      throw new MaintenanceTerminalError(
        "container_rollout_reverted",
        `Cloudflare reverted the ${target.className} Container rollout. Retry maintenance to advance it.`,
      );
    }
    if (rollout.status === "replaced") throw new TopologyDriftError("The Tiller Container rollout was replaced");
    if (rollout.status !== "completed") throw new RetryableReadError("Container rollout status is not available yet");
    const application = await getContainerApplication(authorization, record.accountId, cursor.applicationId!);
    this.assertContainerIdentity(
      application,
      cursor.applicationId!,
      target,
      namespaceId,
      name,
      this.requiredRecordPlacementRegion(record),
    );
    if (application.configuration?.image !== target.image) {
      throw new RetryableReadError(`Container application ${name} has not finished reconciling`);
    }
    record.containerCursor = { index: cursor.index + 1 };
    record.step = "maintenance-container-patch";
    await this.writeAndSchedule(record);
  }

  private async maintenanceProbe(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    await this.assertTargetWorker(record, authorization);
    const health = await this.probe(`${this.hubOrigin(record)}/health`, authorization.deadline);
    if (health.status === 0 || health.status === 404 || health.status === 429 || health.status >= 500) {
      throw new RetryableReadError("The updated Hub is still propagating");
    }
    if (health.status !== 200 || !isRecord(health.body) || health.body.ok !== true
      || Object.keys(health.body).length !== 1) {
      throw new Error("The updated Hub health response is invalid");
    }
    const protectedProbe = await this.probe(
      `${this.hubOrigin(record)}/api/installer/probe`,
      authorization.deadline,
    );
    if (protectedProbe.status === 0 || protectedProbe.status === 404 || protectedProbe.status === 429
      || protectedProbe.status >= 500) {
      throw new RetryableReadError("Cloudflare Access is still propagating after maintenance");
    }
    const resources = this.resources(record);
    if (protectedProbe.status !== 401 && protectedProbe.status !== 403
      && !isExpectedAccessLoginRedirect({
        status: protectedProbe.status,
        location: protectedProbe.location,
        issuer: requiredString(resources.accessIssuer, 512),
        audience: requiredString(resources.accessAudience, 512),
        hostname: resources.workersDevHostname,
        targetPath: "/api/installer/probe",
      })) {
      throw new Error("The maintained Hub is not protected by Cloudflare Access");
    }
    const anchor = await this.requiredAnchor();
    const nextAnchor: InstallationAnchorV1 = {
      ...anchor,
      resourceIdentity: installationResourceIdentity(resources),
      containerImages: this.targetContainerImages(record.descriptor),
    };
    record.projection = { stage: "open-hub" };
    record.step = "revoke";
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredOperationV1>(OPERATION_KEY);
      if (!current || current.operationId !== record.operationId
        || current.step !== "maintenance-probe") throw new AmbiguousMutationError();
      await transaction.put(ANCHOR_KEY, nextAnchor);
      await transaction.put(OPERATION_KEY, record);
      await transaction.setAlarm(Date.now() + 50);
    });
  }

  private async revoke(record: StoredOperationV1, authorization: CloudflareAuthorization): Promise<void> {
    const outcomeStep = record.step;
    if (!record.authorizationClosing) {
      record.authorizationClosing = true;
      await this.writeOperation(record);
    }
    try {
      const remaining = Math.floor(authorization.deadline - Date.now());
      if (remaining <= 0) throw new Error("Cloudflare authorization expired");
      await revokeAccessToken(
        this.env,
        authorization.accessToken,
        Math.min(DEFAULT_OUTBOUND_TIMEOUT_MS, remaining),
      );
    } catch {
      throw new RetryableReadError("Cloudflare authorization revocation is still pending");
    }
    await this.ctx.storage.delete(AUTHORIZATION_KEY);
    record.authorizationClosing = undefined;
    record.step = "completed";
    record.projection = { stage: "completed", hubUrl: this.hubOrigin(record) };
    await this.writeOperation(record);
    this.logInstallOutcome(record, "completion", undefined, outcomeStep);
  }

  /**
   * Checkpoint one fresh Cloudflare mutation before any eventually-consistent
   * readback. The updater deliberately continues to use mutate() below.
   */
  private async freshMutation<T>(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    operation: () => Promise<T>,
    checkpointFor: (result: T) => FreshMutationCheckpoint,
  ): Promise<T> {
    if (record.intent !== "install" || record.freshMutationPending || record.mutation) {
      throw new AmbiguousMutationError();
    }
    const expectedStep = record.step;
    this.assertMutationWindow(authorization);
    const pending: StoredOperationV1 = { ...record, freshMutationPending: true };
    await this.writeOperation(pending);
    record.freshMutationPending = true;
    try {
      this.assertMutationWindow(authorization);
    } catch (error) {
      await this.clearFreshMutationPending(record, expectedStep);
      throw error;
    }

    let result: T;
    try {
      result = await operation();
    } catch (error) {
      if (error instanceof CloudflareApiError && !error.uncertain) {
        await this.clearFreshMutationPending(record, expectedStep);
      }
      throw error;
    }

    const checkpoint = checkpointFor(result);
    if (!checkpoint.resources?.installationId || checkpoint.resources.installationId
      !== record.resources?.installationId) {
      throw new AmbiguousMutationError();
    }
    const delay = checkpoint.delay ?? 50;
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000) {
      throw new AmbiguousMutationError();
    }
    const encryptedSecret = checkpoint.accessServiceClientSecret
      ? await this.encryptAccessSecret(
          record,
          requiredString(checkpoint.accessServiceClientSecret, 16_384),
        )
      : undefined;

    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredOperationV1>(OPERATION_KEY);
      if (!current || current.operationId !== record.operationId
        || current.intent !== "install" || current.step !== expectedStep
        || !current.freshMutationPending) {
        throw new AmbiguousMutationError();
      }
      const next: StoredOperationV1 = {
        ...current,
        resources: checkpoint.resources,
        step: checkpoint.step,
        freshMutationPending: undefined,
      };
      await transaction.put(OPERATION_KEY, next);
      if (encryptedSecret) await transaction.put(ACCESS_SECRET_KEY, encryptedSecret);
      await transaction.setAlarm(Date.now() + delay);
    });
    record.resources = checkpoint.resources;
    record.step = checkpoint.step;
    record.freshMutationPending = undefined;
    return result;
  }

  private async clearFreshMutationPending(
    record: StoredOperationV1,
    expectedStep: StoredOperationV1["step"],
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredOperationV1>(OPERATION_KEY);
      if (!current || current.operationId !== record.operationId || current.intent !== "install"
        || current.step !== expectedStep || !current.freshMutationPending) {
        throw new AmbiguousMutationError();
      }
      current.freshMutationPending = undefined;
      await transaction.put(OPERATION_KEY, current);
    });
    record.freshMutationPending = undefined;
  }

  private async mutate<T>(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (record.mutation) throw new AmbiguousMutationError();
    this.assertMutationWindow(authorization);
    record.mutation = true;
    await this.writeOperation(record);
    this.assertMutationWindow(authorization);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CloudflareApiError && !error.uncertain) {
        record.mutation = undefined;
        await this.writeOperation(record);
      }
      throw error;
    }
  }

  private async assertWorker(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    enabled: boolean,
    retryEnabledPropagation = false,
  ): Promise<void> {
    const resources = this.resources(record);
    const workerId = requiredString(resources.workerId, 128);
    let worker: Awaited<ReturnType<typeof getWorker>>;
    try {
      worker = await getWorker(authorization, record.accountId, workerId);
    } catch (error) {
      if (record.intent === "install"
        && error instanceof CloudflareApiError
        && error.status === 404
        && !error.uncertain
        && error.requestMethod === "GET"
        && error.operation === "workers.get") {
        throw new CheckpointedWorkerMissingError(workerId, error);
      }
      throw error;
    }
    if (record.workerReadback) {
      if (record.workerReadback.workerId !== workerId) {
        throw new TopologyDriftError("The checkpointed Worker readback identity changed");
      }
      record.workerReadback = undefined;
      await this.writeOperation(record);
    }
    const route = await getWorkerSubdomain(authorization, record.accountId, WORKER_NAME);
    if (worker.id?.trim() !== workerId
      || worker.name !== WORKER_NAME
      || !Array.isArray(worker.tags)
      || worker.tags.length !== 1
      || worker.tags[0] !== "tiller-installer-v1"
      || worker.observability?.enabled !== record.descriptor.uploadTemplate.observability.enabled
      || worker.observability?.head_sampling_rate !== record.descriptor.uploadTemplate.observability.headSamplingRate
      || route.previews_enabled !== false) {
      throw new Error("The fresh Worker identity or route changed during deployment");
    }
    if (route.enabled !== enabled) {
      if (retryEnabledPropagation && enabled && route.enabled === false) {
        throw new RetryableReadError("The enabled Worker route is still propagating");
      }
      throw new Error("The fresh Worker identity or route changed during deployment");
    }
  }

  private async assertKv(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    const resources = this.resources(record);
    const id = requiredString(resources.kvNamespaceId, 128);
    const title = resourceNames(resources.installationId).kvTitle;
    const namespaces = await listKvNamespaces(authorization, record.accountId);
    const exact = namespaces.filter((namespace) => namespace.id?.trim() === id && namespace.title === title);
    const related = namespaces.filter((namespace) => namespace.id?.trim() === id || namespace.title === title);
    if (exact.length === 1 && related.length === 1) return;
    if (related.length === 0) throw new RetryableReadError("The fresh KV namespace is still propagating");
    throw new Error("The fresh KV namespace identity changed during deployment");
  }

  private async assertStorage(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    await this.assertKv(record, authorization);
    const resources = this.resources(record);
    const name = requiredString(resources.r2BucketName, 128);
    const bucket = await getR2Bucket(authorization, record.accountId, name);
    if (bucket.name !== name || name !== resourceNames(resources.installationId).r2Bucket) {
      throw new Error("The fresh R2 bucket identity changed during deployment");
    }
  }

  private async runtimeValues(record: StoredOperationV1): Promise<RuntimeValues> {
    const resources = this.resources(record);
    return {
      ...this.maintenanceRuntimeValues(record),
      ownerEmail: resources.ownerEmail,
      accessServiceClientSecret: await this.accessSecret(record),
    };
  }

  private async probe(
    url: string,
    deadline: number,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: unknown; location: string | null }> {
    try {
      const remaining = Math.floor(deadline - Date.now());
      if (!Number.isFinite(deadline) || remaining <= 0) throw new Error("Authorization expired");
      return await withAbortDeadline(async (signal) => {
        const response = await fetch(url, { signal, redirect: "manual", headers });
        const text = await readBoundedResponseText(response, 16 * 1_024);
        let body: unknown = null;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          // Cloudflare Access rejection and propagation pages are not JSON.
        }
        return {
          status: response.status,
          body,
          location: response.headers.get("Location"),
        };
      }, Math.min(10_000, remaining));
    } catch {
      throw new RetryableReadError("The Hub endpoint is not reachable yet");
    }
  }

  private resources(record: StoredOperationV1): InstallationResourcesV1 {
    if (!record.resources?.installationId) throw new Error("Installation resources are missing");
    return { ...record.resources };
  }

  private hubOrigin(record: StoredOperationV1): string {
    const hostname = this.resources(record).workersDevHostname.toLowerCase();
    if (!hostname.startsWith(`${WORKER_NAME}.`) || !hostname.endsWith(".workers.dev")) {
      throw new Error("Hub origin is invalid");
    }
    return `https://${hostname}`;
  }

  private async accessSecret(record: StoredOperationV1): Promise<string> {
    const encrypted = await this.readAccessSecret();
    if (!encrypted) throw new Error("The one-time Access secret is unavailable");
    try {
      return await decryptAccessServiceSecret(
        this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
        encrypted,
        { jobId: record.operationId },
      );
    } catch {
      throw new ActionRequiredError("access-repair-required");
    }
  }

  private async encryptAccessSecret(
    record: StoredOperationV1,
    secret: string,
  ): Promise<EncryptedAccessSecretV1> {
    const expiresAt = new Date(Date.now() + ACCESS_SECRET_RECOVERY_MS).toISOString();
    return encryptAccessServiceSecret(
      this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
      secret,
      { jobId: record.operationId, jobExpiresAt: expiresAt },
    );
  }

  private readAccessSecret(): Promise<EncryptedAccessSecretV1 | undefined> {
    return this.ctx.storage.get<EncryptedAccessSecretV1>(ACCESS_SECRET_KEY);
  }

  private maintenanceRuntimeValues(record: StoredOperationV1): MaintenanceRuntimeValues {
    const resources = this.resources(record);
    return {
      installationId: resources.installationId,
      releaseId: record.descriptor.releaseId,
      workersDevHostname: resources.workersDevHostname,
      accessIssuer: requiredString(resources.accessIssuer, 512),
      accessAudience: requiredString(resources.accessAudience, 512),
      accessIdentityProviderId: requiredString(resources.accessIdentityProviderId, 128),
      accessApplicationId: requiredString(resources.accessApplicationId, 128),
      accessOwnerPolicyId: requiredString(resources.accessOwnerPolicyId, 128),
      accessServicePolicyId: requiredString(resources.accessServicePolicyId, 128),
      accessPublicApplicationId: requiredString(resources.accessPublicApplicationId, 128),
      accessPublicPolicyId: requiredString(resources.accessPublicPolicyId, 128),
      accessServiceTokenId: requiredString(resources.accessServiceTokenId, 128),
      accessServiceClientId: requiredString(resources.accessServiceClientId, 512),
      accessTokenExpiresAt: requiredString(resources.accessTokenExpiresAt, 128),
    };
  }

  private async validateAccessWithAnchor(
    authorization: CloudflareAuthorization,
    accountId: string,
    resources: InstallationResourcesV1,
    ownerEmail: string,
  ): Promise<InstallationResourcesV1> {
    const anchor = await this.requiredAnchor();
    if (resources.accessTokenExpiresAt === anchor.accessTokenExpiresAt) {
      await validateManagedAccess({ authorization, accountId, resources, ownerEmail });
      return resources;
    }
    const actualExpiration = await readManagedAccessExpiration({
      authorization,
      accountId,
      resources,
      ownerEmail,
    });
    if (actualExpiration !== anchor.accessTokenExpiresAt) {
      throw new AccessConflictError("The anchored Tiller Access service-token expiration changed");
    }
    return { ...resources, accessTokenExpiresAt: actualExpiration };
  }

  private async recordAccessRenewal(resources: InstallationResourcesV1): Promise<void> {
    const anchor = await this.requiredAnchor();
    if (anchor.installationId !== resources.installationId
      || anchor.resourceIdentity.accessServiceTokenId !== resources.accessServiceTokenId
      || anchor.resourceIdentity.accessServiceClientId !== resources.accessServiceClientId) {
      throw new TopologyDriftError("The Access renewal identity changed");
    }
    await this.ctx.storage.put<InstallationAnchorV1>(ANCHOR_KEY, {
      ...anchor,
      accessTokenExpiresAt: requiredString(resources.accessTokenExpiresAt, 128),
    });
  }

  private async assertTargetWorker(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    await this.assertWorker(record, authorization, true);
    const placementRegion = this.loadAnchoredPlacementRegion(record, await this.requiredAnchor());
    let versionId: string;
    try {
      versionId = await readAndVerifyMaintenanceWorker({
        authorization,
        accountId: record.accountId,
        descriptor: record.descriptor,
        resources: this.resources(record),
        values: this.maintenanceRuntimeValues(record),
        placementRegion,
      });
    } catch (error) {
      if (error instanceof PlacementTopologyError) throw new TopologyDriftError();
      throw error;
    }
    if (record.sourceVersionId && record.sourceVersionId !== versionId) {
      throw new TopologyDriftError("The active Worker changed during Container reconciliation");
    }
    record.sourceVersionId = versionId;
  }

  private assertContainerIdentity(
    application: ContainerApplication,
    applicationId: string,
    target: FixedContainerV1,
    namespaceId: string,
    name: string,
    placementRegion: PlacementRegion,
  ): void {
    if (application.id?.trim() !== applicationId) {
      throw new TopologyDriftError(`Cloudflare returned the wrong Container application for ${name}`);
    }
    try {
      assertManagedContainerTopology(
        application,
        target,
        namespaceId,
        name,
        placementRegion,
      );
    } catch {
      throw new TopologyDriftError(`Container application ${name} changed during maintenance`);
    }
  }

  private async containerRolloutContext(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<{
    cursor: NonNullable<StoredOperationV1["containerCursor"]>;
    target: FixedContainerV1;
    application: ContainerApplication;
    namespaceId: string;
    name: string;
    targetConfiguration: Record<string, unknown>;
  }> {
    await this.assertTargetWorker(record, authorization);
    const cursor = record.containerCursor;
    if (!cursor?.applicationId) throw new TopologyDriftError("Container rollout cursor is incomplete");
    const target = record.descriptor.containers[cursor.index];
    if (!target) throw new TopologyDriftError("Container rollout cursor is out of range");
    const resources = this.resources(record);
    const installed = resources.containerApplications?.[target.className];
    const namespaceId = resources.durableObjectNamespaceIds?.[target.className] ?? "";
    const name = containerApplicationName(resources.installationId, target.applicationNameSuffix);
    if (!installed || installed.id !== cursor.applicationId || installed.name !== name || !namespaceId) {
      throw new TopologyDriftError("Container rollout identity changed");
    }
    const application = await getContainerApplication(
      authorization,
      record.accountId,
      cursor.applicationId,
    );
    this.assertContainerIdentity(
      application,
      cursor.applicationId,
      target,
      namespaceId,
      name,
      this.requiredRecordPlacementRegion(record),
    );
    return {
      cursor,
      target,
      application,
      namespaceId,
      name,
      targetConfiguration: {
        image: target.image,
        instance_type: target.instanceType,
      },
    };
  }

  private matchesTargetRollout(
    rollout: ContainerRollout,
    target: FixedContainerV1,
  ): boolean {
    return rollout.description === "Tiller fixed-topology image update"
      && rollout.strategy === "rolling"
      && rollout.kind === "full_auto"
      && (rollout.step_percentage == null || rollout.step_percentage === 100)
      && matchesContainerTargetConfiguration(rollout.target_configuration, target);
  }

  private assertNoActiveRollout(rollouts: ContainerRollout[]): void {
    if (this.hasActiveRollout(rollouts)) {
      throw new TopologyDriftError(
        "A Container rollout exists without this operation's persisted rollout ID",
      );
    }
  }

  private hasActiveRollout(rollouts: ContainerRollout[]): boolean {
    return rollouts.some((rollout) => rollout.status === "pending" || rollout.status === "progressing");
  }

  private targetContainerImages(descriptor: ReleaseDescriptorV1): Record<string, string> {
    return Object.fromEntries(descriptor.containers.map((container) => [container.className, container.image]));
  }

  private recordPlacementRegion(record: StoredOperationV1): PlacementRegion | undefined {
    if (record.placementRegion === undefined) return undefined;
    if (!isPlacementRegion(record.placementRegion)) {
      throw new TopologyDriftError("The lifecycle placement region is invalid");
    }
    return record.placementRegion;
  }

  private requiredRecordPlacementRegion(record: StoredOperationV1): PlacementRegion {
    const placementRegion = this.recordPlacementRegion(record);
    if (!placementRegion) throw new TopologyDriftError("The lifecycle placement region is missing");
    return placementRegion;
  }

  private anchorPlacementRegion(anchor: InstallationAnchorV1): PlacementRegion {
    try {
      return installationAnchorPlacementRegion(anchor);
    } catch {
      throw new TopologyDriftError("The anchored placement region is invalid");
    }
  }

  private loadAnchoredPlacementRegion(
    record: StoredOperationV1,
    anchor: InstallationAnchorV1,
  ): PlacementRegion {
    const anchored = this.anchorPlacementRegion(anchor);
    const current = this.recordPlacementRegion(record);
    if (current !== undefined && current !== anchored) {
      throw new TopologyDriftError("The lifecycle placement region differs from the installation anchor");
    }
    record.placementRegion = anchored;
    return anchored;
  }

  private readAnchor(): Promise<InstallationAnchorV1 | undefined> {
    return this.ctx.storage.get<InstallationAnchorV1>(ANCHOR_KEY);
  }

  private async requiredAnchor(): Promise<InstallationAnchorV1> {
    const anchor = await this.readAnchor();
    if (!anchor) throw new TopologyDriftError("The managed installation anchor is missing");
    return anchor;
  }

  private async handleStepError(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    error: unknown,
  ): Promise<void> {
    const outcomeStep = record.step;
    if (record.intent === "install" && (record.freshMutationPending || record.mutation)) {
      await this.failClosed(record, error);
      return;
    }
    if (error instanceof CheckpointedWorkerMissingError && record.intent === "install") {
      await this.reconcileCheckpointedWorker(record, authorization, error);
      return;
    }
    if (error instanceof ContainerRegistryUnavailableError
      && record.intent === "install"
      && record.step === "ensure-container-registry"
      && !record.resources?.workerId) {
      const diagnosticError = error.cloudflareError;
      await this.revokeAndScrubAuthorization(record);
      await this.ctx.storage.delete(ACCESS_SECRET_KEY);
      record.mutationRecoveryUntil = undefined;
      record.step = "failed";
      record.projection = {
        stage: "action-required",
        issue: "container-registry-unavailable",
        detail: containerRegistryUnavailableDetail(record.operationId, diagnosticError),
      };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "action-required", diagnosticError, outcomeStep);
      return;
    }
    if (Date.now() >= authorization.deadline) {
      await this.requireReauthorization(record, error);
      return;
    }
    if (error instanceof ActionRequiredError && !record.resources?.workerId
      && !record.mutation && !record.freshMutationPending) {
      await this.revokeAndScrubAuthorization(record);
      if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
      record.step = "failed";
      record.projection = { stage: "action-required", issue: error.issue };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "action-required", error, outcomeStep);
      return;
    }
    if (error instanceof ActionRequiredError && error.issue === "access-repair-required") {
      await this.revokeAndScrubAuthorization(record);
      if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
      record.step = "failed";
      record.projection = { stage: "action-required", issue: error.issue };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "action-required", error, outcomeStep);
      return;
    }
    if (error instanceof TopologyDriftError) {
      await this.revokeAndScrubAuthorization(record);
      if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
      record.mutation = undefined;
      record.step = "failed";
      record.projection = { stage: "action-required", issue: "topology-drift" };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "action-required", error, outcomeStep);
      return;
    }
    if (error instanceof MaintenanceTerminalError) {
      await this.revokeAndScrubAuthorization(record);
      if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
      record.mutation = undefined;
      record.step = "failed";
      record.projection = {
        stage: "failed",
        error: { code: error.code, message: error.message },
      };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "terminal-failure", error, outcomeStep);
      return;
    }
    if (record.intent !== "install" && error instanceof AccessConflictError) {
      await this.revokeAndScrubAuthorization(record);
      record.mutation = undefined;
      record.step = "failed";
      record.projection = { stage: "action-required", issue: "access-repair-required" };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "action-required", error, outcomeStep);
      return;
    }
    const safeReadRetry = !record.mutation && !record.freshMutationPending && (
      error instanceof RetryableReadError
      || error instanceof AccessPropagationError
      || error instanceof RetryableBundleDownloadError
      || (error instanceof CloudflareApiError
        && error.status !== 401
        && error.status !== 403
        && (error.status === 0 || error.status === 404 || error.status === 408
          || error.status === 409 || error.status === 425
          || error.status === 429 || error.status >= 500))
    );
    if (safeReadRetry) {
      await this.schedule(RETRY_MS);
      return;
    }
    // A definite 403 is an account permission or platform rejection. A new
    // identically scoped OAuth grant cannot repair it and must not create a
    // reauthorization loop.
    if (error instanceof CloudflareApiError && error.status === 401) {
      await this.requireReauthorization(record, error);
      return;
    }
    if (record.intent !== "install" && record.mutation) {
      record.mutation = undefined;
      record.mutationRecoveryUntil = new Date(Date.now() + 10_000).toISOString();
      await this.writeAndSchedule(record, RETRY_MS);
      return;
    }
    if (record.intent !== "install") {
      await this.revokeAndScrubAuthorization(record);
      record.step = "failed";
      record.projection = {
        stage: "failed",
        error: { code: "maintenance_failed", message: "Tiller maintenance could not be completed safely." },
      };
      await this.writeOperation(record);
      this.logInstallOutcome(record, "terminal-failure", error, outcomeStep);
      return;
    }
    if (record.mutation || record.freshMutationPending
      || record.resources?.workerId || error instanceof AccessConflictError) {
      await this.failClosed(record, error);
      return;
    }
    await this.revokeAndScrubAuthorization(record);
    if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
    record.step = "failed";
    record.projection = {
      stage: "failed",
      error: {
        code: "installation_failed",
        message: "Tiller could not start this Cloudflare deployment. No existing Worker was changed.",
      },
    };
    await this.writeOperation(record);
    this.logInstallOutcome(record, "terminal-failure", error, outcomeStep);
  }

  private async reconcileCheckpointedWorker(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
    error: CheckpointedWorkerMissingError,
  ): Promise<void> {
    const recordedWorkerId = record.resources?.workerId?.trim() ?? "";
    if (!recordedWorkerId || recordedWorkerId !== error.workerId) {
      await this.failClosed(record, error.cloudflareError);
      return;
    }

    const now = Date.now();
    if (!record.workerReadback) {
      const firstMissingAt = new Date(now).toISOString();
      const retryUntil = new Date(now + WORKER_READBACK_RECONCILIATION_MS).toISOString();
      record.workerReadback = { workerId: recordedWorkerId, firstMissingAt, retryUntil };
      await this.writeAndSchedule(record, RETRY_MS);
      console.log(workerReadbackRetryEvent({
        record,
        retryUntil,
        error: error.cloudflareError,
      }));
      return;
    }

    const firstMissingAt = Date.parse(record.workerReadback.firstMissingAt);
    const retryUntil = Date.parse(record.workerReadback.retryUntil);
    if (record.workerReadback.workerId !== recordedWorkerId
      || !Number.isFinite(firstMissingAt)
      || !Number.isFinite(retryUntil)
      || retryUntil <= firstMissingAt
      || retryUntil - firstMissingAt > WORKER_READBACK_RECONCILIATION_MS) {
      await this.failClosed(record, error.cloudflareError);
      return;
    }
    if (now < retryUntil) {
      await this.schedule(Math.min(RETRY_MS, retryUntil - now));
      return;
    }

    let workers: Awaited<ReturnType<typeof listWorkers>>;
    try {
      workers = await listWorkers(authorization, record.accountId);
    } catch (verificationError) {
      await this.failClosed(record, verificationError);
      return;
    }
    if (workers.some((worker) => worker.id?.trim() === recordedWorkerId)) {
      await this.failClosed(record, error.cloudflareError);
      return;
    }

    const replacement = workers.some((worker) => worker.name === WORKER_NAME);
    await this.finishRestartRequiredInstall(
      record,
      replacement
        ? {
            stage: "action-required",
            issue: "foreign-worker-conflict",
            detail: replacementWorkerConflictDetail(record.operationId, error.cloudflareError),
          }
        : {
            stage: "action-required",
            issue: "installation-restart-required",
            detail: installationRestartRequiredDetail(record.operationId, error.cloudflareError),
            nextAction: { kind: "start-fresh", url: "/deploy" },
          },
      error.cloudflareError,
    );
  }

  private async finishRestartRequiredInstall(
    record: StoredOperationV1,
    projection: Extract<JobProjection, { stage: "action-required" }>,
    error: unknown,
  ): Promise<void> {
    const outcomeStep = record.step;
    await this.revokeAndScrubAuthorization(record);
    await this.ctx.storage.delete(ACCESS_SECRET_KEY);
    record.workerReadback = undefined;
    record.mutationRecoveryUntil = undefined;
    record.step = "failed";
    record.projection = projection;
    await this.writeOperation(record);
    await this.ctx.storage.deleteAlarm();
    this.logInstallOutcome(record, "action-required", error, outcomeStep);
  }

  private async failClosed(record: StoredOperationV1, error?: unknown): Promise<void> {
    const outcomeStep = record.step;
    await this.revokeAndScrubAuthorization(record);
    if (record.intent === "install") await this.ctx.storage.delete(ACCESS_SECRET_KEY);
    record.freshMutationPending = undefined;
    record.mutation = undefined;
    record.workerReadback = undefined;
    record.step = "failed";
    record.projection = {
      stage: "action-required",
      issue: "manual-cleanup-required",
      detail: cloudflareFailureDetail({
        operationId: record.operationId,
        step: outcomeStep,
        error,
        cleanupRequired: true,
      }),
    };
    await this.writeOperation(record);
    await this.ctx.storage.deleteAlarm();
    this.logInstallOutcome(record, "action-required", error, outcomeStep);
  }

  private async requireReauthorization(record: StoredOperationV1, error?: unknown): Promise<void> {
    if (record.intent === "install" && (record.freshMutationPending || record.mutation)) {
      await this.failClosed(record, error);
      return;
    }
    await this.revokeAndScrubAuthorization(record);
    record.projection = {
      stage: "action-required",
      issue: "reauthorization-required",
      nextAction: { kind: "reauthorize", url: this.startUrl(record.intent) },
    };
    await this.writeOperation(record);
    await this.ctx.storage.deleteAlarm();
    this.logInstallOutcome(record, "reauthorization", error);
  }

  private logInstallOutcome(
    record: StoredOperationV1,
    outcome: InstallOutcome,
    error?: unknown,
    step = record.step,
  ): void {
    const issue = record.projection.stage === "action-required"
      ? record.projection.issue
      : undefined;
    const failureCode = record.projection.stage === "failed"
      ? record.projection.error.code
      : undefined;
    console.log(installOutcomeEvent({
      operationId: record.operationId,
      step,
      outcome,
      intent: record.intent,
      releaseVersion: record.descriptor.version,
      ...(record.placementRegion ? { placementRegion: record.placementRegion } : {}),
      ...(issue ? { issue } : {}),
      ...(failureCode ? { failureCode } : {}),
      error,
    }));
  }

  private logContainerRegistryReadiness(
    record: StoredOperationV1,
    args: {
      phase: ContainerRegistryReadinessPhase;
      decision: ContainerRegistryReadinessDecision;
      registries?: readonly ContainerRegistry[];
      retryUntil?: string;
      error?: unknown;
    },
  ): void {
    console.log(containerRegistryReadinessEvent({
      operationId: record.operationId,
      intent: record.intent,
      releaseVersion: record.descriptor.version,
      ...args,
    }));
  }

  private async observeContainerRegistries(
    record: StoredOperationV1,
    authorization: CloudflareAuthorization,
  ): Promise<void> {
    try {
      const registries = await listContainerRegistries(authorization, record.accountId);
      this.logContainerRegistryReadiness(record, {
        phase: "maintenance-observation",
        decision: "observation",
        registries,
      });
    } catch (error) {
      this.logContainerRegistryReadiness(record, {
        phase: "maintenance-observation",
        decision: "observation-failed",
        error,
      });
    }
  }

  private startUrl(intent: LifecycleIntent): string {
    return intent === "install" ? "/deploy" : `/maintenance?intent=${intent}`;
  }

  private async revokeAndScrubAuthorization(record: StoredOperationV1): Promise<void> {
    if (!record.authorizationClosing) {
      record.authorizationClosing = true;
      await this.writeOperation(record);
    }
    const authorization = await this.readAuthorization();
    await this.ctx.storage.delete(AUTHORIZATION_KEY);
    if (!authorization || authorization.operationId !== record.operationId) {
      record.authorizationClosing = undefined;
      return;
    }
    const token = await decryptOAuthToken(
      this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
      authorization.current.encryptedToken,
      { jobId: record.operationId },
    ).catch(() => undefined);
    if (token) await revokeAccessToken(this.env, token).catch(() => undefined);
    record.authorizationClosing = undefined;
  }

  private authorizationDeadline(token?: EncryptedTokenV1): number {
    return Date.parse(token?.expiresAt ?? "") - AUTHORIZATION_CLEANUP_LEAD_MS;
  }

  private assertMutationWindow(authorization: CloudflareAuthorization): void {
    if (Date.now() >= authorization.deadline) {
      throw new Error("Cloudflare authorization expired before mutation");
    }
  }

  private waitingForMutationReadback(record: StoredOperationV1): boolean {
    const until = Date.parse(record.mutationRecoveryUntil ?? "");
    if (!Number.isFinite(until) || Date.now() >= until) {
      record.mutationRecoveryUntil = undefined;
      return false;
    }
    return true;
  }

  private async writeAndSchedule(record: StoredOperationV1, delay = 50): Promise<void> {
    await this.writeOperation(record);
    await this.schedule(delay);
  }

  private schedule(delay: number): Promise<void> {
    return this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private readOperation(): Promise<StoredOperationV1 | undefined> {
    return this.ctx.storage.get<StoredOperationV1>(OPERATION_KEY);
  }

  private writeOperation(record: StoredOperationV1): Promise<void> {
    return this.ctx.storage.put(OPERATION_KEY, record);
  }

  private readAuthorization(): Promise<StoredAuthorizationV1 | undefined> {
    return this.ctx.storage.get<StoredAuthorizationV1>(AUTHORIZATION_KEY);
  }
}
