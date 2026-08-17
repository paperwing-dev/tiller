/** Installer-owned runtime values supplied on fresh upload and reconciled during maintenance. */
export const INSTALLER_RUNTIME_BINDING_SCHEMA = {
  installerSchema: { type: "plain_text", name: "TILLER_INSTALLER_SCHEMA", runtimeSlot: "installer-schema" },
  installationId: { type: "plain_text", name: "TILLER_INSTALLATION_ID", runtimeSlot: "installation-id" },
  releaseId: { type: "plain_text", name: "TILLER_RELEASE_ID", runtimeSlot: "release-id" },
  workersDevHostname: { type: "plain_text", name: "TILLER_WORKERS_DEV_HOSTNAME", runtimeSlot: "workers-dev-hostname" },
  accessIssuer: { type: "plain_text", name: "CF_ACCESS_ISSUER", runtimeSlot: "access-issuer" },
  accessAudience: { type: "plain_text", name: "CF_ACCESS_AUDIENCE", runtimeSlot: "access-audience" },
  accessIdentityProviderId: { type: "plain_text", name: "CF_ACCESS_IDENTITY_PROVIDER_ID", runtimeSlot: "access-identity-provider-id" },
  accessApplicationId: { type: "plain_text", name: "CF_ACCESS_APPLICATION_ID", runtimeSlot: "access-application-id" },
  accessOwnerPolicyId: { type: "plain_text", name: "CF_ACCESS_OWNER_POLICY_ID", runtimeSlot: "access-owner-policy-id" },
  accessServicePolicyId: { type: "plain_text", name: "CF_ACCESS_SERVICE_POLICY_ID", runtimeSlot: "access-service-policy-id" },
  accessPublicApplicationId: { type: "plain_text", name: "CF_ACCESS_PUBLIC_APPLICATION_ID", runtimeSlot: "access-public-application-id" },
  accessPublicPolicyId: { type: "plain_text", name: "CF_ACCESS_PUBLIC_POLICY_ID", runtimeSlot: "access-public-policy-id" },
  accessServiceTokenId: { type: "plain_text", name: "CF_ACCESS_SERVICE_TOKEN_ID", runtimeSlot: "access-service-token-id" },
  accessServiceClientId: { type: "plain_text", name: "CF_ACCESS_SERVICE_CLIENT_ID", runtimeSlot: "access-service-client-id" },
  accessTokenExpiresAt: { type: "plain_text", name: "CF_ACCESS_TOKEN_EXPIRES_AT", runtimeSlot: "access-token-expires-at" },
  ownerEmail: { type: "secret_text", name: "TILLER_OWNER_EMAIL", runtimeSlot: "owner-email" },
  accessServiceClientSecret: { type: "secret_text", name: "CF_ACCESS_SERVICE_CLIENT_SECRET", runtimeSlot: "access-service-client-secret" },
} as const;

export type InstallerRuntimeBindingKey = keyof typeof INSTALLER_RUNTIME_BINDING_SCHEMA;
export type RuntimeBindingSlot = typeof INSTALLER_RUNTIME_BINDING_SCHEMA[InstallerRuntimeBindingKey]["runtimeSlot"];
export const INSTALLER_RUNTIME_BINDINGS = Object.values(INSTALLER_RUNTIME_BINDING_SCHEMA);

function bindingNames<Schema extends Record<string, { name: string }>>(schema: Schema): {
  readonly [Key in keyof Schema]: Schema[Key]["name"];
} {
  return Object.fromEntries(Object.entries(schema).map(([key, binding]) => [key, binding.name])) as {
    readonly [Key in keyof Schema]: Schema[Key]["name"];
  };
}

export const INSTALLER_BINDING_NAMES = bindingNames(INSTALLER_RUNTIME_BINDING_SCHEMA);

export function installerRuntimeBindingKey(slot: RuntimeBindingSlot): InstallerRuntimeBindingKey {
  const match = Object.entries(INSTALLER_RUNTIME_BINDING_SCHEMA)
    .find(([, binding]) => binding.runtimeSlot === slot);
  if (!match) throw new Error(`Unknown installer runtime binding slot ${slot}`);
  return match[0] as InstallerRuntimeBindingKey;
}

