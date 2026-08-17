import {
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  readBoundedResponseJson,
  withAbortDeadline,
} from "./outbound";
import type { WorkerUploadTemplateV1 } from "./release-contract";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CLOUDFLARE_ERROR_MESSAGES = 4;
const MAX_CLOUDFLARE_ERROR_MESSAGE_LENGTH = 512;

export type CloudflareApiOperation =
  | "workers.list"
  | "workers.get"
  | "container-registries.list"
  | "container-applications.list"
  | "container-applications.create"
  | "container-applications.get"
  | "container-applications.patch"
  | "container-rollouts.create"
  | "container-rollouts.list"
  | "container-rollouts.get";

interface ApiEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { page?: number; total_pages?: number };
}

interface CloudflareApiErrorOptions {
  uncertain?: boolean;
  errorCodes?: Iterable<number>;
  errorMessages?: Iterable<string>;
  rayId?: string | null;
  requestMethod?: string;
  operation?: CloudflareApiOperation;
}

function normalizedErrorMessages(values: Iterable<string>): string[] {
  const messages: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value
      .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_CLOUDFLARE_ERROR_MESSAGE_LENGTH);
    if (!normalized || messages.includes(normalized)) continue;
    messages.push(normalized);
    if (messages.length >= MAX_CLOUDFLARE_ERROR_MESSAGES) break;
  }
  return messages;
}

function normalizedRayId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim() ?? "";
  return normalized && normalized.length <= 80 && /^[a-z0-9-]+$/i.test(normalized)
    ? normalized
    : undefined;
}

export class CloudflareApiError extends Error {
  readonly status: number;
  readonly uncertain: boolean;
  readonly errorCodes: readonly number[];
  readonly errorMessages: readonly string[];
  readonly rayId?: string;
  readonly requestMethod?: string;
  readonly operation?: CloudflareApiOperation;

  constructor(status: number, options: CloudflareApiErrorOptions = {}) {
    super("Cloudflare API request failed");
    this.name = "CloudflareApiError";
    this.status = status;
    this.uncertain = options.uncertain === true;
    this.errorCodes = [...new Set(options.errorCodes ?? [])]
      .filter((code) => Number.isSafeInteger(code) && code >= 0)
      .slice(0, 16);
    this.errorMessages = normalizedErrorMessages(options.errorMessages ?? []);
    this.rayId = normalizedRayId(options.rayId);
    const requestMethod = options.requestMethod?.trim().toUpperCase() ?? "";
    this.requestMethod = /^[A-Z]{3,10}$/.test(requestMethod) ? requestMethod : undefined;
    this.operation = options.operation;
  }
}

/** A plaintext OAuth grant scoped to one active install turn. */
export interface CloudflareAuthorization {
  accessToken: string;
  deadline: number;
}

function errorCodes(envelope: ApiEnvelope<unknown> | null): number[] {
  if (!Array.isArray(envelope?.errors)) return [];
  return envelope.errors
    .map((entry) => entry?.code)
    .filter((code): code is number => Number.isSafeInteger(code) && (code ?? -1) >= 0)
    .slice(0, 16);
}

function errorMessages(envelope: ApiEnvelope<unknown> | null): string[] {
  if (!Array.isArray(envelope?.errors)) return [];
  return normalizedErrorMessages(envelope.errors
    .map((entry) => entry?.message)
    .filter((message): message is string => typeof message === "string"));
}

function mutationCouldHaveCommitted(status: number): boolean {
  return status === 0 || (status >= 200 && status < 400) || status >= 500;
}

function deadlineTimeout(deadline: number): number {
  if (!Number.isFinite(deadline)) throw new CloudflareApiError(0);
  const remaining = Math.floor(deadline - Date.now());
  if (remaining <= 0) throw new CloudflareApiError(0);
  return Math.min(DEFAULT_OUTBOUND_TIMEOUT_MS, remaining);
}

