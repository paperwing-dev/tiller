import {
  createContainerApplication,
  getActiveWorkerVersion,
  getContainerApplication,
  getR2Bucket,
  getWorker,
  getWorkerSubdomain,
  getWorkersSubdomain,
  listContainerApplications,
  listKvNamespaces,
  uploadWorkerScript,
  uploadWorkerScriptWithInheritance,
  type ContainerApplication,
  type ContainerApplicationSummary,
  type CloudflareAuthorization,
  type WorkerBinding,
  type WorkerSettings,
  type WorkerUploadResponse,
} from "./cloudflare-api";
import { uploadReleaseAssets, type ReleaseBundle } from "./bundle";
import {
  canonicalJson,
  INSTALLER_BINDING_NAMES,
  installerRuntimeBindingKey,
} from "./release";
import {
  DO_LOCATION_HINT_BINDING,
  isPlacementRegion,
  placementRegionDefinition,
} from "../../hub/shared/placement";
import type {
  FixedContainerV1,
  InstallationAnchorV1,
  InstallationResourceIdentityV1,
  InstallationResourcesV1,
  InstallerRuntimeBindingKey,
  PlacementRegion,
  ReleaseDescriptorV1,
  RuntimeBindingSlot,
  WorkerUploadBindingV1,
} from "./types";

export const WORKER_NAME = "tiller";
export const INSTALLER_SCHEMA = "1";
export { INSTALLER_BINDING_NAMES };

type DynamicRuntimeBindingKey = Exclude<InstallerRuntimeBindingKey, "installerSchema">;
export type RuntimeValues = { [Key in DynamicRuntimeBindingKey]: string };
export type MaintenanceRuntimeValues = Omit<
  RuntimeValues,
  "ownerEmail" | "accessServiceClientSecret"
>;
type RuntimeValueMap = Partial<RuntimeValues>;

export interface ManagedTopologyReadback {
  resources: InstallationResourcesV1;
  sourceVersionId: string;
  currentReleaseId: string;
  containerImages: Record<string, string>;
}

export class PlacementTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementTopologyError";
  }
}

function identityString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value.trim();
}

export function installationResourceIdentity(
  resources: InstallationResourcesV1,
): InstallationResourceIdentityV1 {
  const durableObjectNamespaceIds = Object.fromEntries(Object.entries(
    resources.durableObjectNamespaceIds ?? {},
  ).map(([className, id]) => [className, identityString(id, `Durable Object ${className}`)]));
  const containerApplications = Object.fromEntries(Object.entries(
    resources.containerApplications ?? {},
  ).map(([className, application]) => [className, {
    id: identityString(application.id, `Container ${className} ID`),
    name: identityString(application.name, `Container ${className} name`),
  }]));
  if (Object.keys(durableObjectNamespaceIds).length === 0
    || Object.keys(containerApplications).length === 0) {
    throw new Error("Installation resource identity is incomplete");
  }
  return {
    ownerEmail: identityString(resources.ownerEmail, "Owner email"),
    workersDevHostname: identityString(resources.workersDevHostname, "workers.dev hostname"),
    kvNamespaceId: identityString(resources.kvNamespaceId, "KV namespace ID"),
    r2BucketName: identityString(resources.r2BucketName, "R2 bucket name"),
    accessIdentityProviderId: identityString(resources.accessIdentityProviderId, "Access identity provider ID"),
    accessServiceTokenId: identityString(resources.accessServiceTokenId, "Access service token ID"),
    accessServiceClientId: identityString(resources.accessServiceClientId, "Access service client ID"),
    accessIssuer: identityString(resources.accessIssuer, "Access issuer"),
    accessApplicationId: identityString(resources.accessApplicationId, "Access application ID"),
    accessAudience: identityString(resources.accessAudience, "Access audience"),
    accessOwnerPolicyId: identityString(resources.accessOwnerPolicyId, "Access owner policy ID"),
    accessServicePolicyId: identityString(resources.accessServicePolicyId, "Access service policy ID"),
    accessPublicApplicationId: identityString(resources.accessPublicApplicationId, "Access public application ID"),
    accessPublicPolicyId: identityString(resources.accessPublicPolicyId, "Access public policy ID"),
    durableObjectNamespaceIds,
    containerApplications,
  };
}

function runtimeSlot(slot: RuntimeBindingSlot, values: RuntimeValueMap): string {
  const key = installerRuntimeBindingKey(slot);
  if (key === "installerSchema") return INSTALLER_SCHEMA;
  const value = values[key];
  if (value === undefined) throw new Error(`Runtime slot ${slot} is unavailable`);
  return value;
}

function explicitBinding(
  binding: WorkerUploadBindingV1,
  resources: InstallationResourcesV1,
  values: RuntimeValueMap,
): Record<string, unknown> {
  switch (binding.type) {
    case "durable_object_namespace":
      return { type: binding.type, name: binding.name, class_name: binding.className };
    case "kv_namespace":
      if (!resources.kvNamespaceId) throw new Error("Installation KV namespace is missing");
      return { type: binding.type, name: binding.name, namespace_id: resources.kvNamespaceId };
    case "r2_bucket":
      if (!resources.r2BucketName) throw new Error("Installation R2 bucket is missing");
      return { type: binding.type, name: binding.name, bucket_name: resources.r2BucketName };
    case "plain_text":
      return {
        type: binding.type,
        name: binding.name,
        text: "text" in binding ? binding.text : runtimeSlot(binding.runtimeSlot, values),
      };
    case "secret_text":
      return { type: binding.type, name: binding.name, text: runtimeSlot(binding.runtimeSlot, values) };
    case "ai":
    case "assets":
    case "worker_loader":
      return { type: binding.type, name: binding.name };
  }
}