export type WorkerUploadBindingV1 =
  | { type: "durable_object_namespace"; name: string; className: string }
  | { type: "kv_namespace"; name: string; resourceSlot: "installation-kv" }
  | { type: "r2_bucket"; name: string; resourceSlot: "installation-r2" }
  | { type: "ai" | "assets" | "worker_loader"; name: string }
  | { type: "plain_text"; name: string; text: string }
  | { type: "plain_text"; name: string; runtimeSlot: RuntimeBindingSlot }
  | { type: "secret_text"; name: string; runtimeSlot: RuntimeBindingSlot };

export interface WorkerUploadExportV1 {
  type: "durable-object";
  storage: "sqlite";
}

export interface WorkerUploadTemplateV1 {
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  observability: { enabled: boolean; headSamplingRate: number };
  assets: { notFoundHandling: "single-page-application" | "404-page" | "none" };
  bindings: WorkerUploadBindingV1[];
  exports: Record<string, WorkerUploadExportV1>;
}

export interface FixedContainerV1 {
  className: string;
  applicationNameSuffix: string;
  image: `${string}@sha256:${string}`;
  instanceType: string;
  maxInstances: number;
}

export interface ReleaseDescriptorV1 {
  schemaVersion: 1;
  releaseId: string;
  version: string;
  releaseNotesUrl: string;
  bundle: { url: string; size: number; sha256: string };
  uploadTemplate: WorkerUploadTemplateV1;
  containers: FixedContainerV1[];
}

export const V1_CONTAINER_REGISTRY_DOMAIN = "docker.io" as const;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_IMAGE = /^\S+@sha256:[0-9a-f]{64}$/;
const DOCKER_HUB_DIGEST_IMAGE = /^docker\.io\/[^\s@]+@sha256:[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_SLOTS = new Set<RuntimeBindingSlot>(
  INSTALLER_RUNTIME_BINDINGS.map((binding) => binding.runtimeSlot),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isV1ContainerImage(value: unknown): value is FixedContainerV1["image"] {
  return typeof value === "string" && DOCKER_HUB_DIGEST_IMAGE.test(value);
}

function stringValue(value: unknown, label: string, maxLength = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unsupported shape`);
  }
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = new URL(stringValue(value, label));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be HTTPS`);
  }
  return parsed.toString();
}

function parseBinding(value: unknown, index: number): WorkerUploadBindingV1 {
  if (!isRecord(value)) throw new Error(`uploadTemplate.bindings[${index}] is invalid`);
  const label = `uploadTemplate.bindings[${index}]`;
  const name = stringValue(value.name, `${label}.name`, 128);
  if (!SAFE_NAME.test(name)) throw new Error(`${label}.name is invalid`);
  switch (value.type) {
    case "durable_object_namespace":
      exactKeys(value, ["type", "name", "className"], label);
      return { type: value.type, name, className: stringValue(value.className, `${label}.className`, 128) };
    case "kv_namespace":
      exactKeys(value, ["type", "name", "resourceSlot"], label);
      if (value.resourceSlot !== "installation-kv") throw new Error(`${label}.resourceSlot is invalid`);
      return { type: value.type, name, resourceSlot: value.resourceSlot };
    case "r2_bucket":
      exactKeys(value, ["type", "name", "resourceSlot"], label);
      if (value.resourceSlot !== "installation-r2") throw new Error(`${label}.resourceSlot is invalid`);
      return { type: value.type, name, resourceSlot: value.resourceSlot };
    case "ai":
    case "assets":
    case "worker_loader":
      exactKeys(value, ["type", "name"], label);
      return { type: value.type, name };
    case "plain_text":
      if (typeof value.text === "string") {
        exactKeys(value, ["type", "name", "text"], label);
        return { type: value.type, name, text: value.text };
      }
      exactKeys(value, ["type", "name", "runtimeSlot"], label);
      if (!RUNTIME_SLOTS.has(value.runtimeSlot as RuntimeBindingSlot)) throw new Error(`${label}.runtimeSlot is invalid`);
      return { type: value.type, name, runtimeSlot: value.runtimeSlot as RuntimeBindingSlot };
    case "secret_text":
      exactKeys(value, ["type", "name", "runtimeSlot"], label);
      if (!RUNTIME_SLOTS.has(value.runtimeSlot as RuntimeBindingSlot)) throw new Error(`${label}.runtimeSlot is invalid`);
      return { type: value.type, name, runtimeSlot: value.runtimeSlot as RuntimeBindingSlot };
    default:
      throw new Error(`${label}.type is unsupported`);
  }
}