export async function cloudflareApi<T>(
  authorization: CloudflareAuthorization,
  path: string,
  init: RequestInit = {},
  options: {
    mutation?: boolean;
    maxBytes?: number;
    operation?: CloudflareApiOperation;
    captureErrorMessages?: boolean;
  } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  let observedStatus = 0;
  let observedRayId: string | undefined;
  let completed: { response: Response; body: ApiEnvelope<T> | null };
  const timeoutMs = deadlineTimeout(authorization.deadline);
  try {
    completed = await withAbortDeadline(async (signal) => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${authorization.accessToken}`);
      headers.set("Accept", "application/json");
      if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const response = await fetch(`${API_BASE}${path}`, {
        ...init,
        method,
        headers,
        signal,
        redirect: "manual",
      });
      observedStatus = response.status;
      observedRayId = normalizedRayId(response.headers.get("cf-ray"));
      return {
        response,
        body: response.status === 204
          ? ({ success: true, result: undefined } as ApiEnvelope<T>)
          : await readBoundedResponseJson<ApiEnvelope<T>>(
              response,
              options.maxBytes ?? MAX_API_RESPONSE_BYTES,
            ),
      };
    }, timeoutMs);
  } catch {
    throw new CloudflareApiError(observedStatus, {
      uncertain: options.mutation === true && mutationCouldHaveCommitted(observedStatus),
      rayId: observedRayId,
      requestMethod: method,
      operation: options.operation,
    });
  }

  const valid = completed.response.status === 204
    || (completed.body?.success === true && completed.body.result !== undefined && completed.body.result !== null);
  if (!completed.response.ok || !valid) {
    throw new CloudflareApiError(completed.response.status, {
      uncertain: options.mutation === true && mutationCouldHaveCommitted(completed.response.status),
      errorCodes: errorCodes(completed.body),
      ...(options.captureErrorMessages
        ? { errorMessages: errorMessages(completed.body) }
        : {}),
      rayId: observedRayId,
      requestMethod: method,
      operation: options.operation,
    });
  }
  return completed.body?.result as T;
}

async function listPaginated<T>(
  authorization: CloudflareAuthorization,
  path: string,
  options: {
    operation?: CloudflareApiOperation;
    captureErrorMessages?: boolean;
  } = {},
  maxPages = 20,
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const requestPath = `${path}${separator}page=${page}&per_page=50`;
    let observedStatus = 0;
    let observedRayId: string | undefined;
    const timeoutMs = deadlineTimeout(authorization.deadline);
    const completed = await withAbortDeadline(async (signal) => {
      const response = await fetch(`${API_BASE}${requestPath}`, {
        signal,
        redirect: "manual",
        headers: { Authorization: `Bearer ${authorization.accessToken}`, Accept: "application/json" },
      });
      observedStatus = response.status;
      observedRayId = normalizedRayId(response.headers.get("cf-ray"));
      return {
        response,
        body: await readBoundedResponseJson<ApiEnvelope<T[]>>(response, MAX_API_RESPONSE_BYTES),
      };
    }, timeoutMs).catch(() => {
      throw new CloudflareApiError(observedStatus, {
        rayId: observedRayId,
        requestMethod: "GET",
        operation: options.operation,
      });
    });
    if (!completed.response.ok || completed.body?.success !== true || !Array.isArray(completed.body.result)) {
      throw new CloudflareApiError(completed.response.status, {
        errorCodes: errorCodes(completed.body),
        ...(options.captureErrorMessages
          ? { errorMessages: errorMessages(completed.body) }
          : {}),
        rayId: observedRayId,
        requestMethod: "GET",
        operation: options.operation,
      });
    }
    values.push(...completed.body.result);
    const totalPages = completed.body.result_info?.total_pages;
    if (typeof totalPages === "number" ? page >= totalPages : completed.body.result.length < 50) return values;
  }
  throw new CloudflareApiError(502, { requestMethod: "GET", operation: options.operation });
}

export interface CloudflareAccount { id?: string | null }
export interface CloudflareUser { email?: string | null }
export interface CloudflareWorker {
  id?: string | null;
  name?: string | null;
  subdomain?: { enabled?: boolean; previews_enabled?: boolean } | null;
  deployed_on?: string | null;
  tags?: string[] | null;
  observability?: { enabled?: boolean; head_sampling_rate?: number } | null;
}
export interface WorkerSubdomain { enabled?: boolean; previews_enabled?: boolean }
export interface WorkerBinding {
  type?: string;
  name?: string;
  text?: string;
  namespace_id?: string;
  bucket_name?: string;
  class_name?: string;
  script_name?: string | null;
  environment?: string | null;
  [key: string]: unknown;
}
export interface WorkerSettings {
  annotations?: {
    "workers/message"?: string;
    "workers/tag"?: string;
    "workers/triggered_by"?: string;
  };
  bindings?: WorkerBinding[];
  main_module?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  exports?: Record<string, unknown>;
  assets?: unknown;
  cache_options?: { enabled?: boolean; cross_version_cache?: boolean } | null;
  limits?: { cpu_ms?: number; subrequests?: number } | null;
  logpush?: boolean | null;
  observability?: { enabled?: boolean; head_sampling_rate?: number };
  placement?: unknown;
  tags?: string[] | null;
  tail_consumers?: unknown[] | null;
  usage_model?: "standard" | "bundled" | "unbound" | null;
  containers?: Array<{ class_name?: string | null }>;
  [key: string]: unknown;
}
export interface WorkerUploadResponse {
  id?: string | null;
  exports_reconciliation?: {
    created?: string[];
    deleted?: string[];
    updated?: string[];
    renamed?: unknown[];
    transferred?: unknown[];
    transfer_pending?: unknown[];
    warnings?: unknown[];
    info?: unknown[];
    removable_entries?: string[];
  };
}
export interface WorkerDeployment {
  id?: string | null;
  created_on?: string | null;
  source?: string | null;
  strategy?: "percentage" | null;
  versions?: Array<{ version_id?: string | null; percentage?: number | null }> | null;
  annotations?: {
    "workers/message"?: string;
    "workers/triggered_by"?: string;
  } | null;
  author_email?: string | null;
}
export interface WorkerVersionDetails {
  id?: string | null;
  number?: number | null;
  metadata?: {
    author_email?: string | null;
    author_id?: string | null;
    created_on?: string | null;
    modified_on?: string | null;
    hasPreview?: boolean | null;
    source?: string | null;
  } | null;
  resources?: {
    bindings?: WorkerBinding[] | null;
    script?: {
      etag?: string | null;
      handlers?: string[] | null;
      last_deployed_from?: string | null;
      named_handlers?: Array<{ name?: string | null; handlers?: string[] | null }> | null;
    } | null;
    script_runtime?: {
      assets?: unknown;
      compatibility_date?: string | null;
      compatibility_flags?: string[] | null;
      containers?: Array<{ class_name?: string | null }> | null;
      exports?: Record<string, unknown> | null;
      limits?: { cpu_ms?: number | null } | null;
      migration_tag?: string | null;
      usage_model?: "bundled" | "unbound" | "standard" | null;
    } | null;
  } | null;
}
export interface ActiveWorkerVersion {
  deployment: WorkerDeployment;
  versionId: string;
  version: WorkerVersionDetails;
  settings: WorkerSettings;
}
interface WorkerVersionsList { items?: WorkerVersionDetails[] | null }
export interface KvNamespace { id?: string | null; title?: string | null }
export interface R2Bucket { name?: string | null }
export interface ContainerApplicationSummary {
  id?: string | null;
  name?: string | null;
}
export interface ContainerRegistry {
  domain?: string | null;
  kind?: string | null;
}
export interface ContainerApplication {
  id?: string | null;
  name?: string | null;
  instances?: number;
  max_instances: number | undefined;
  constraints?: unknown;
  affinities?: unknown;
  scheduling_policy: string | undefined;
  rollout_active_grace_period?: number;
  configuration: Record<string, unknown> | undefined;
  durable_objects: { namespace_id?: string | null } | null | undefined;
}
export interface ContainerApplicationPatch {
  configuration: Record<string, unknown>;
  max_instances?: number;
  constraints?: unknown;
  affinities?: unknown;
  scheduling_policy?: string;
  rollout_active_grace_period?: number;
}
export type ContainerRolloutStatus = "pending" | "progressing" | "completed" | "reverted" | "replaced";
export interface ContainerRollout {
  id?: string | null;
  description?: string | null;
  status?: ContainerRolloutStatus | null;
  kind?: "full_auto" | "full_manual" | "durable_objects_auto" | null;
  strategy?: "rolling" | null;
  target_configuration?: Record<string, unknown> | null;
  step_percentage?: 5 | 10 | 20 | 25 | 50 | 100 | null;
  created_at?: string | null;
  updated_at?: string | null;
  health?: {
    instances?: {
      healthy?: number | null;
      starting?: number | null;
      failed?: number | null;
    } | null;
  } | null;
  progress?: {
    total_instances?: number | null;
  } | null;
}
export interface AccessOrganization { auth_domain?: string | null; name?: string | null }
export interface AccessIdentityProvider {
  id?: string | null;
  type?: string | null;
  read_only?: boolean | null;
  config?: { restrict_to_account_members?: boolean | null } | null;
}
export interface AccessDestination {
  type?: string;
  uri?: string | null;
  worker_id?: string | null;
}
export interface AccessApplication {
  id?: string | null;
  aud?: string | null;
  domain?: string | null;
  name?: string | null;
  type?: string | null;
  destinations?: AccessDestination[] | null;
  allowed_idps?: string[] | null;
  auto_redirect_to_identity?: boolean | null;
  app_launcher_visible?: boolean | null;
  service_auth_401_redirect?: boolean | null;
  session_duration?: string | null;
}
export interface AccessPolicy {
  id?: string | null;
  name?: string | null;
  decision?: string | null;
  include?: unknown[] | null;
  exclude?: unknown[] | null;
  require?: unknown[] | null;
}
export interface AccessServiceToken {
  id?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
  expires_at?: string | null;
  duration?: string | null;
  name?: string | null;
}

export const getUser = (authorization: CloudflareAuthorization) => cloudflareApi<CloudflareUser>(authorization, "/user");
export const listAccounts = (authorization: CloudflareAuthorization) => listPaginated<CloudflareAccount>(authorization, "/accounts");
export const getWorkersSubdomain = (authorization: CloudflareAuthorization, accountId: string) => cloudflareApi<{ subdomain?: string | null }>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/subdomain`,
);
export const listWorkers = (authorization: CloudflareAuthorization, accountId: string) => listPaginated<CloudflareWorker>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/workers`,
  { operation: "workers.list" },
);
export const getWorker = (authorization: CloudflareAuthorization, accountId: string, workerId: string) => cloudflareApi<CloudflareWorker>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/workers/${encodeURIComponent(workerId)}`,
  {},
  { operation: "workers.get" },
);
export const createDisabledWorker = (
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  observability: WorkerUploadTemplateV1["observability"],
) => cloudflareApi<CloudflareWorker>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/workers`,
  {
    method: "POST",
    body: JSON.stringify({
      name,
      subdomain: { enabled: false, previews_enabled: false },
      observability: {
        enabled: observability.enabled,
        head_sampling_rate: observability.headSamplingRate,
      },
      tags: ["tiller-installer-v1"],
    }),
  },
  { mutation: true },
);
export const getWorkerSubdomain = (authorization: CloudflareAuthorization, accountId: string, name: string) => cloudflareApi<WorkerSubdomain>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/subdomain`,
);
export const setWorkerSubdomain = (
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  enabled: boolean,
) => cloudflareApi<WorkerSubdomain>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/subdomain`,
  { method: "POST", body: JSON.stringify({ enabled, previews_enabled: false }) },
  { mutation: true },
);
export const getWorkerSettings = (authorization: CloudflareAuthorization, accountId: string, name: string) => cloudflareApi<WorkerSettings>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/settings`,
);
export const getWorkerScriptSettings = (
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
) => cloudflareApi<WorkerSettings>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/script-settings`,
);
export const getWorkerVersion = (
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  versionId: string,
) => cloudflareApi<WorkerVersionDetails>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}`,
);