function placementBinding(region: PlacementRegion): Record<string, unknown> {
  return {
    type: "plain_text",
    name: DO_LOCATION_HINT_BINDING,
    text: region,
  };
}

type MaterializeWorkerBindingsArgs = {
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  placementRegion: PlacementRegion;
} & (
  | { values: RuntimeValues; includeSecrets: true }
  | { values: MaintenanceRuntimeValues; includeSecrets: false }
);

function materializeWorkerBindings(
  args: MaterializeWorkerBindingsArgs,
): Record<string, unknown>[] {
  if (args.descriptor.uploadTemplate.bindings.some((binding) => (
    binding.name === DO_LOCATION_HINT_BINDING
  ))) {
    throw new Error(`${DO_LOCATION_HINT_BINDING} must remain an installer binding overlay`);
  }
  let releaseBindings: Record<string, unknown>[];
  if (args.includeSecrets) {
    releaseBindings = args.descriptor.uploadTemplate.bindings.map((binding) => (
      explicitBinding(binding, args.resources, args.values)
    ));
  } else {
    releaseBindings = args.descriptor.uploadTemplate.bindings
      .filter((binding): binding is Exclude<WorkerUploadBindingV1, { type: "secret_text" }> => (
        binding.type !== "secret_text"
      ))
      .map((binding) => explicitBinding(binding, args.resources, args.values));
  }
  return [...releaseBindings, placementBinding(args.placementRegion)];
}

export function installationAnchorPlacementRegion(
  anchor: InstallationAnchorV1,
): PlacementRegion {
  if (!isPlacementRegion(anchor.placementRegion)) {
    throw new Error("The installation anchor placement region is invalid");
  }
  return anchor.placementRegion;
}

export function resourceNames(installationId: string): { kvTitle: string; r2Bucket: string } {
  if (!/^[a-z2-7]{26}$/.test(installationId)) throw new Error("Installation ID is invalid");
  return { kvTitle: `tiller-${installationId}-kv`, r2Bucket: `tiller-${installationId}-r2` };
}

export function containerApplicationName(installationId: string, suffix: string): string {
  resourceNames(installationId);
  if (!/^[a-z0-9-]{1,64}$/.test(suffix)) throw new Error("Container application suffix is invalid");
  return `tiller-${installationId}-${suffix}`;
}

function exportMap(descriptor: ReleaseDescriptorV1): Record<string, unknown> {
  return Object.fromEntries(Object.entries(descriptor.uploadTemplate.exports).map(([className, value]) => [
    className,
    {
      type: "durable-object",
      storage: value.storage,
      state: "created",
    },
  ]));
}

function workerObservability(descriptor: ReleaseDescriptorV1): { enabled: boolean; head_sampling_rate: number } {
  return {
    enabled: descriptor.uploadTemplate.observability.enabled,
    head_sampling_rate: descriptor.uploadTemplate.observability.headSamplingRate,
  };
}

function workerUploadMetadata(
  descriptor: ReleaseDescriptorV1,
  bindings: Record<string, unknown>[],
  assetsJwt: string,
): Record<string, unknown> {
  return {
    main_module: descriptor.uploadTemplate.mainModule,
    compatibility_date: descriptor.uploadTemplate.compatibilityDate,
    compatibility_flags: descriptor.uploadTemplate.compatibilityFlags,
    bindings,
    assets: {
      jwt: assetsJwt,
      config: { not_found_handling: descriptor.uploadTemplate.assets.notFoundHandling },
    },
    containers: descriptor.containers.map((container) => ({ class_name: container.className })),
    exports: exportMap(descriptor),
    observability: workerObservability(descriptor),
    tags: ["tiller-installer-v1"],
    annotations: {
      "workers/message": `Tiller ${descriptor.version}`,
      "workers/tag": descriptor.releaseId,
    },
  };
}

export function validateFreshExports(
  response: WorkerUploadResponse,
  descriptor: ReleaseDescriptorV1,
): void {
  const result = response.exports_reconciliation;
  if (!result) throw new Error("Cloudflare did not return declarative exports reconciliation");
  const unwanted = [
    ...(result.deleted ?? []),
    ...(result.updated ?? []),
    ...(result.renamed ?? []),
    ...(result.transferred ?? []),
    ...(result.transfer_pending ?? []),
    ...(result.warnings ?? []),
    ...(result.info ?? []),
    ...(result.removable_entries ?? []),
  ];
  if (unwanted.length > 0
    || canonicalJson([...(result.created ?? [])].sort())
      !== canonicalJson(Object.keys(descriptor.uploadTemplate.exports).sort())) {
    throw new Error("Cloudflare did not create the exact fresh Durable Object exports");
  }
}

/** Content-addressed staging is safe to repeat before the final Worker mutation. */
export function stageFreshHubAssets(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  bundle: ReleaseBundle;
}): Promise<string> {
  return uploadReleaseAssets({
    authorization: args.authorization,
    accountId: args.accountId,
    workerName: WORKER_NAME,
    assets: args.bundle.assets,
  });
}