function parseExport(value: unknown, className: string): WorkerUploadExportV1 {
  if (!SAFE_NAME.test(className)) throw new Error(`uploadTemplate.exports.${className} has an invalid class name`);
  if (!isRecord(value)) throw new Error(`uploadTemplate.exports.${className} is invalid`);
  // Descriptors pinned before v0.2.40 duplicated the Container relationship
  // here and in uploadTemplate.containers. Accept that retained v1 job shape,
  // validate it, and normalize to Cloudflare's single class_name wiring mode.
  exactKeys(
    value,
    value.container === undefined ? ["type", "storage"] : ["type", "storage", "container"],
    `uploadTemplate.exports.${className}`,
  );
  if (value.type !== "durable-object" || value.storage !== "sqlite") {
    throw new Error(`uploadTemplate.exports.${className} must be a live SQLite Durable Object`);
  }
  if (value.container !== undefined
    && stringValue(value.container, `uploadTemplate.exports.${className}.container`, 128) !== className) {
    throw new Error(`uploadTemplate.exports.${className} has an invalid legacy Container association`);
  }
  return { type: "durable-object", storage: "sqlite" };
}

function parseContainer(value: unknown, index: number): FixedContainerV1 {
  if (!isRecord(value)) throw new Error(`containers[${index}] is invalid`);
  exactKeys(value, ["className", "applicationNameSuffix", "image", "instanceType", "maxInstances"], `containers[${index}]`);
  const image = stringValue(value.image, `containers[${index}].image`);
  if (!DIGEST_IMAGE.test(image)) throw new Error(`containers[${index}].image must be digest-pinned`);
  if (!isV1ContainerImage(image)) {
    throw new Error(`containers[${index}].image must be hosted at exactly docker.io`);
  }
  if (!Number.isSafeInteger(value.maxInstances) || (value.maxInstances as number) < 1) {
    throw new Error(`containers[${index}].maxInstances is invalid`);
  }
  const instanceType = stringValue(value.instanceType, `containers[${index}].instanceType`, 128);
  if (instanceType !== "basic" && instanceType !== "standard-1") {
    throw new Error(`containers[${index}].instanceType is unsupported`);
  }
  return {
    className: stringValue(value.className, `containers[${index}].className`, 128),
    applicationNameSuffix: stringValue(value.applicationNameSuffix, `containers[${index}].applicationNameSuffix`, 64),
    image: image as FixedContainerV1["image"],
    instanceType,
    maxInstances: value.maxInstances as number,
  };
}