async function getLatestWorkerVersionId(
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  retryPropagation = false,
): Promise<string> {
  const result = await cloudflareApi<WorkerVersionsList>(
    authorization,
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/versions?page=1&per_page=1`,
  );
  const id = result.items?.[0]?.id?.trim() ?? "";
  if (!id) {
    if (retryPropagation) throw new CloudflareApiError(409);
    throw new Error("Cloudflare did not return the latest Worker version");
  }
  return id;
}

/** Pins the only version receiving all traffic and reads its exact versioned and script settings. */
export async function getActiveWorkerVersion(
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  options: { retryPropagation?: boolean } = {},
): Promise<ActiveWorkerVersion> {
  const deploymentPath = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/deployments`;
  const readDeployment = () => cloudflareApi<{ deployments?: WorkerDeployment[] | null }>(
    authorization,
    deploymentPath,
  );
  const exclusive = (result: { deployments?: WorkerDeployment[] | null }) => {
    const deployment = result.deployments?.[0];
    const deployedVersions = deployment?.versions;
    const versionId = deployedVersions?.[0]?.version_id?.trim() ?? "";
    if (!deployment || deployedVersions?.length !== 1
      || deployedVersions[0].percentage !== 100 || !versionId) {
      if (options.retryPropagation) throw new CloudflareApiError(409);
      throw new Error("The active Worker deployment must have exactly one version at 100% traffic");
    }
    return { deployment, versionId };
  };
  const first = exclusive(await readDeployment());
  const [version, latestBefore] = await Promise.all([
    getWorkerVersion(authorization, accountId, name, first.versionId),
    getLatestWorkerVersionId(authorization, accountId, name, options.retryPropagation),
  ]);
  if (latestBefore !== first.versionId) {
    if (options.retryPropagation) throw new CloudflareApiError(409);
    throw new Error("The active Worker version is not the most recent upload");
  }
  const [settings, scriptSettings] = await Promise.all([
    getWorkerSettings(authorization, accountId, name),
    getWorkerScriptSettings(authorization, accountId, name),
  ]);
  const [second, latestAfter] = await Promise.all([
    readDeployment().then(exclusive),
    getLatestWorkerVersionId(authorization, accountId, name, options.retryPropagation),
  ]);
  if (version.id?.trim() !== first.versionId
    || latestAfter !== first.versionId
    || second.versionId !== first.versionId
    || second.deployment.id?.trim() !== first.deployment.id?.trim()) {
    if (options.retryPropagation) throw new CloudflareApiError(409);
    throw new Error("Cloudflare returned the wrong active Worker version");
  }
  const runtime = version.resources?.script_runtime;
  const completeSettings: WorkerSettings = {
    ...settings,
    annotations: undefined,
    bindings: version.resources?.bindings ?? undefined,
    assets: runtime?.assets,
    compatibility_date: runtime?.compatibility_date ?? undefined,
    compatibility_flags: runtime?.compatibility_flags ?? undefined,
    containers: runtime?.containers ?? undefined,
    exports: runtime?.exports ?? undefined,
    limits: runtime?.limits == null
      ? settings.limits
      : {
          ...(settings.limits ?? {}),
          ...(typeof runtime.limits.cpu_ms === "number" ? { cpu_ms: runtime.limits.cpu_ms } : {}),
        },
    usage_model: runtime?.usage_model ?? undefined,
    logpush: scriptSettings.logpush,
    observability: scriptSettings.observability,
    tags: scriptSettings.tags,
    tail_consumers: scriptSettings.tail_consumers,
  };
  return {
    deployment: second.deployment,
    versionId: second.versionId,
    version,
    settings: completeSettings,
  };
}

function moduleForm(metadata: Record<string, unknown>, modules: Array<{ name: string; content: Uint8Array; contentType?: string }>): FormData {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  for (const module of modules) {
    const content = new Uint8Array(module.content.byteLength);
    content.set(module.content);
    form.set(module.name, new File(
      [content.buffer],
      module.name,
      { type: module.contentType ?? "application/javascript+module" },
    ));
  }
  return form;
}

/** Upload and immediately deploy the one fresh Hub version. */
export const uploadWorkerScript = (
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  metadata: Record<string, unknown>,
  modules: Array<{ name: string; content: Uint8Array; contentType?: string }>,
) => cloudflareApi<WorkerUploadResponse>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}?excludeScript=true`,
  { method: "PUT", body: moduleForm(metadata, modules) },
  { mutation: true },
);

/** Coupled maintenance upload with secrets inherited from one pinned source version. */
export async function uploadWorkerScriptWithInheritance(
  authorization: CloudflareAuthorization,
  accountId: string,
  name: string,
  metadata: Record<string, unknown>,
  modules: Array<{ name: string; content: Uint8Array; contentType?: string }>,
  sourceVersionId: string,
  inheritedBindingNames: readonly string[],
): Promise<WorkerUploadResponse> {
  const versionId = sourceVersionId.trim();
  const bindings = metadata.bindings;
  if (!versionId || !Array.isArray(bindings)) {
    throw new Error("Worker maintenance upload inheritance is invalid");
  }
  const directNames = new Set(bindings.map((binding) => (
    typeof binding === "object" && binding !== null && "name" in binding
      ? String((binding as { name?: unknown }).name ?? "")
      : ""
  )));
  const inheritedNames = inheritedBindingNames.map((bindingName) => bindingName.trim());
  if (inheritedNames.length === 0
    || inheritedNames.some((bindingName) => !bindingName)
    || new Set(inheritedNames).size !== inheritedNames.length
    || inheritedNames.some((bindingName) => directNames.has(bindingName))) {
    throw new Error("Worker maintenance upload inheritance is invalid");
  }

  // Cloudflare's coupled Script Upload endpoint only accepts the literal
  // `latest` as an inheritance source. Re-read it immediately before the PUT
  // and require it to still be the active version pinned by topology readback.
  // The account-scoped lifecycle DO serializes all installer mutations.
  const latestVersionId = await getLatestWorkerVersionId(authorization, accountId, name);
  if (latestVersionId !== versionId) {
    throw new Error("The pinned Worker version is no longer the latest upload");
  }
  const inheritedMetadata = {
    ...metadata,
    bindings: [
      ...bindings,
      ...inheritedNames.map((bindingName) => ({
        type: "inherit",
        name: bindingName,
        version_id: "latest",
      })),
    ],
  };
  return cloudflareApi<WorkerUploadResponse>(
    authorization,
    `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}?excludeScript=true&bindings_inherit=strict`,
    { method: "PUT", body: moduleForm(inheritedMetadata, modules) },
    { mutation: true },
  );
}

export const listKvNamespaces = (authorization: CloudflareAuthorization, accountId: string) => listPaginated<KvNamespace>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
);
export const createKvNamespace = (authorization: CloudflareAuthorization, accountId: string, title: string) => cloudflareApi<KvNamespace>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
  { method: "POST", body: JSON.stringify({ title }) },
  { mutation: true },
);
export const getR2Bucket = (authorization: CloudflareAuthorization, accountId: string, name: string) => cloudflareApi<R2Bucket>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(name)}`,
);
export const createR2Bucket = (authorization: CloudflareAuthorization, accountId: string, name: string) => cloudflareApi<R2Bucket>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/r2/buckets`,
  { method: "POST", body: JSON.stringify({ name }) },
  { mutation: true },
);
export const listContainerRegistries = (authorization: CloudflareAuthorization, accountId: string) => cloudflareApi<ContainerRegistry[]>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/registries`,
  {},
  { operation: "container-registries.list", captureErrorMessages: true },
);
export const listContainerApplications = (authorization: CloudflareAuthorization, accountId: string) => cloudflareApi<ContainerApplicationSummary[]>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications`,
  {},
  { operation: "container-applications.list", captureErrorMessages: true },
);
export const createContainerApplication = (
  authorization: CloudflareAuthorization,
  accountId: string,
  body: Record<string, unknown>,
) => cloudflareApi<ContainerApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications`,
  { method: "POST", body: JSON.stringify(body) },
  {
    mutation: true,
    operation: "container-applications.create",
    captureErrorMessages: true,
  },
);
export const getContainerApplication = (authorization: CloudflareAuthorization, accountId: string, applicationId: string) => cloudflareApi<ContainerApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}`,
  {},
  { operation: "container-applications.get", captureErrorMessages: true },
);
export const patchContainerApplication = (
  authorization: CloudflareAuthorization,
  accountId: string,
  applicationId: string,
  body: ContainerApplicationPatch,
) => cloudflareApi<ContainerApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}`,
  { method: "PATCH", body: JSON.stringify(body) },
  {
    mutation: true,
    operation: "container-applications.patch",
    captureErrorMessages: true,
  },
);
export const createImmediateContainerRollout = (
  authorization: CloudflareAuthorization,
  accountId: string,
  applicationId: string,
  targetConfiguration: Record<string, unknown>,
) => cloudflareApi<ContainerRollout>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}/rollouts`,
  {
    method: "POST",
    body: JSON.stringify({
      description: "Tiller fixed-topology image update",
      strategy: "rolling",
      target_configuration: targetConfiguration,
      step_percentage: 100,
      kind: "full_auto",
    }),
  },
  {
    mutation: true,
    operation: "container-rollouts.create",
    captureErrorMessages: true,
  },
);
export const listContainerRollouts = (
  authorization: CloudflareAuthorization,
  accountId: string,
  applicationId: string,
) => cloudflareApi<ContainerRollout[]>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}/rollouts`,
  {},
  { operation: "container-rollouts.list", captureErrorMessages: true },
);
export const getContainerRollout = (
  authorization: CloudflareAuthorization,
  accountId: string,
  applicationId: string,
  rolloutId: string,
) => cloudflareApi<ContainerRollout>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}/rollouts/${encodeURIComponent(rolloutId)}`,
  {},
  { operation: "container-rollouts.get", captureErrorMessages: true },
);
export const getAccessOrganization = async (authorization: CloudflareAuthorization, accountId: string): Promise<AccessOrganization | null> => {
  try {
    return await cloudflareApi<AccessOrganization>(authorization, `/accounts/${encodeURIComponent(accountId)}/access/organizations`);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return null;
    throw error;
  }
};
export const createAccessOrganization = (authorization: CloudflareAuthorization, accountId: string, body: Record<string, unknown>) => cloudflareApi<AccessOrganization>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/organizations`,
  { method: "POST", body: JSON.stringify(body) },
  { mutation: true },
);
export const listIdentityProviders = (authorization: CloudflareAuthorization, accountId: string) => listPaginated<AccessIdentityProvider>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
);
export const createIdentityProvider = (authorization: CloudflareAuthorization, accountId: string) => cloudflareApi<AccessIdentityProvider>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/identity_providers`,
  {
    method: "POST",
    body: JSON.stringify({
      name: "Tiller owner sign-in",
      type: "cloudflare",
      config: { restrict_to_account_members: true },
    }),
  },
  { mutation: true },
);
export const listAccessApplications = (authorization: CloudflareAuthorization, accountId: string) => listPaginated<AccessApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/apps`,
);
export const getAccessApplication = (authorization: CloudflareAuthorization, accountId: string, appId: string) => cloudflareApi<AccessApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}`,
);
export const createAccessApplication = (authorization: CloudflareAuthorization, accountId: string, body: Record<string, unknown>) => cloudflareApi<AccessApplication>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/apps`,
  { method: "POST", body: JSON.stringify(body) },
  { mutation: true },
);
export const listAccessPolicies = (authorization: CloudflareAuthorization, accountId: string, appId: string) => listPaginated<AccessPolicy>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
);
export const createAccessPolicy = (authorization: CloudflareAuthorization, accountId: string, appId: string, body: Record<string, unknown>) => cloudflareApi<AccessPolicy>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/apps/${encodeURIComponent(appId)}/policies`,
  { method: "POST", body: JSON.stringify(body) },
  { mutation: true },
);
export const createAccessServiceToken = (authorization: CloudflareAuthorization, accountId: string, name: string) => cloudflareApi<AccessServiceToken>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/service_tokens`,
  { method: "POST", body: JSON.stringify({ name, duration: "8760h" }) },
  { mutation: true },
);
export const listAccessServiceTokens = (authorization: CloudflareAuthorization, accountId: string) => listPaginated<AccessServiceToken>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/service_tokens`,
);
export const getAccessServiceToken = (authorization: CloudflareAuthorization, accountId: string, id: string) => cloudflareApi<AccessServiceToken>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/service_tokens/${encodeURIComponent(id)}`,
);
export const refreshAccessServiceToken = (
  authorization: CloudflareAuthorization,
  accountId: string,
  id: string,
) => cloudflareApi<AccessServiceToken>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/access/service_tokens/${encodeURIComponent(id)}/refresh`,
  { method: "POST" },
  { mutation: true },
);
export const createAssetUploadSession = (
  authorization: CloudflareAuthorization,
  accountId: string,
  workerName: string,
  manifest: Record<string, { hash: string; size: number }>,
) => cloudflareApi<{ buckets?: string[][]; jwt?: string }>(
  authorization,
  `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/assets-upload-session`,
  { method: "POST", body: JSON.stringify({ manifest }) },
  { mutation: true },
);

export async function uploadAssetBatch(
  accountId: string,
  jwt: string,
  files: Array<{ hash: string; content: Uint8Array; contentType: string }>,
  deadline: number,
): Promise<{ jwt?: string }> {
  const form = new FormData();
  for (const file of files) {
    let binary = "";
    for (const byte of file.content) binary += String.fromCharCode(byte);
    form.append(file.hash, new File([btoa(binary)], file.hash, { type: file.contentType }), file.hash);
  }
  const timeoutMs = deadlineTimeout(deadline);
  let observedStatus = 0;
  let observedRayId: string | undefined;
  const completed = await withAbortDeadline(async (signal) => {
    const response = await fetch(`${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/assets/upload?base64=true`, {
      method: "POST",
      signal,
      redirect: "manual",
      headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json" },
      body: form,
    });
    observedStatus = response.status;
    observedRayId = normalizedRayId(response.headers.get("cf-ray"));
    return {
      response,
      body: await readBoundedResponseJson<ApiEnvelope<{ jwt?: string }>>(response, MAX_API_RESPONSE_BYTES),
    };
  }, timeoutMs).catch(() => {
    throw new CloudflareApiError(observedStatus, {
      uncertain: mutationCouldHaveCommitted(observedStatus),
      rayId: observedRayId,
      requestMethod: "POST",
    });
  });
  if (!completed.response.ok || completed.body?.success !== true || !completed.body.result) {
    throw new CloudflareApiError(completed.response.status, {
      uncertain: mutationCouldHaveCommitted(completed.response.status),
      errorCodes: errorCodes(completed.body),
      rayId: observedRayId,
      requestMethod: "POST",
    });
  }
  return completed.body.result;
}

export async function uploadSingleAsset(
  accountId: string,
  jwt: string,
  file: { hash: string; content: Uint8Array; contentType: string },
  deadline: number,
): Promise<{ jwt?: string }> {
  const content = new Uint8Array(file.content.byteLength);
  content.set(file.content);
  const timeoutMs = deadlineTimeout(deadline);
  let observedStatus = 0;
  let observedRayId: string | undefined;
  const completed = await withAbortDeadline(async (signal) => {
    const response = await fetch(
      `${API_BASE}/accounts/${encodeURIComponent(accountId)}/workers/assets/upload/${encodeURIComponent(file.hash)}`,
      {
        method: "POST",
        signal,
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json",
          "Content-Type": file.contentType,
        },
        body: content.buffer,
      },
    );
    observedStatus = response.status;
    observedRayId = normalizedRayId(response.headers.get("cf-ray"));
    return {
      response,
      body: await readBoundedResponseJson<ApiEnvelope<{ jwt?: string }>>(response, MAX_API_RESPONSE_BYTES),
    };
  }, timeoutMs).catch(() => {
    throw new CloudflareApiError(observedStatus, {
      uncertain: mutationCouldHaveCommitted(observedStatus),
      rayId: observedRayId,
      requestMethod: "POST",
    });
  });
  if (!completed.response.ok || completed.body?.success !== true || !completed.body.result) {
    throw new CloudflareApiError(completed.response.status, {
      uncertain: mutationCouldHaveCommitted(completed.response.status),
      errorCodes: errorCodes(completed.body),
      rayId: observedRayId,
      requestMethod: "POST",
    });
  }
  return completed.body.result;
}