/** One coupled PUT creates and deploys the only Hub Worker version for this job. */
export async function uploadFreshHub(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  values: RuntimeValues;
  bundle: ReleaseBundle;
  assetsJwt: string;
  placementRegion: PlacementRegion;
}): Promise<void> {
  const response = await uploadWorkerScript(
    args.authorization,
    args.accountId,
    WORKER_NAME,
    workerUploadMetadata(
      args.descriptor,
      materializeWorkerBindings({
        descriptor: args.descriptor,
        resources: args.resources,
        values: args.values,
        includeSecrets: true,
        placementRegion: args.placementRegion,
      }),
      args.assetsJwt,
    ),
    args.bundle.modules,
  );
  if (response.id?.trim() !== WORKER_NAME) throw new Error("Cloudflare returned the wrong Worker upload identity");
  validateFreshExports(response, args.descriptor);
}

function bindingMap(settings: WorkerSettings): Map<string, WorkerBinding> {
  return new Map((settings.bindings ?? []).map((binding) => [binding.name ?? "", binding]));
}

function verifiedBindingMap(
  settings: WorkerSettings,
  descriptor: ReleaseDescriptorV1,
  placementRegion: PlacementRegion,
): Map<string, WorkerBinding> {
  const workerBindings = settings.bindings ?? [];
  const bindings = bindingMap(settings);
  const placementBindings = workerBindings.filter((binding) => (
    binding.name === DO_LOCATION_HINT_BINDING
  ));
  const placement = placementBindings[0];
  if (placementBindings.length !== 1
    || placement?.type !== "plain_text"
    || placement.text !== placementRegion) {
    throw new PlacementTopologyError("The deployed Worker location hint is incorrect");
  }
  const expectedCount = descriptor.uploadTemplate.bindings.length + 1;
  if (workerBindings.length !== expectedCount || bindings.size !== expectedCount) {
    throw new Error("The deployed Worker binding schema is incorrect");
  }
  return bindings;
}

function normalizedExports(settings: WorkerSettings): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings.exports ?? {})
    .filter(([, value]) => (value as Record<string, unknown>).type === "durable-object")
    .map(([name, value]) => {
      const entry = value as Record<string, unknown>;
      return [name, {
        type: entry.type,
        storage: entry.storage,
        ...(typeof entry.container === "string" ? { container: entry.container } : {}),
        state: entry.state ?? "created",
      }];
    }));
}

function normalizedContainerClasses(settings: WorkerSettings): string[] {
  if (!Array.isArray(settings.containers)) return [];
  return settings.containers.map((container) => container.class_name?.trim() ?? "").sort();
}

function expectedContainerClasses(descriptor: ReleaseDescriptorV1): string[] {
  return descriptor.containers.map((container) => container.className).sort();
}

/** Cloudflare serializes omitted/default Worker placement as an empty object. */
function defaultWorkerPlacement(value: unknown): boolean {
  return value === undefined
    || value === null
    || (plainRecord(value) && Object.keys(value).length === 0);
}

function verifyFixedWorkerOptions(settings: WorkerSettings): void {
  const cache = settings.cache_options;
  const hasLimits = settings.limits != null
    && Object.values(settings.limits).some((value) => value !== undefined && value !== null);
  if (!defaultWorkerPlacement(settings.placement)
    || settings.logpush === true
    || (settings.tail_consumers != null && settings.tail_consumers.length > 0)
    || (settings.usage_model != null && settings.usage_model !== "standard")
    || cache?.enabled === true
    || cache?.cross_version_cache === true
    || hasLimits
    || (settings.tags != null
      && canonicalJson([...settings.tags].sort()) !== canonicalJson(["tiller-installer-v1"]))) {
    throw new Error("The deployed Worker has unsupported fixed-topology settings");
  }
}

function selfBoundDurableObject(binding: WorkerBinding, className: string): boolean {
  return binding.class_name === className
    && (binding.script_name === undefined || binding.script_name === null || binding.script_name === "")
    && (binding.environment === undefined || binding.environment === null || binding.environment === "");
}

function namespaceForClass(settings: WorkerSettings, className: string): string {
  const binding = (settings.bindings ?? []).find((candidate) => (
    candidate.type === "durable_object_namespace" && candidate.class_name === className
  ));
  const id = typeof binding?.namespace_id === "string" ? binding.namespace_id.trim() : "";
  if (!id) throw new Error(`Cloudflare did not return the namespace for ${className}`);
  return id;
}