export function parseReleaseDescriptor(value: unknown): ReleaseDescriptorV1 {
  if (!isRecord(value)) throw new Error("Release descriptor is invalid");
  exactKeys(value, [
    "schemaVersion", "releaseId", "version", "releaseNotesUrl", "bundle", "uploadTemplate", "containers",
  ], "release descriptor");
  if (value.schemaVersion !== 1) throw new Error("Release descriptor schema is unsupported");
  const releaseId = stringValue(value.releaseId, "releaseId", 40);
  if (!SHA40.test(releaseId)) throw new Error("releaseId must be a 40-character lowercase public snapshot SHA");

  if (!isRecord(value.bundle)) throw new Error("bundle is invalid");
  exactKeys(value.bundle, ["url", "size", "sha256"], "bundle");
  if (!Number.isSafeInteger(value.bundle.size) || (value.bundle.size as number) <= 0) {
    throw new Error("bundle.size is invalid");
  }
  const bundleSha = stringValue(value.bundle.sha256, "bundle.sha256", 64);
  if (!SHA256.test(bundleSha)) throw new Error("bundle.sha256 is invalid");

  if (!isRecord(value.uploadTemplate)) throw new Error("uploadTemplate is invalid");
  exactKeys(value.uploadTemplate, [
    "mainModule", "compatibilityDate", "compatibilityFlags", "observability",
    "assets", "bindings", "exports",
  ], "uploadTemplate");
  if (!Array.isArray(value.uploadTemplate.compatibilityFlags)
    || value.uploadTemplate.compatibilityFlags.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("uploadTemplate.compatibilityFlags is invalid");
  }
  if (!isRecord(value.uploadTemplate.observability)) throw new Error("uploadTemplate.observability is invalid");
  exactKeys(value.uploadTemplate.observability, ["enabled", "headSamplingRate"], "uploadTemplate.observability");
  const enabled = value.uploadTemplate.observability.enabled;
  const sampling = value.uploadTemplate.observability.headSamplingRate;
  if (typeof enabled !== "boolean" || typeof sampling !== "number" || !Number.isFinite(sampling)
    || sampling < 0 || sampling > 1) {
    throw new Error("uploadTemplate.observability is invalid");
  }
  if (!isRecord(value.uploadTemplate.assets)) throw new Error("uploadTemplate.assets is invalid");
  exactKeys(value.uploadTemplate.assets, ["notFoundHandling"], "uploadTemplate.assets");
  const notFoundHandling = value.uploadTemplate.assets.notFoundHandling;
  if (!["single-page-application", "404-page", "none"].includes(String(notFoundHandling))) {
    throw new Error("uploadTemplate.assets.notFoundHandling is invalid");
  }
  if (!Array.isArray(value.uploadTemplate.bindings)) throw new Error("uploadTemplate.bindings is invalid");
  const bindings = value.uploadTemplate.bindings.map(parseBinding);
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length) {
    throw new Error("uploadTemplate binding names must be unique");
  }
  if (!isRecord(value.uploadTemplate.exports)) throw new Error("uploadTemplate.exports is invalid");
  const exportsMap = Object.fromEntries(Object.entries(value.uploadTemplate.exports)
    .map(([className, entry]) => [className, parseExport(entry, className)]));
  if (!Array.isArray(value.containers)) throw new Error("containers is invalid");
  const containers = value.containers.map(parseContainer);

  if (!/^0{40}$/.test(releaseId)) {
    for (const expected of INSTALLER_RUNTIME_BINDINGS) {
      const actual = bindings.find((binding) => binding.name === expected.name);
      if (!actual || canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`Release descriptor is missing canonical runtime binding ${expected.name}`);
      }
    }
    for (const binding of bindings) {
      if (!("runtimeSlot" in binding)) continue;
      const expected = INSTALLER_RUNTIME_BINDINGS.find((candidate) => candidate.name === binding.name);
      if (!expected || canonicalJson(binding) !== canonicalJson(expected)) {
        throw new Error(`Runtime binding ${binding.name} is not part of the installer contract`);
      }
    }
    if (bindings.filter((binding) => binding.type === "kv_namespace").length !== 1
      || bindings.filter((binding) => binding.type === "r2_bucket").length !== 1) {
      throw new Error("Release descriptor must contain exactly one customer KV and R2 binding");
    }
    const durableClasses = bindings
      .filter((binding): binding is Extract<WorkerUploadBindingV1, { type: "durable_object_namespace" }> => (
        binding.type === "durable_object_namespace"
      ))
      .map((binding) => binding.className).sort();
    if (canonicalJson(durableClasses) !== canonicalJson(Object.keys(exportsMap).sort())) {
      throw new Error("Release descriptor Durable Object bindings and exports must agree exactly");
    }
  }
  if (new Set(containers.map((container) => container.className)).size !== containers.length
    || new Set(containers.map((container) => container.applicationNameSuffix)).size !== containers.length) {
    throw new Error("Container classes and application suffixes must be unique");
  }
  const containerClasses = new Set(containers.map((container) => container.className));
  for (const container of containers) {
    if (!SAFE_NAME.test(container.className) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(container.applicationNameSuffix)) {
      throw new Error("Container class or application suffix is invalid");
    }
    if (!exportsMap[container.className]) {
      throw new Error(`Container class ${container.className} is missing from Durable Object exports`);
    }
  }
  for (const [className, entry] of Object.entries(value.uploadTemplate.exports)) {
    if (isRecord(entry) && entry.container !== undefined && !containerClasses.has(className)) {
      throw new Error(`Durable Object export ${className} has an invalid legacy Container association`);
    }
  }

  return {
    schemaVersion: 1,
    releaseId,
    version: stringValue(value.version, "version", 128),
    releaseNotesUrl: httpsUrl(value.releaseNotesUrl, "releaseNotesUrl"),
    bundle: { url: httpsUrl(value.bundle.url, "bundle.url"), size: value.bundle.size as number, sha256: bundleSha },
    uploadTemplate: {
      mainModule: stringValue(value.uploadTemplate.mainModule, "uploadTemplate.mainModule", 256),
      compatibilityDate: stringValue(value.uploadTemplate.compatibilityDate, "compatibilityDate", 32),
      compatibilityFlags: value.uploadTemplate.compatibilityFlags.map((item) => String(item).trim()),
      observability: { enabled, headSamplingRate: sampling },
      assets: { notFoundHandling: notFoundHandling as WorkerUploadTemplateV1["assets"]["notFoundHandling"] },
      bindings,
      exports: exportsMap,
    },
    containers,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