export function verifyFreshWorkerSettings(args: {
  settings: WorkerSettings;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  values: RuntimeValues | MaintenanceRuntimeValues;
  placementRegion: PlacementRegion;
}): Record<string, string> {
  const { settings, descriptor, resources, values, placementRegion } = args;
  verifyFixedWorkerOptions(settings);
  // Cloudflare often omits the multipart part name on readback. When it is
  // present, it must still agree with the pinned upload template.
  if ((settings.main_module !== undefined
      && settings.main_module !== descriptor.uploadTemplate.mainModule)
    || settings.compatibility_date !== descriptor.uploadTemplate.compatibilityDate
    || canonicalJson([...(settings.compatibility_flags ?? [])].sort())
      !== canonicalJson([...descriptor.uploadTemplate.compatibilityFlags].sort())
    || canonicalJson(normalizedExports(settings))
      !== canonicalJson(exportMap(descriptor))
    || canonicalJson(normalizedContainerClasses(settings))
      !== canonicalJson(expectedContainerClasses(descriptor))
    || settings.observability?.enabled !== descriptor.uploadTemplate.observability.enabled
    || settings.observability?.head_sampling_rate !== descriptor.uploadTemplate.observability.headSamplingRate) {
    throw new Error("The deployed Worker does not match the pinned release");
  }
  const assets = settings.assets as { not_found_handling?: unknown; config?: { not_found_handling?: unknown } } | undefined;
  if ((assets?.config?.not_found_handling ?? assets?.not_found_handling)
    !== descriptor.uploadTemplate.assets.notFoundHandling) {
    throw new Error("The deployed Worker assets configuration is incorrect");
  }
  const bindings = verifiedBindingMap(settings, descriptor, placementRegion);
  for (const template of descriptor.uploadTemplate.bindings) {
    const actual = bindings.get(template.name);
    if (!actual || actual.type !== template.type) throw new Error(`Binding ${template.name} is incorrect`);
    if (template.type === "durable_object_namespace" && !selfBoundDurableObject(actual, template.className)) {
      throw new Error(`Durable Object binding ${template.name} is incorrect`);
    }
    if (template.type === "kv_namespace" && actual.namespace_id !== resources.kvNamespaceId) {
      throw new Error(`KV binding ${template.name} is incorrect`);
    }
    if (template.type === "r2_bucket" && actual.bucket_name !== resources.r2BucketName) {
      throw new Error(`R2 binding ${template.name} is incorrect`);
    }
    if (template.type === "plain_text") {
      const expected = "text" in template
        ? template.text
        : runtimeSlot(template.runtimeSlot, values);
      if (actual.text !== expected) throw new Error(`Plain-text binding ${template.name} is incorrect`);
    }
  }
  return Object.fromEntries(descriptor.uploadTemplate.bindings
    .filter((binding): binding is Extract<WorkerUploadBindingV1, { type: "durable_object_namespace" }> => (
      binding.type === "durable_object_namespace"
    ))
    .map((binding) => [binding.className, namespaceForClass(settings, binding.className)]));
}

export async function readAndVerifyFreshWorker(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  values: RuntimeValues;
  placementRegion: PlacementRegion;
}): Promise<Record<string, string>> {
  const active = await getActiveWorkerVersion(
    args.authorization,
    args.accountId,
    WORKER_NAME,
    { retryPropagation: true },
  );
  return verifyFreshWorkerSettings({
    ...args,
    settings: active.settings,
  });
}

function matchesContainerTopology(
  app: ContainerApplication,
  expected: FixedContainerV1,
  namespaceId: string,
  expectedName: string,
  allowDigestDrift: boolean,
  placementRegion: PlacementRegion,
): boolean {
  return app.name === expectedName
    && app.max_instances === expected.maxInstances
    && app.scheduling_policy === "default"
    && matchesContainerPlacement(app, placementRegion)
    && app.durable_objects?.namespace_id === namespaceId
    && exactContainerConfiguration(app.configuration, expected, allowDigestDrift);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutEmptyValues(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => (
    entry !== undefined && entry !== null && (!Array.isArray(entry) || entry.length > 0)
  )));
}

/** Accept only Cloudflare's omitted or known serialized default tier. */
function defaultContainerTierConstraints(constraints: Record<string, unknown>): boolean {
  const keys = Object.keys(constraints).sort();
  if (keys.length === 0) return true;
  if (keys.length !== 1) return false;
  if (keys[0] === "tier") return constraints.tier === 1;
  return keys[0] === "tiers"
    && Array.isArray(constraints.tiers)
    && canonicalJson(constraints.tiers) === canonicalJson([1, 2]);
}

function matchesContainerPlacement(
  app: ContainerApplication,
  placementRegion: PlacementRegion,
): boolean {
  if (app.rollout_active_grace_period !== undefined && app.rollout_active_grace_period !== 0) return false;
  if (app.affinities !== undefined && app.affinities !== null) {
    if (!plainRecord(app.affinities) || Object.keys(withoutEmptyValues(app.affinities)).length > 0) return false;
  }
  if (app.constraints === undefined || app.constraints === null) return false;
  if (!plainRecord(app.constraints)) return false;
  const constraints = app.constraints;
  if (!Array.isArray(constraints.regions)
    || canonicalJson(constraints.regions)
      !== canonicalJson(placementRegionDefinition(placementRegion).containerRegions)) {
    return false;
  }
  const remaining = { ...constraints };
  delete remaining.regions;
  return defaultContainerTierConstraints(remaining);
}

function defaultContainerObservability(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!plainRecord(value)) return false;
  const observability = withoutEmptyValues(value);
  if (Object.keys(observability).length === 0) return true;
  if (Object.keys(observability).length !== 1 || !plainRecord(observability.logs)) return false;
  const logs = withoutEmptyValues(observability.logs);
  return Object.keys(logs).length === 0
    || (Object.keys(logs).length === 1 && logs.enabled === false);
}

const CONTAINER_INSTANCE_PROFILES: Record<string, {
  vcpu: number;
  memory: string;
  memoryMib: number;
  disk: string;
  diskMb: number;
}> = {
  basic: { vcpu: 0.25, memory: "1GiB", memoryMib: 1_024, disk: "4GB", diskMb: 4_000 },
  "standard-1": { vcpu: 0.5, memory: "4GiB", memoryMib: 4_096, disk: "8GB", diskMb: 8_000 },
};

function defaultContainerNetwork(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!plainRecord(value)) return false;
  const network = withoutEmptyValues(value);
  if (Object.keys(network).length === 0) return true;
  return canonicalJson(network) === canonicalJson({
    assign_ipv4: "none",
    assign_ipv6: "none",
    mode: "private",
  });
}

/**
 * The Container API accepts an instance_type but canonicalizes it to concrete
 * resources on readback. Accept either exact representation and reject custom
 * resource, process, network, secret, or environment configuration.
 */
function exactContainerInstanceConfiguration(
  configuration: Record<string, unknown>,
  expectedType: string,
): boolean {
  const profile = CONTAINER_INSTANCE_PROFILES[expectedType];
  if (!profile) return false;
  const returnedType = configuration.instance_type;
  if (returnedType !== undefined && returnedType !== null && returnedType !== expectedType) return false;
  const disk = configuration.disk;
  if (disk !== undefined && disk !== null) {
    if (!plainRecord(disk)) return false;
    const normalizedDisk = withoutEmptyValues(disk);
    if (Object.keys(normalizedDisk).some((key) => !["size", "size_mb"].includes(key))
      || (normalizedDisk.size !== undefined && normalizedDisk.size !== profile.disk)
      || (normalizedDisk.size_mb !== undefined && normalizedDisk.size_mb !== profile.diskMb)) return false;
  }
  if ((configuration.vcpu !== undefined && configuration.vcpu !== profile.vcpu)
    || (configuration.memory !== undefined && configuration.memory !== profile.memory)
    || (configuration.memory_mib !== undefined && configuration.memory_mib !== profile.memoryMib)
    || !defaultContainerNetwork(configuration.network)
    || (configuration.runtime !== undefined && configuration.runtime !== null
      && configuration.runtime !== "firecracker")
    || (configuration.command !== undefined
      && (!Array.isArray(configuration.command) || configuration.command.length > 0))
    || (configuration.entrypoint !== undefined
      && (!Array.isArray(configuration.entrypoint) || configuration.entrypoint.length > 0))) return false;

  if (returnedType === expectedType) return true;
  return configuration.vcpu === profile.vcpu
    && configuration.memory_mib === profile.memoryMib
    && plainRecord(disk)
    && disk.size_mb === profile.diskMb;
}

function exactContainerConfiguration(
  value: unknown,
  expected: FixedContainerV1,
  allowDigestDrift: boolean,
): boolean {
  if (!plainRecord(value)) return false;
  const configuration = withoutEmptyValues(value);
  const keys = Object.keys(configuration).sort();
  if (keys.some((key) => ![
    "command",
    "disk",
    "entrypoint",
    "image",
    "instance_type",
    "memory",
    "memory_mib",
    "network",
    "observability",
    "runtime",
    "vcpu",
  ].includes(key))) return false;
  if (!exactContainerInstanceConfiguration(value, expected.instanceType)
    || !defaultContainerObservability(configuration.observability)) return false;
  if (!allowDigestDrift) return configuration.image === expected.image;
  try {
    return imageRepository(configuration.image) === imageRepository(expected.image);
  } catch {
    return false;
  }
}

/** Matches Cloudflare's accepted or canonicalized representation of one rollout target. */
export function matchesContainerTargetConfiguration(
  value: unknown,
  expected: FixedContainerV1,
): boolean {
  return exactContainerConfiguration(value, expected, false);
}

function imageRepository(value: unknown): string {
  if (typeof value !== "string" || !/^\S+@sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("Container image is not digest-pinned");
  }
  return value.slice(0, value.lastIndexOf("@sha256:"));
}

export function assertManagedContainerTopology(
  app: ContainerApplication,
  expected: FixedContainerV1,
  namespaceId: string,
  expectedName: string,
  placementRegion: PlacementRegion,
): void {
  if (!matchesContainerTopology(
    app,
    expected,
    namespaceId,
    expectedName,
    true,
    placementRegion,
  )) {
    throw new Error(`Container application ${expectedName} has unsupported topology drift`);
  }
}

/** Creates at most one fresh Container application per call. */
export async function createFreshContainerStep(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  placementRegion: PlacementRegion;
  mutate: (
    operation: () => Promise<{ done: false; resources: InstallationResourcesV1 }>,
  ) => Promise<{ done: false; resources: InstallationResourcesV1 }>;
}): Promise<{ done: boolean; resources: InstallationResourcesV1 }> {
  const resources: InstallationResourcesV1 = {
    ...args.resources,
    containerApplications: { ...args.resources.containerApplications },
  };
  const applications = await listContainerApplications(args.authorization, args.accountId);
  for (const container of args.descriptor.containers) {
    const name = containerApplicationName(resources.installationId, container.applicationNameSuffix);
    const namespaceId = resources.durableObjectNamespaceIds?.[container.className];
    if (!namespaceId) throw new Error(`Durable Object namespace for ${container.className} is missing`);
    const recorded = resources.containerApplications?.[container.className];
    if (recorded) {
      const current = await getContainerApplication(args.authorization, args.accountId, recorded.id);
      if (recorded.name !== name
        || !matchesContainerTopology(
          current,
          container,
          namespaceId,
          name,
          false,
          args.placementRegion,
        )) {
        throw new Error(`Container application ${name} no longer matches this install job`);
      }
      continue;
    }
    if (applications.some((application) => application.name === name)) {
      throw new Error(`Container application ${name} already exists and will not be adopted`);
    }
    return args.mutate(async () => {
      const created = await createContainerApplication(args.authorization, args.accountId, {
        name,
        configuration: { image: container.image, instance_type: container.instanceType },
        instances: 0,
        max_instances: container.maxInstances,
        scheduling_policy: "default",
        constraints: {
          regions: [...placementRegionDefinition(args.placementRegion).containerRegions],
        },
        durable_objects: { namespace_id: namespaceId },
      });
      const id = created.id?.trim() ?? "";
      if (!id || !matchesContainerTopology(
        created,
        container,
        namespaceId,
        name,
        false,
        args.placementRegion,
      )) {
        throw new Error(`Cloudflare did not create Container application ${name} exactly`);
      }
      resources.containerApplications![container.className] = { id, name };
      return { done: false, resources };
    });
  }
  return { done: true, resources };
}

export async function verifyFreshContainers(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  placementRegion: PlacementRegion;
}): Promise<boolean> {
  const expectedContainers = args.descriptor.containers.map((container) => {
    const name = containerApplicationName(args.resources.installationId, container.applicationNameSuffix);
    const recorded = args.resources.containerApplications?.[container.className];
    const namespaceId = args.resources.durableObjectNamespaceIds?.[container.className];
    if (!recorded || !recorded.id.trim() || recorded.name !== name || !namespaceId) {
      throw new Error(`Container application ${name} is missing its checkpointed identity`);
    }
    return { container, name, recorded, namespaceId };
  });
  const applications = await listContainerApplications(args.authorization, args.accountId);
  const expectedNames = new Set(expectedContainers.map(({ name }) => name));
  const installationApps = applications.filter((application) => (
    application.name?.startsWith(`tiller-${args.resources.installationId}-`)
  ));
  const applicationsByName = new Map<string, ContainerApplicationSummary>();
  for (const application of installationApps) {
    const name = application.name ?? "";
    if (!expectedNames.has(name) || applicationsByName.has(name)) {
      throw new Error("The fresh Container application set is ambiguous");
    }
    applicationsByName.set(name, application);
  }
  // The list endpoint can expose a newly created application before its full
  // topology has propagated. Use it only to prove the installation's exact
  // name/ID set, then validate each application through the authoritative
  // detail endpoint.
  let complete = true;
  for (const { name, recorded } of expectedContainers) {
    const summary = applicationsByName.get(name);
    if (!summary) {
      complete = false;
      continue;
    }
    if (recorded.id !== summary.id?.trim()) {
      throw new Error(`Container application ${name} failed final verification`);
    }
  }
  if (!complete) return false;
  const detailed = await Promise.all(expectedContainers.map(({ recorded }) => (
    getContainerApplication(args.authorization, args.accountId, recorded.id)
  )));
  for (let index = 0; index < expectedContainers.length; index += 1) {
    const { container, name, recorded, namespaceId } = expectedContainers[index];
    const application = detailed[index];
    if (recorded.id !== application.id?.trim()
      || !matchesContainerTopology(
        application,
        container,
        namespaceId,
        name,
        false,
        args.placementRegion,
      )) {
      throw new Error(`Container application ${name} failed final verification`);
    }
  }
  return true;
}

function requiredBindingText(
  bindings: Map<string, WorkerBinding>,
  name: string,
  label: string,
  pattern?: RegExp,
): string {
  const binding = bindings.get(name);
  const value = binding?.type === "plain_text" && typeof binding.text === "string"
    ? binding.text.trim()
    : "";
  if (!value || (pattern && !pattern.test(value))) throw new Error(`${label} binding is invalid`);
  return value;
}

function managedResourcesFromSettings(args: {
  settings: WorkerSettings;
  descriptor: ReleaseDescriptorV1;
  anchor: InstallationAnchorV1;
  ownerEmail: string;
  workerId: string;
}): { resources: InstallationResourcesV1; currentReleaseId: string } {
  const { settings, descriptor, anchor } = args;
  verifyFixedWorkerOptions(settings);
  const bindings = verifiedBindingMap(
    settings,
    descriptor,
    installationAnchorPlacementRegion(anchor),
  );
  for (const template of descriptor.uploadTemplate.bindings) {
    const actual = bindings.get(template.name);
    if (!actual || actual.type !== template.type) {
      throw new Error(`Binding ${template.name} has unsupported topology drift`);
    }
    if (template.type === "durable_object_namespace" && !selfBoundDurableObject(actual, template.className)) {
      throw new Error(`Durable Object binding ${template.name} has unsupported topology drift`);
    }
    if (template.type === "plain_text" && "text" in template && actual.text !== template.text) {
      throw new Error(`Plain-text binding ${template.name} has unsupported topology drift`);
    }
  }
  if (canonicalJson(normalizedExports(settings)) !== canonicalJson(exportMap(descriptor))) {
    throw new Error("The installed Durable Object exports have unsupported topology drift");
  }
  if (canonicalJson(normalizedContainerClasses(settings))
    !== canonicalJson(expectedContainerClasses(descriptor))) {
    throw new Error("The installed Worker Container associations have unsupported topology drift");
  }

  const installationId = requiredBindingText(
    bindings,
    INSTALLER_BINDING_NAMES.installationId,
    "Installation ID",
    /^[a-z2-7]{26}$/,
  );
  if (installationId !== anchor.installationId) throw new Error("The installed Worker identity changed");
  if (requiredBindingText(bindings, INSTALLER_BINDING_NAMES.installerSchema, "Installer schema") !== INSTALLER_SCHEMA) {
    throw new Error("The installed Worker is not a compatible v1 installation");
  }
  const currentReleaseId = requiredBindingText(
    bindings,
    INSTALLER_BINDING_NAMES.releaseId,
    "Release ID",
    /^[0-9a-f]{40}$/,
  );
  const workersDevHostname = requiredBindingText(
    bindings,
    INSTALLER_BINDING_NAMES.workersDevHostname,
    "workers.dev hostname",
    /^tiller\.[a-z0-9-]+\.workers\.dev$/,
  ).toLowerCase();
  const kv = descriptor.uploadTemplate.bindings.find((binding) => binding.type === "kv_namespace");
  const r2 = descriptor.uploadTemplate.bindings.find((binding) => binding.type === "r2_bucket");
  const kvNamespaceId = kv ? bindings.get(kv.name)?.namespace_id?.trim() : "";
  const r2BucketName = r2 ? bindings.get(r2.name)?.bucket_name?.trim() : "";
  if (!kvNamespaceId || !r2BucketName) throw new Error("The installed storage resource bindings are invalid");

  const durableObjectNamespaceIds = Object.fromEntries(descriptor.uploadTemplate.bindings
    .filter((binding): binding is Extract<WorkerUploadBindingV1, { type: "durable_object_namespace" }> => (
      binding.type === "durable_object_namespace"
    ))
    .map((binding) => [binding.className, namespaceForClass(settings, binding.className)]));

  return {
    currentReleaseId,
    resources: {
      installationId,
      ownerEmail: args.ownerEmail,
      workersDevHostname,
      workerId: args.workerId,
      kvNamespaceId,
      r2BucketName,
      accessIssuer: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessIssuer, "Access issuer"),
      accessAudience: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessAudience, "Access audience"),
      accessIdentityProviderId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessIdentityProviderId, "Access identity provider ID"),
      accessApplicationId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessApplicationId, "Access application ID"),
      accessOwnerPolicyId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessOwnerPolicyId, "Access owner policy ID"),
      accessServicePolicyId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessServicePolicyId, "Access service policy ID"),
      accessPublicApplicationId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessPublicApplicationId, "Access public application ID"),
      accessPublicPolicyId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessPublicPolicyId, "Access public policy ID"),
      accessServiceTokenId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessServiceTokenId, "Access service token ID"),
      accessServiceClientId: requiredBindingText(bindings, INSTALLER_BINDING_NAMES.accessServiceClientId, "Access service client ID"),
      accessTokenExpiresAt: new Date(requiredBindingText(
        bindings,
        INSTALLER_BINDING_NAMES.accessTokenExpiresAt,
        "Access expiration",
      )).toISOString(),
      durableObjectNamespaceIds,
    },
  };
}

/**
 * Reads the installed account state and compares a normalized whitelist of
 * every immutable v1 topology field before maintenance can mutate anything.
 */
export async function readAndVerifyManagedTopology(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  anchor: InstallationAnchorV1;
  placementRegion: PlacementRegion;
  ownerEmail: string;
}): Promise<ManagedTopologyReadback> {
  const placementRegion = installationAnchorPlacementRegion(args.anchor);
  if (placementRegion !== args.placementRegion) {
    throw new PlacementTopologyError("The requested placement region differs from the installation anchor");
  }
  const [worker, route, workersDev, active] = await Promise.all([
    getWorker(args.authorization, args.accountId, args.anchor.workerId),
    getWorkerSubdomain(args.authorization, args.accountId, WORKER_NAME),
    getWorkersSubdomain(args.authorization, args.accountId),
    getActiveWorkerVersion(args.authorization, args.accountId, WORKER_NAME),
  ]);
  if (worker.id?.trim() !== args.anchor.workerId
    || worker.name !== WORKER_NAME
    || !Array.isArray(worker.tags)
    || worker.tags.length !== 1
    || worker.tags[0] !== "tiller-installer-v1"
    || route.enabled !== true
    || route.previews_enabled !== false) {
    throw new Error("The managed Tiller Worker identity or route changed");
  }
  const readback = managedResourcesFromSettings({
    settings: active.settings,
    descriptor: args.descriptor,
    anchor: args.anchor,
    ownerEmail: args.ownerEmail,
    workerId: args.anchor.workerId,
  });
  const accountSubdomain = workersDev.subdomain?.trim().toLowerCase() ?? "";
  if (!accountSubdomain
    || readback.resources.workersDevHostname !== `${WORKER_NAME}.${accountSubdomain}.workers.dev`) {
    throw new Error("The managed Tiller workers.dev hostname changed");
  }
  const expectedNames = resourceNames(readback.resources.installationId);
  const [namespaces, bucket, applications] = await Promise.all([
    listKvNamespaces(args.authorization, args.accountId),
    getR2Bucket(args.authorization, args.accountId, readback.resources.r2BucketName!),
    listContainerApplications(args.authorization, args.accountId),
  ]);
  if (namespaces.filter((namespace) => namespace.id?.trim() === readback.resources.kvNamespaceId
    && namespace.title === expectedNames.kvTitle).length !== 1
    || namespaces.some((namespace) => namespace.title === expectedNames.kvTitle
      && namespace.id?.trim() !== readback.resources.kvNamespaceId)
    || bucket.name !== expectedNames.r2Bucket
    || readback.resources.r2BucketName !== expectedNames.r2Bucket) {
    throw new Error("The managed Tiller storage resource identity changed");
  }

  const expectedApplicationNames = new Set(args.descriptor.containers.map((container) => (
    containerApplicationName(readback.resources.installationId, container.applicationNameSuffix)
  )));
  const installedApplications = applications.filter((application) => (
    application.name?.startsWith(`tiller-${readback.resources.installationId}-`)
  ));
  if (installedApplications.length !== expectedApplicationNames.size
    || installedApplications.some((application) => !application.name
      || !expectedApplicationNames.has(application.name))) {
    throw new Error("The managed Container application set has unsupported topology drift");
  }
  const detailedApplications = await Promise.all(args.descriptor.containers.map(async (container) => {
    const name = containerApplicationName(readback.resources.installationId, container.applicationNameSuffix);
    const summary = installedApplications.find((candidate) => candidate.name === name);
    const anchored = args.anchor.resourceIdentity.containerApplications[container.className];
    const id = summary?.id?.trim() ?? "";
    if (!summary || !id || anchored?.id !== id || anchored.name !== name) {
      throw new Error(`Container application ${name} is incomplete`);
    }
    return getContainerApplication(args.authorization, args.accountId, id);
  }));
  const containerApplications: NonNullable<InstallationResourcesV1["containerApplications"]> = {};
  const containerImages: Record<string, string> = {};
  for (let index = 0; index < args.descriptor.containers.length; index += 1) {
    const container = args.descriptor.containers[index];
    const name = containerApplicationName(readback.resources.installationId, container.applicationNameSuffix);
    const application = detailedApplications[index];
    const namespaceId = readback.resources.durableObjectNamespaceIds?.[container.className];
    const id = application?.id?.trim() ?? "";
    if (!application || !namespaceId || !id
      || args.anchor.resourceIdentity.containerApplications[container.className]?.id !== id) {
      throw new Error(`Container application ${name} is incomplete`);
    }
    assertManagedContainerTopology(application, container, namespaceId, name, placementRegion);
    containerApplications[container.className] = { id, name };
    containerImages[container.className] = identityString(
      application.configuration?.image,
      `Container ${container.className} image`,
    );
  }
  const resources = { ...readback.resources, containerApplications };
  if (canonicalJson(installationResourceIdentity(resources))
    !== canonicalJson(args.anchor.resourceIdentity)) {
    throw new Error("The managed Tiller resource identities changed");
  }
  return {
    ...readback,
    sourceVersionId: active.versionId,
    resources,
    containerImages,
  };
}

function validateMaintenanceExports(response: WorkerUploadResponse): void {
  const result = response.exports_reconciliation;
  if (!result) throw new Error("Cloudflare did not return declarative exports reconciliation");
  const changes = [
    ...(result.created ?? []),
    ...(result.deleted ?? []),
    ...(result.updated ?? []),
    ...(result.renamed ?? []),
    ...(result.transferred ?? []),
    ...(result.transfer_pending ?? []),
    ...(result.warnings ?? []),
    ...(result.info ?? []),
    ...(result.removable_entries ?? []),
  ];
  if (changes.length > 0) throw new Error("The maintenance upload attempted to change Durable Object topology");
}

/** Uploads one pinned Worker release while inheriting both protected secrets from the pinned active version. */
export async function uploadMaintenanceHub(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  values: MaintenanceRuntimeValues;
  bundle: ReleaseBundle;
  sourceVersionId: string;
  placementRegion: PlacementRegion;
}): Promise<void> {
  const assetsJwt = await uploadReleaseAssets({
    authorization: args.authorization,
    accountId: args.accountId,
    workerName: WORKER_NAME,
    assets: args.bundle.assets,
  });
  const inherited = args.descriptor.uploadTemplate.bindings
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name);
  const response = await uploadWorkerScriptWithInheritance(
    args.authorization,
    args.accountId,
    WORKER_NAME,
    workerUploadMetadata(
      args.descriptor,
      materializeWorkerBindings({
        descriptor: args.descriptor,
        resources: args.resources,
        values: args.values,
        includeSecrets: false,
        placementRegion: args.placementRegion,
      }),
      assetsJwt,
    ),
    args.bundle.modules,
    args.sourceVersionId,
    inherited,
  );
  if (response.id?.trim() !== WORKER_NAME) throw new Error("Cloudflare returned the wrong Worker upload identity");
  validateMaintenanceExports(response);
}

/** Verifies the newly active Worker without reading or replacing inherited secret values. */
export async function readAndVerifyMaintenanceWorker(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  descriptor: ReleaseDescriptorV1;
  resources: InstallationResourcesV1;
  values: MaintenanceRuntimeValues;
  placementRegion: PlacementRegion;
}): Promise<string> {
  const active = await getActiveWorkerVersion(args.authorization, args.accountId, WORKER_NAME);
  const namespaces = verifyFreshWorkerSettings({
    settings: active.settings,
    descriptor: args.descriptor,
    resources: args.resources,
    values: args.values,
    placementRegion: args.placementRegion,
  });
  if (canonicalJson(namespaces) !== canonicalJson(args.resources.durableObjectNamespaceIds)) {
    throw new Error("The maintenance Worker upload did not reconcile exactly");
  }
  return active.versionId;
}
