import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionReleaseDescriptorFixture } from "./release-fixture";
import {
  AccountLifecycleDO,
  containerCapabilityIssue,
  containerRegistryReadinessEvent,
  installOutcomeEvent,
  isContainerImageRegistryNotConfigured,
  isExpectedAccessLoginRedirect,
} from "./account-do";
import { AccessConflictError } from "./access";
import { CloudflareApiError } from "./cloudflare-api";
import { installationResourceIdentity, PlacementTopologyError } from "./topology";
import type {
  AccountOperationRecordV1,
  Env,
  InstallationResourcesV1,
  ReleaseDescriptorV1,
} from "./types";

const stableDescriptor = productionReleaseDescriptorFixture();

const dependencyMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getWorkersSubdomain: vi.fn(),
  listWorkers: vi.fn(),
  listContainerRegistries: vi.fn(),
  listContainerApplications: vi.fn(),
  validateFreshAccessPreflight: vi.fn(),
  readAndVerifyManagedTopology: vi.fn(),
  readAndVerifyMaintenanceWorker: vi.fn(),
  readAndVerifyFreshWorker: vi.fn(),
  verifyFreshContainers: vi.fn(),
  validateManagedAccess: vi.fn(),
  readManagedAccessExpiration: vi.fn(),
  renewManagedAccess: vi.fn(),
  getContainerApplication: vi.fn(),
  getContainerRollout: vi.fn(),
  patchContainerApplication: vi.fn(),
  listContainerRollouts: vi.fn(),
  createImmediateContainerRollout: vi.fn(),
  fetchReleaseBundle: vi.fn(),
}));

vi.mock("./cloudflare-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cloudflare-api")>(),
  getUser: dependencyMocks.getUser,
  getWorkersSubdomain: dependencyMocks.getWorkersSubdomain,
  listWorkers: dependencyMocks.listWorkers,
  listContainerRegistries: dependencyMocks.listContainerRegistries,
  listContainerApplications: dependencyMocks.listContainerApplications,
  getContainerApplication: dependencyMocks.getContainerApplication,
  getContainerRollout: dependencyMocks.getContainerRollout,
  patchContainerApplication: dependencyMocks.patchContainerApplication,
  listContainerRollouts: dependencyMocks.listContainerRollouts,
  createImmediateContainerRollout: dependencyMocks.createImmediateContainerRollout,
}));

vi.mock("./topology", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./topology")>();
  dependencyMocks.readAndVerifyFreshWorker.mockImplementation(actual.readAndVerifyFreshWorker);
  dependencyMocks.verifyFreshContainers.mockImplementation(actual.verifyFreshContainers);
  return {
    ...actual,
    readAndVerifyManagedTopology: dependencyMocks.readAndVerifyManagedTopology,
    readAndVerifyMaintenanceWorker: dependencyMocks.readAndVerifyMaintenanceWorker,
    readAndVerifyFreshWorker: dependencyMocks.readAndVerifyFreshWorker,
    verifyFreshContainers: dependencyMocks.verifyFreshContainers,
  };
});

vi.mock("./access", async (importOriginal) => ({
  ...await importOriginal<typeof import("./access")>(),
  validateFreshAccessPreflight: dependencyMocks.validateFreshAccessPreflight,
  validateManagedAccess: dependencyMocks.validateManagedAccess,
  readManagedAccessExpiration: dependencyMocks.readManagedAccessExpiration,
  renewManagedAccess: dependencyMocks.renewManagedAccess,
}));

vi.mock("./bundle", async (importOriginal) => ({
  ...await importOriginal<typeof import("./bundle")>(),
  fetchReleaseBundle: dependencyMocks.fetchReleaseBundle,
}));

const OPERATION_KEY = "active-operation:v1";
const AUTHORIZATION_KEY = "authorization:v1";
const ACCESS_SECRET_KEY = "access-secret:v1";
const ANCHOR_KEY = "installation-anchor:v1";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function durableState(options: {
  failTransactions?: Set<number>;
  afterPut?: (key: string, value: unknown) => void;
} = {}) {
  const values = new Map<string, unknown>();
  let transactionCount = 0;
  const setAlarm = vi.fn(async (_value?: number | Date) => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
      options.afterPut?.(key, value);
    },
    delete: async (key: string) => values.delete(key),
    setAlarm,
    deleteAlarm,
    transaction: async <T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> => {
      transactionCount += 1;
      if (options.failTransactions?.has(transactionCount)) {
        throw new Error("simulated checkpoint transaction failure");
      }
      const snapshot = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
      let alarm: number | Date | undefined;
      const transaction = {
        get: async <Value>(key: string) => structuredClone(snapshot.get(key)) as Value | undefined,
        put: async (key: string, value: unknown) => { snapshot.set(key, structuredClone(value)); },
        delete: async (key: string) => snapshot.delete(key),
        setAlarm: async (value: number | Date) => { alarm = value; },
        deleteAlarm: async () => undefined,
        rollback: () => undefined,
        getAlarm: async () => null,
      } as unknown as DurableObjectTransaction;
      const result = await closure(transaction);
      values.clear();
      for (const [key, value] of snapshot) values.set(key, structuredClone(value));
      if (alarm !== undefined) await setAlarm(alarm);
      return result;
    },
  };
  return {
    state: { storage } as unknown as DurableObjectState,
    values,
    setAlarm,
    deleteAlarm,
    transactionCount: () => transactionCount,
  };
}

function env(): Env {
  return { INSTALLER_TOKEN_ENCRYPTION_KEY_V1: KEY } as Env;
}

function descriptor(version = "0.0.0-placeholder"): ReleaseDescriptorV1 {
  return { ...structuredClone(stableDescriptor), version } as ReleaseDescriptorV1;
}

function statusRecord(overrides: Partial<AccountOperationRecordV1> = {}): AccountOperationRecordV1 {
  return {
    operationId: "status-operation",
    accountId: "account-1",
    intent: "install",
    placementRegion: "wnam",
    descriptor: descriptor(),
    projection: { stage: "deploy-tiller" },
    step: "create-worker",
    ...overrides,
  };
}

function initialFreshResources(): InstallationResourcesV1 {
  return {
    installationId: "a".repeat(26),
    ownerEmail: "owner@example.com",
    workersDevHostname: "tiller.demo.workers.dev",
  };
}

function managedResources(): InstallationResourcesV1 {
  const installationId = "a".repeat(26);
  return {
    installationId,
    ownerEmail: "owner@example.com",
    workersDevHostname: "tiller.demo.workers.dev",
    workerId: "worker-1",
    kvNamespaceId: "kv-1",
    r2BucketName: `tiller-${installationId}-r2`,
    accessIssuer: "https://team.cloudflareaccess.com",
    accessAudience: "audience",
    accessIdentityProviderId: "idp-1",
    accessApplicationId: "app-1",
    accessOwnerPolicyId: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
    accessServicePolicyId: "service-policy-1",
    accessPublicApplicationId: "public-app-1",
    accessPublicPolicyId: "public-policy-1",
    accessServiceTokenId: "token-1",
    accessServiceClientId: "service-client.access",
    accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
    durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    containerApplications: {
      SandboxDO: { id: "application-1", name: `tiller-${installationId}-sandbox` },
    },
  };
}

type TestFreshMutationCheckpoint = {
  resources: InstallationResourcesV1;
  step: "create-kv" | "create-r2" | "access";
  delay?: number;
  accessServiceClientSecret?: string;
};

function invokeFreshMutation<T extends TestFreshMutationCheckpoint>(
  lifecycle: AccountLifecycleDO,
  record: AccountOperationRecordV1,
  operation: () => Promise<T>,
): Promise<T> {
  const target = lifecycle as unknown as {
    freshMutation: <Result extends TestFreshMutationCheckpoint>(
      stored: AccountOperationRecordV1,
      authorization: { accessToken: string; deadline: number },
      mutation: () => Promise<Result>,
      checkpointFor: (result: Result) => TestFreshMutationCheckpoint,
    ) => Promise<Result>;
  };
  return target.freshMutation(
    record,
    { accessToken: "oauth-token", deadline: Date.now() + 60_000 },
    operation,
    (result) => result,
  );
}

async function lifecycleStatus(
  lifecycle: AccountLifecycleDO,
  operationId = "status-operation",
): Promise<Response> {
  return lifecycle.fetch(new Request(
    `https://account-lifecycle.internal/status?operationId=${encodeURIComponent(operationId)}`,
  ));
}

function authorizationRequest(args: {
  authorizationId?: string;
  accessToken?: string;
  intent?: "install" | "update" | "renew";
  placementRegion?: "wnam" | "enam" | null;
  descriptor?: ReleaseDescriptorV1;
  expiresAt?: string;
} = {}): Request {
  const intent = args.intent ?? "install";
  const placementRegion = args.placementRegion === null
    ? undefined
    : args.placementRegion ?? (intent === "install" ? "wnam" : undefined);
  return new Request("https://account-lifecycle.internal/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authorizationId: args.authorizationId ?? "authorization-1",
      accountId: "account-1",
      intent,
      ...(placementRegion ? { placementRegion } : {}),
      descriptor: args.descriptor ?? descriptor(),
      accessToken: args.accessToken ?? "oauth-token-1",
      authorizationExpiresAt: args.expiresAt ?? new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    }),
  });
}

type TestStoredOperation = AccountOperationRecordV1 & {
  mutationRecoveryUntil?: string;
  workerReadback?: {
    workerId: string;
    firstMissingAt: string;
    retryUntil: string;
  };
};

async function prepareContainerRegistryStep(
  memory: ReturnType<typeof durableState>,
  lifecycle: AccountLifecycleDO,
): Promise<TestStoredOperation> {
  await lifecycle.fetch(authorizationRequest());
  const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
  operation.step = "ensure-container-registry";
  operation.projection = { stage: "connect-cloudflare" };
  operation.resources = initialFreshResources();
  memory.values.set(OPERATION_KEY, structuredClone(operation));
  return operation;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencyMocks.fetchReleaseBundle.mockResolvedValue({ modules: [], assets: [] });
  dependencyMocks.listContainerRegistries.mockResolvedValue([
    { domain: "registry.cloudflare.com", kind: "Cloudflare" },
  ]);
  vi.useFakeTimers();
  vi.setSystemTime("2026-07-30T00:00:00.000Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Cloudflare Access rejection", () => {
  const valid = {
    status: 302,
    location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/tiller.demo.workers.dev?kid=audience-1&redirect_url=%2Fapi%2Finstaller%2Fprobe",
    issuer: "https://team.cloudflareaccess.com",
    audience: "audience-1",
    hostname: "tiller.demo.workers.dev",
    targetPath: "/api/installer/probe",
  };

  it("accepts only the expected Access login redirect", () => {
    expect(isExpectedAccessLoginRedirect(valid)).toBe(true);
    expect(isExpectedAccessLoginRedirect({ ...valid, status: 307 })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("team.cloudflareaccess.com", "example.com"),
    })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("tiller.demo.workers.dev", "foreign.workers.dev"),
    })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("%2Fapi%2Finstaller%2Fprobe", "%2Fhealth"),
    })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("kid=audience-1", "kid=other-audience"),
    })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("kid=audience-1&", ""),
    })).toBe(false);
    expect(isExpectedAccessLoginRedirect({
      ...valid,
      location: valid.location.replace("https://", "https://user@example.com@"),
    })).toBe(false);
  });
});

describe("account lifecycle Durable Object", () => {
  it("classifies unavailable Container capability without relying on billing scopes", () => {
    expect(containerCapabilityIssue(new CloudflareApiError(403))).toBe("workers-paid-required");
    expect(containerCapabilityIssue(new CloudflareApiError(404))).toBe("containers-required");
    expect(containerCapabilityIssue(new CloudflareApiError(500))).toBeNull();
    expect(containerCapabilityIssue(new Error("unrelated"))).toBeNull();
  });

  it("clears a fresh pending marker only for a definite Cloudflare rejection", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = statusRecord({ resources: initialFreshResources() });
    memory.values.set(OPERATION_KEY, structuredClone(record));

    await expect(invokeFreshMutation(lifecycle, record, async () => {
      throw new CloudflareApiError(400, { errorCodes: [10042] });
    })).rejects.toMatchObject({ status: 400, uncertain: false });

    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).freshMutationPending)
      .toBeUndefined();
    expect(record.freshMutationPending).toBeUndefined();
  });

  it("clears a provably unattempted marker when authorization expires after the pending write", async () => {
    let crossedDeadline = false;
    const memory = durableState({
      afterPut: (key, value) => {
        if (!crossedDeadline && key === OPERATION_KEY
          && (value as AccountOperationRecordV1).freshMutationPending) {
          crossedDeadline = true;
          vi.advanceTimersByTime(1_000);
        }
      },
    });
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest({
      expiresAt: new Date(Date.now() + 17_000).toISOString(),
    }));
    const record = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    record.step = "create-worker";
    record.projection = { stage: "deploy-tiller" };
    record.resources = initialFreshResources();
    memory.values.set(OPERATION_KEY, structuredClone(record));
    dependencyMocks.listWorkers.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "create-worker",
      projection: {
        stage: "action-required",
        issue: "reauthorization-required",
        nextAction: { kind: "reauthorize", url: "/deploy" },
      },
    });
    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).freshMutationPending).toBeUndefined();
    expect(record.freshMutationPending).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the fresh pending marker for uncertain and malformed successful responses", async () => {
    for (const error of [
      new CloudflareApiError(503, { uncertain: true }),
      new Error("malformed successful response"),
    ]) {
      const memory = durableState();
      const lifecycle = new AccountLifecycleDO(memory.state, env());
      const record = statusRecord({ resources: initialFreshResources() });
      memory.values.set(OPERATION_KEY, structuredClone(record));

      await expect(invokeFreshMutation(lifecycle, record, async () => { throw error; }))
        .rejects.toBe(error);
      expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).freshMutationPending)
        .toBe(true);
    }
  });

  it("atomically checkpoints fresh resource identity, step, alarm, and encrypted Access secret", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const resources = initialFreshResources();
    const record = statusRecord({ resources });
    memory.values.set(OPERATION_KEY, structuredClone(record));

    const result = await invokeFreshMutation(lifecycle, record, async () => ({
      resources: {
        ...resources,
        workerId: "worker-1",
        accessServiceTokenId: "token-1",
        accessServiceClientId: "client-1.access",
      },
      step: "access",
      delay: 500,
      accessServiceClientSecret: "one-time-secret",
    }));

    expect(result.resources.workerId).toBe("worker-1");
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      operationId: record.operationId,
      step: "access",
      resources: {
        workerId: "worker-1",
        accessServiceTokenId: "token-1",
        accessServiceClientId: "client-1.access",
      },
    });
    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).freshMutationPending)
      .toBeUndefined();
    expect(JSON.stringify(memory.values.get(ACCESS_SECRET_KEY))).not.toContain("one-time-secret");
    expect(memory.values.has(ACCESS_SECRET_KEY)).toBe(true);
    expect(memory.transactionCount()).toBe(1);
    expect(memory.setAlarm).toHaveBeenCalledOnce();
  });

  it("fails closed on restart when the successful mutation checkpoint transaction failed", async () => {
    const memory = durableState({ failTransactions: new Set([1]) });
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const resources = initialFreshResources();
    const record = statusRecord({ resources });
    memory.values.set(OPERATION_KEY, structuredClone(record));

    await expect(invokeFreshMutation(lifecycle, record, async () => ({
      resources: { ...resources, workerId: "worker-1" },
      step: "create-kv",
    }))).rejects.toThrow(/checkpoint transaction failure/);
    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).freshMutationPending)
      .toBe(true);

    await new AccountLifecycleDO(memory.state, env()).alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "manual-cleanup-required" },
    });
  });

  it("constructs outcome events from bounded diagnostics and redacts arbitrary error details", () => {
    const apiError = new CloudflareApiError(503, {
      uncertain: true,
      errorCodes: [1001, 1002],
      errorMessages: ["Cloudflare could not schedule this Container."],
      rayId: "9abc123def456789-SJC",
      requestMethod: "POST",
      operation: "container-applications.create",
    });
    Object.assign(apiError, {
      url: "https://example.com/callback?code=secret&state=secret",
      accountId: "account-secret",
      responseBody: "owner@example.com",
      stack: "token-secret",
    });
    expect(installOutcomeEvent({
      operationId: "random-operation-id",
      step: "access",
      outcome: "terminal-failure",
      intent: "install",
      releaseVersion: "1.2.3",
      placementRegion: "wnam",
      issue: "manual-cleanup-required",
      error: apiError,
    })).toEqual({
      event: "tiller.lifecycle.outcome",
      operationId: "random-operation-id",
      step: "access",
      outcome: "terminal-failure",
      intent: "install",
      releaseVersion: "1.2.3",
      placementRegion: "wnam",
      issue: "manual-cleanup-required",
      cloudflareStatus: 503,
      cloudflareUncertain: true,
      cloudflareRequestMethod: "POST",
      cloudflareOperation: "container-applications.create",
      cloudflareErrorCodes: [1001, 1002],
      cloudflareErrorMessages: ["Cloudflare could not schedule this Container."],
      cloudflareRayId: "9abc123def456789-SJC",
    });
    expect(JSON.stringify(installOutcomeEvent({
      operationId: "random-operation-id",
      step: "upload-worker",
      outcome: "terminal-failure",
      intent: "install",
      releaseVersion: "1.2.3",
      error: new Error("https://example.com?code=secret owner@example.com"),
    }))).not.toMatch(/secret|example\.com|@/);
  });

  it("constructs bounded registry-readiness diagnostics without credential fields or response messages", () => {
    const registries = Array.from({ length: 20 }, (_, index) => ({
      domain: `registry-${index}.example.com`,
      kind: index === 0 ? "DockerHub" : "External",
      private_credential: { token: `credential-secret-${index}` },
      public_key: `public-key-secret-${index}`,
    }));
    const event = containerRegistryReadinessEvent({
      operationId: "random-operation-id",
      intent: "install",
      releaseVersion: "1.2.3",
      phase: "container-application",
      decision: "retry-image-access",
      registries,
      retryUntil: new Date(Date.now() + 60_000).toISOString(),
      error: new CloudflareApiError(400, {
        errorCodes: [1605],
        errorMessages: ["response-body-secret"],
        rayId: "9abc123def456789-SJC",
        requestMethod: "POST",
        operation: "container-applications.create",
      }),
    });

    expect(event).toMatchObject({
      event: "tiller.container_registry.readiness",
      operationId: "random-operation-id",
      phase: "container-application",
      decision: "retry-image-access",
      registryCount: 20,
      registryMetadataOmitted: true,
      retryRemainingMs: 60_000,
      cloudflareStatus: 400,
      cloudflareOperation: "container-applications.create",
      cloudflareErrorCodes: [1605],
      cloudflareRayId: "9abc123def456789-SJC",
    });
    expect(event.registries).toHaveLength(16);
    expect(JSON.stringify(event)).not.toMatch(/credential-secret|public-key-secret|response-body-secret/);
  });

  it("recognizes only the exact registry-not-configured Container application rejection", () => {
    const exact = new CloudflareApiError(400, {
      errorCodes: [1605],
      errorMessages: ['{"error":"IMAGE_REGISTRY_NOT_CONFIGURED"}'],
      requestMethod: "POST",
      operation: "container-applications.create",
    });
    expect(isContainerImageRegistryNotConfigured(exact)).toBe(true);
    expect(isContainerImageRegistryNotConfigured(new CloudflareApiError(400, {
      errorCodes: [1605],
      errorMessages: ["Durable Object namespace is not ready."],
      requestMethod: "POST",
      operation: "container-applications.create",
    }))).toBe(false);
    expect(isContainerImageRegistryNotConfigured(new CloudflareApiError(503, {
      uncertain: true,
      errorCodes: [1605],
      errorMessages: ['{"error":"IMAGE_REGISTRY_NOT_CONFIGURED"}'],
      requestMethod: "POST",
      operation: "container-applications.create",
    }))).toBe(false);
  });

  it("humanizes the exact registry-not-configured failure and explains the support reference", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = statusRecord({
      step: "containers",
      resources: { ...initialFreshResources(), workerId: "worker-1" },
    });
    memory.values.set(OPERATION_KEY, structuredClone(record));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = new CloudflareApiError(400, {
      errorCodes: [1605],
      errorMessages: ['{"error":"IMAGE_REGISTRY_NOT_CONFIGURED"}'],
      rayId: "9abc123def456789-SJC",
      requestMethod: "POST",
      operation: "container-applications.create",
    });

    await (lifecycle as unknown as {
      failClosed: (operation: AccountOperationRecordV1, cause: unknown) => Promise<void>;
    }).failClosed(record, error);

    const detail = (memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).projection;
    expect(detail).toMatchObject({
      stage: "action-required",
      issue: "manual-cleanup-required",
    });
    expect(JSON.stringify(detail)).toContain(
      "Cloudflare reported that Container image access is not configured for this account",
    );
    expect(JSON.stringify(detail)).toContain("Cloudflare Ray ID: 9abc123def456789-SJC");
    expect(JSON.stringify(detail)).toContain("Support reference: status-operation");
    expect(JSON.stringify(detail)).toContain("safe to share");
    expect(JSON.stringify(detail)).not.toContain("IMAGE_REGISTRY_NOT_CONFIGURED");
  });

  it("returns a specific, support-correlated error when Cloudflare rejects Container creation", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = statusRecord({
      step: "containers",
      placementRegion: "wnam",
      resources: { ...initialFreshResources(), workerId: "worker-1" },
    });
    memory.values.set(OPERATION_KEY, structuredClone(record));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = new CloudflareApiError(400, {
      errorCodes: [1605],
      errorMessages: ["Durable Object namespace is not ready."],
      rayId: "9abc123def456789-SJC",
      requestMethod: "POST",
      operation: "container-applications.create",
    });

    await (lifecycle as unknown as {
      failClosed: (operation: AccountOperationRecordV1, cause: unknown) => Promise<void>;
    }).failClosed(record, error);

    const detail = "Cloudflare rejected Container application creation (HTTP 400, error code 1605). "
      + "Cloudflare reported: “Durable Object namespace is not ready.” "
      + "Cloudflare Ray ID: 9abc123def456789-SJC. Earlier Cloudflare resources may have been created; "
      + "remove the partial Tiller resources before trying again. Support reference: status-operation. "
      + "This reference identifies the installer log and is safe to share.";
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "manual-cleanup-required",
        detail,
      },
    });
    await expect((await lifecycleStatus(lifecycle)).json()).resolves.toEqual({
      stage: "action-required",
      issue: "manual-cleanup-required",
      detail,
      intent: "install",
    });
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.lifecycle.outcome",
      operationId: "status-operation",
      step: "containers",
      outcome: "action-required",
      issue: "manual-cleanup-required",
      placementRegion: "wnam",
      cloudflareStatus: 400,
      cloudflareOperation: "container-applications.create",
      cloudflareErrorMessages: ["Durable Object namespace is not ready."],
      cloudflareRayId: "9abc123def456789-SJC",
    }));
  });

  it("persists a pinned operation and encrypted grant without customer API work", async () => {
    const memory = durableState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const response = await lifecycle.fetch(authorizationRequest());
    const body = await response.json<{ operationId: string; authorizationAccepted: boolean }>();
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;

    expect(response.status).toBe(200);
    expect(body.operationId).toBe(operation.operationId);
    expect(body.authorizationAccepted).toBe(true);
    expect(operation).toMatchObject({
      accountId: "account-1",
      intent: "install",
      step: "preflight",
      projection: { stage: "connect-cloudflare" },
    });
    expect(JSON.stringify(memory.values.get(AUTHORIZATION_KEY))).not.toContain("oauth-token-1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(memory.setAlarm).toHaveBeenCalledOnce();

    const status = await lifecycle.fetch(new Request(
      `https://account-lifecycle.internal/status?operationId=${encodeURIComponent(operation.operationId)}`,
    ));
    expect(await status.json()).toEqual({
      stage: "connect-cloudflare",
      detail: "Checking your Cloudflare account",
      intent: "install",
    });
    expect((await lifecycle.fetch(new Request(
      "https://account-lifecycle.internal/status?operationId=another-operation",
    ))).status).toBe(404);
  });

  it("requires a valid region for new installs and rejects regional maintenance input", async () => {
    const lifecycle = new AccountLifecycleDO(durableState().state, env());
    expect((await lifecycle.fetch(authorizationRequest({ placementRegion: null }))).status).toBe(400);
    expect((await lifecycle.fetch(authorizationRequest({
      intent: "update",
      placementRegion: "wnam",
    }))).status).toBe(400);

    const invalid = authorizationRequest({ placementRegion: "wnam" });
    const invalidBody = await invalid.json<Record<string, unknown>>();
    invalidBody.placementRegion = "WNAM";
    expect((await lifecycle.fetch(new Request(invalid.url, {
      method: "POST",
      headers: invalid.headers,
      body: JSON.stringify(invalidBody),
    }))).status).toBe(400);
  });

  it("derives curated active progress from existing lifecycle cursors", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const [first, second] = release.containers;
    const partialAccess: InstallationResourcesV1 = {
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      accessIssuer: "https://team.cloudflareaccess.com",
      accessIdentityProviderId: "idp-1",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "client-1.access",
    };
    const partialContainers: InstallationResourcesV1 = {
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      containerApplications: {
        [first.className]: { id: "application-1", name: "first-application" },
        [second.className]: { id: "application-2", name: "second-application" },
      },
    };
    const cases: Array<{
      name: string;
      record: AccountOperationRecordV1;
      expected: { stage: string; detail: string };
    }> = [
      {
        name: "preflight",
        record: statusRecord({ projection: { stage: "connect-cloudflare" }, step: "preflight" }),
        expected: { stage: "connect-cloudflare", detail: "Checking your Cloudflare account" },
      },
      {
        name: "Container image access",
        record: statusRecord({
          projection: { stage: "connect-cloudflare" },
          step: "ensure-container-registry",
        }),
        expected: {
          stage: "connect-cloudflare",
          detail: "Preparing Cloudflare Container image access",
        },
      },
      {
        name: "resource creation",
        record: statusRecord({ step: "create-kv" }),
        expected: { stage: "deploy-tiller", detail: "Creating Cloudflare resources (2 of 3)" },
      },
      {
        name: "Access",
        record: statusRecord({ step: "access", resources: partialAccess }),
        expected: { stage: "deploy-tiller", detail: "Configuring Cloudflare Access (3 of 9)" },
      },
      {
        name: "Worker upload",
        record: statusRecord({ step: "upload-worker" }),
        expected: { stage: "deploy-tiller", detail: "Uploading your Hub" },
      },
      {
        name: "Worker verification",
        record: statusRecord({ step: "verify-worker" }),
        expected: { stage: "deploy-tiller", detail: "Verifying your Hub upload" },
      },
      {
        name: "fresh Containers",
        record: statusRecord({ step: "containers", resources: partialContainers }),
        expected: {
          stage: "deploy-tiller",
          detail: `Creating Containers (2 of ${release.containers.length})`,
        },
      },
      {
        name: "recorded Worker readback",
        record: {
          ...statusRecord({ step: "containers", resources: partialContainers }),
          workerReadback: {
            workerId: "worker-1",
            firstMissingAt: "2026-07-30T00:00:00.000Z",
            retryUntil: "2026-07-30T00:00:10.000Z",
          },
        } as AccountOperationRecordV1,
        expected: {
          stage: "deploy-tiller",
          detail: "Confirming whether the previous Tiller Worker still exists",
        },
      },
      {
        name: "Container image-access reconciliation",
        record: {
          ...statusRecord({ step: "containers", resources: partialContainers }),
          mutationRecoveryUntil: "2026-07-30T00:01:00.000Z",
        } as AccountOperationRecordV1,
        expected: {
          stage: "deploy-tiller",
          detail: "Waiting for Cloudflare to finish enabling Container image access",
        },
      },
      {
        name: "Worker publication",
        record: statusRecord({ step: "enable-worker" }),
        expected: { stage: "deploy-tiller", detail: "Publishing your Hub" },
      },
      {
        name: "final probes",
        record: statusRecord({ step: "service-probe" }),
        expected: { stage: "deploy-tiller", detail: "Verifying your Hub (2 of 3)" },
      },
      {
        name: "maintenance Container preparation",
        record: statusRecord({
          intent: "update",
          step: "maintenance-container-patch",
          containerCursor: { index: 1 },
        }),
        expected: {
          stage: "deploy-tiller",
          detail: `Preparing Container 2 of ${release.containers.length}`,
        },
      },
      {
        name: "maintenance Container rollout start",
        record: statusRecord({
          intent: "update",
          step: "maintenance-container-rollout",
          containerCursor: { index: 1 },
        }),
        expected: {
          stage: "deploy-tiller",
          detail: `Starting Container 2 of ${release.containers.length}`,
        },
      },
      {
        name: "maintenance Container rollout",
        record: statusRecord({
          intent: "update",
          step: "maintenance-container-wait",
          containerCursor: { index: 1 },
        }),
        expected: {
          stage: "deploy-tiller",
          detail: `Updating Container 2 of ${release.containers.length}. Cloudflare may take several minutes to finish each Container.`,
        },
      },
      {
        name: "maintenance Container instance progress",
        record: statusRecord({
          intent: "update",
          step: "maintenance-container-wait",
          containerCursor: { index: 1, readyInstances: 3, totalInstances: 4 },
        }),
        expected: {
          stage: "deploy-tiller",
          detail: `Updating Container 2 of ${release.containers.length} · 3 of 4 instances ready. Cloudflare may take several minutes to finish each Container.`,
        },
      },
      {
        name: "maintenance verification",
        record: statusRecord({ intent: "renew", step: "maintenance-probe" }),
        expected: { stage: "deploy-tiller", detail: "Verifying your updated Hub" },
      },
      {
        name: "authorization cleanup",
        record: statusRecord({ projection: { stage: "open-hub" }, step: "revoke" }),
        expected: { stage: "open-hub", detail: "Finishing securely" },
      },
    ];

    for (const testCase of cases) {
      memory.values.set(OPERATION_KEY, structuredClone(testCase.record));
      const response = await lifecycleStatus(lifecycle);
      expect(response.status, testCase.name).toBe(200);
      expect(await response.json(), testCase.name).toEqual({
        ...testCase.expected,
        intent: testCase.record.intent,
      });
    }
  });

  it("writes the regional installation anchor only after exact Worker and Container readback", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const resources = managedResources();
    const record = statusRecord({
      placementRegion: "wnam",
      step: "service-probe",
      resources,
      descriptor: release,
    });
    const internal = lifecycle as unknown as {
      assertWorker: () => Promise<void>;
      accessSecret: () => Promise<string>;
      probe: () => Promise<{ status: number; body: unknown; location: string | null }>;
      serviceProbe: (
        operation: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    internal.assertWorker = vi.fn(async () => undefined);
    internal.accessSecret = vi.fn(async () => "service-secret");
    internal.probe = vi.fn(async () => ({
      status: 200,
      body: { ok: true, releaseId: release.releaseId },
      location: null,
    }));
    const authorization = { accessToken: "oauth", deadline: Date.now() + 60_000 };

    dependencyMocks.readAndVerifyFreshWorker.mockRejectedValueOnce(
      new PlacementTopologyError("missing regional Worker binding"),
    );
    await expect(internal.serviceProbe(record, authorization)).rejects.toThrow(/regional Worker/);
    expect(memory.values.has(ANCHOR_KEY)).toBe(false);

    dependencyMocks.readAndVerifyFreshWorker
      .mockResolvedValueOnce(resources.durableObjectNamespaceIds)
      .mockResolvedValueOnce(resources.durableObjectNamespaceIds);
    dependencyMocks.verifyFreshContainers.mockResolvedValueOnce(false);
    await expect(internal.serviceProbe(record, authorization)).rejects.toThrow(/still propagating/);
    expect(memory.values.has(ANCHOR_KEY)).toBe(false);

    dependencyMocks.verifyFreshContainers.mockResolvedValueOnce(true);
    await expect(internal.serviceProbe(record, authorization)).resolves.toBeUndefined();
    expect(dependencyMocks.readAndVerifyFreshWorker).toHaveBeenLastCalledWith(expect.objectContaining({
      placementRegion: "wnam",
    }));
    expect(dependencyMocks.verifyFreshContainers).toHaveBeenLastCalledWith(expect.objectContaining({
      placementRegion: "wnam",
    }));
    expect(memory.values.get(ANCHOR_KEY)).toMatchObject({
      schemaVersion: 1,
      placementRegion: "wnam",
      installationId: resources.installationId,
      workerId: resources.workerId,
    });
  });

  it("omits detail for malformed or inconsistent active state without failing status", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const [, second] = release.containers;
    const cases: Array<{ name: string; record: AccountOperationRecordV1 }> = [
      {
        name: "malformed descriptor",
        record: statusRecord({ descriptor: {} as ReleaseDescriptorV1 }),
      },
      {
        name: "stage mismatch",
        record: statusRecord({ projection: { stage: "open-hub" }, step: "access", resources: {} as InstallationResourcesV1 }),
      },
      {
        name: "non-contiguous Access milestones",
        record: statusRecord({
          step: "access",
          resources: {
            accessIssuer: "https://team.cloudflareaccess.com",
            accessServiceTokenId: "token-1",
            accessServiceClientId: "client-1.access",
          } as InstallationResourcesV1,
        }),
      },
      {
        name: "partial Access milestone",
        record: statusRecord({
          step: "access",
          resources: {
            accessIssuer: "https://team.cloudflareaccess.com",
            accessIdentityProviderId: "idp-1",
            accessServiceTokenId: "token-without-client",
          } as InstallationResourcesV1,
        }),
      },
      {
        name: "non-contiguous fresh Containers",
        record: statusRecord({
          step: "containers",
          resources: {
            containerApplications: {
              [second.className]: { id: "application-2", name: "second-application" },
            },
          } as InstallationResourcesV1,
        }),
      },
      ...([-1, 1.5, release.containers.length + 1] as const).map((index) => ({
        name: `invalid maintenance cursor ${index}`,
        record: statusRecord({
          intent: "update",
          step: "maintenance-container-wait",
          containerCursor: { index },
        }),
      })),
      {
        name: "unknown step",
        record: statusRecord({ step: "unknown-step" as AccountOperationRecordV1["step"] }),
      },
    ];

    for (const testCase of cases) {
      memory.values.set(OPERATION_KEY, structuredClone(testCase.record));
      const response = await lifecycleStatus(lifecycle);
      expect(response.status, testCase.name).toBe(200);
      expect(await response.json(), testCase.name).toEqual({
        stage: testCase.record.projection.stage,
        intent: testCase.record.intent,
      });
    }

    const invalidIntent = statusRecord({
      intent: "invalid" as AccountOperationRecordV1["intent"],
    });
    memory.values.set(OPERATION_KEY, structuredClone(invalidIntent));
    const response = await lifecycleStatus(lifecycle);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stage: "deploy-tiller" });
  });

  it("allowlists active status fields even when stored state contains sensitive-looking values", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = {
      ...statusRecord({
        accountId: "sensitive-account-id",
        step: "access",
        resources: {
          installationId: "a".repeat(26),
          ownerEmail: "sensitive-owner@example.com",
          workersDevHostname: "sensitive-host.workers.dev",
          accessIssuer: "https://sensitive-team.cloudflareaccess.com",
          accessIdentityProviderId: "sensitive-idp-id",
          accessServiceTokenId: "sensitive-token-id",
          accessServiceClientId: "sensitive-client-id.access",
        },
      }),
      projection: { stage: "deploy-tiller", leakedCredential: "oauth-sensitive-secret" },
      rawCloudflareResponse: { id: "sensitive-resource-id" },
    } as unknown as AccountOperationRecordV1;
    memory.values.set(OPERATION_KEY, structuredClone(record));

    const response = await lifecycleStatus(lifecycle);
    const body = await response.json();
    expect(body).toEqual({
      stage: "deploy-tiller",
      detail: "Configuring Cloudflare Access (3 of 9)",
      intent: "install",
    });
    expect(JSON.stringify(body)).not.toMatch(/sensitive|oauth|resource-id/i);
  });

  it("allowlists authorization and terminal projections with authoritative intent", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const projections: AccountOperationRecordV1["projection"][] = [
      { stage: "authorize", nextAction: { kind: "authorize", url: "/authorize" } },
      { stage: "action-required", issue: "reauthorization-required", nextAction: { kind: "reauthorize", url: "/deploy" } },
      { stage: "failed", error: { code: "safe-code", message: "Safe failure message." } },
      { stage: "completed", hubUrl: "https://tiller.demo.workers.dev" },
    ];

    for (const projection of projections) {
      const record = statusRecord({
        descriptor: {} as ReleaseDescriptorV1,
        projection,
        step: projection.stage === "completed" ? "completed" : "failed",
      });
      memory.values.set(OPERATION_KEY, structuredClone(record));
      const response = await lifecycleStatus(lifecycle);
      expect(response.status, projection.stage).toBe(200);
      expect(await response.json(), projection.stage).toEqual({ ...projection, intent: "install" });
    }
  });

  it("reports a conflicting Access destination before creating resources", async () => {
    const memory = durableState();
    dependencyMocks.listWorkers.mockResolvedValue([]);
    dependencyMocks.getUser.mockResolvedValue({ email: "owner@example.com" });
    dependencyMocks.getWorkersSubdomain.mockResolvedValue({ subdomain: "demo" });
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.validateFreshAccessPreflight.mockRejectedValue(new AccessConflictError());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: null })));
    const lifecycle = new AccountLifecycleDO(memory.state, env());

    await lifecycle.fetch(authorizationRequest());
    await lifecycle.alarm();

    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(dependencyMocks.validateFreshAccessPreflight).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account-1",
      workersDevHostname: "tiller.demo.workers.dev",
    }));
    expect(operation).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "access-destination-conflict" },
    });
    expect(operation.resources).toBeUndefined();
  });

  it("does not check or initialize registries until release bundle validation succeeds", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = statusRecord({
      projection: { stage: "connect-cloudflare" },
      step: "preflight",
    });
    dependencyMocks.listWorkers.mockResolvedValue([]);
    dependencyMocks.getUser.mockResolvedValue({ email: "owner@example.com" });
    dependencyMocks.getWorkersSubdomain.mockResolvedValue({ subdomain: "demo" });
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.validateFreshAccessPreflight.mockResolvedValue(undefined);
    dependencyMocks.fetchReleaseBundle.mockRejectedValueOnce(new Error("invalid release bundle"));

    await expect((lifecycle as unknown as {
      preflight(
        stored: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ): Promise<void>;
    }).preflight(record, { accessToken: "oauth-token", deadline: Date.now() + 60_000 }))
      .rejects.toThrow("invalid release bundle");

    expect(record.resources).toBeUndefined();
    expect(record.step).toBe("preflight");
    expect(dependencyMocks.listContainerRegistries).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty registry list", []],
    ["the default registry", [{ domain: "registry.cloudflare.com", kind: "Cloudflare" }]],
    ["the legacy Cloudchamber marker", [{ domain: "registry.cloudchamber.cfdata.org" }]],
    ["a current Docker Hub registry", [{ domain: "docker.io", kind: "DockerHub" }]],
    ["the affected account after removing its stale docker.io record", [
      { domain: "registry.cloudflare.com" },
      { domain: "registry.cloudchamber.cfdata.org" },
    ]],
    ["a customer registry alongside the legacy marker", [
      { domain: "registry.cloudchamber.cfdata.org" },
      { domain: "registry.example.com", kind: "Custom" },
    ]],
  ])("preserves %s and proceeds without registry mutation", async (_name, registries) => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await prepareContainerRegistryStep(memory, lifecycle);
    dependencyMocks.listContainerRegistries.mockResolvedValueOnce(registries);

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "create-worker",
      projection: { stage: "deploy-tiller" },
    });
    const stored = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(stored.mutationRecoveryUntil).toBeUndefined();
    expect(stored.mutation).toBeUndefined();
    expect(stored.freshMutationPending).toBeUndefined();
  });

  it.each([
    ["a missing domain", [{}]],
    ["a null entry", [null]],
    ["a blank domain", [{ domain: "  ", kind: "DockerHub" }]],
  ])("fails safely on a nonempty registry readback with %s", async (_name, registries) => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await prepareContainerRegistryStep(memory, lifecycle);
    dependencyMocks.listContainerRegistries.mockResolvedValueOnce(registries);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();

    const stored = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(stored).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "container-registry-unavailable",
      },
    });
    expect(stored.projection).not.toMatchObject({ issue: "manual-cleanup-required" });
    expect(stored.resources).toEqual(initialFreshResources());
    expect(stored.mutation).toBeUndefined();
    expect(stored.freshMutationPending).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails a registry read after preflight without mutating Tiller resources", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    dependencyMocks.listWorkers.mockResolvedValue([]);
    dependencyMocks.getUser.mockResolvedValue({ email: "owner@example.com" });
    dependencyMocks.getWorkersSubdomain.mockResolvedValue({ subdomain: "demo" });
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.validateFreshAccessPreflight.mockResolvedValue(undefined);
    dependencyMocks.listContainerRegistries.mockRejectedValueOnce(new CloudflareApiError(503, {
      requestMethod: "GET",
      operation: "container-registries.list",
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.fetch(authorizationRequest());
    await lifecycle.alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "ensure-container-registry",
      projection: { stage: "connect-cloudflare" },
    });

    await lifecycle.alarm();

    const stored = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(stored).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "container-registry-unavailable",
      },
      resources: {
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
      },
    });
    expect(stored.projection).not.toMatchObject({ issue: "manual-cleanup-required" });
    expect(stored.resources).not.toHaveProperty("workerId");
    expect(stored.resources).not.toHaveProperty("kvNamespaceId");
    expect(stored.resources).not.toHaveProperty("r2BucketName");
    expect(stored.resources).not.toHaveProperty("accessApplicationId");
    expect(stored.resources).not.toHaveProperty("containerApplications");
    expect(stored.mutation).toBeUndefined();
    expect(stored.freshMutationPending).toBeUndefined();
    expect(dependencyMocks.listWorkers).toHaveBeenCalledOnce();
    expect(dependencyMocks.listContainerApplications).toHaveBeenCalledOnce();
    expect(dependencyMocks.validateFreshAccessPreflight).toHaveBeenCalledOnce();
    expect(dependencyMocks.fetchReleaseBundle).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare Docker Hub record", [{ domain: "docker.io" }]],
    ["a mistyped Docker Hub record", [{ domain: "docker.io", kind: "Custom" }]],
    ["mixed valid and malformed Docker Hub records", [
      { domain: "docker.io", kind: "DockerHub" },
      { domain: "docker.io" },
    ]],
    ["the affected account before stale-record removal", [
      { domain: "registry.cloudflare.com" },
      { domain: "registry.cloudchamber.cfdata.org" },
      { domain: "docker.io" },
    ]],
  ])("requires repair for %s before creating Tiller resources", async (_name, registries) => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await prepareContainerRegistryStep(memory, lifecycle);
    dependencyMocks.listContainerRegistries.mockResolvedValueOnce(registries);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();

    const stored = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(stored).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "container-registry-repair-required",
      },
    });
    expect(stored.resources).toEqual(initialFreshResources());
    expect(stored.resources).not.toHaveProperty("workerId");
    expect(stored.mutationRecoveryUntil).toBeUndefined();
    expect(stored.mutation).toBeUndefined();
    expect(stored.freshMutationPending).toBeUndefined();
  });

  it("retries the exact registry-not-configured application rejection within one fixed deadline", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    const release = operation.descriptor;
    const firstContainer = release.containers[0];
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: Object.fromEntries(
        release.containers.map((container, index) => [container.className, `namespace-${index + 1}`]),
      ),
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.listContainerRegistries.mockResolvedValue([
      { domain: "docker.io", kind: "DockerHub", private_credential: { token: "secret" } },
    ]);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let applicationCreates = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: {
              enabled: release.uploadTemplate.observability.enabled,
              head_sampling_rate: release.uploadTemplate.observability.headSamplingRate,
            },
          },
        });
      }
      if (url.pathname.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({
          success: true,
          result: { enabled: false, previews_enabled: false },
        });
      }
      if (url.pathname.endsWith("/containers/applications") && method === "POST") {
        applicationCreates += 1;
        if (applicationCreates === 1) {
          return Response.json({
            success: false,
            errors: [{ code: 1605, message: '{"error":"IMAGE_REGISTRY_NOT_CONFIGURED"}' }],
          }, {
            status: 400,
            headers: { "cf-ray": "first-ray-SJC" },
          });
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ success: true, result: { id: "application-1", ...body } });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    }));

    await lifecycle.alarm();

    const retrying = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(retrying).toMatchObject({
      step: "containers",
      mutationRecoveryUntil: "2026-07-30T00:01:00.000Z",
    });
    expect(retrying.freshMutationPending).toBeUndefined();
    await expect((await lifecycleStatus(lifecycle, operation.operationId)).json()).resolves.toMatchObject({
      stage: "deploy-tiller",
      detail: "Waiting for Cloudflare to finish enabling Container image access",
    });
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.container_registry.readiness",
      decision: "retry-image-access",
      retryRemainingMs: 60_000,
      registries: [{ domain: "docker.io", kind: "DockerHub" }],
      cloudflareStatus: 400,
      cloudflareErrorCodes: [1605],
      cloudflareRayId: "first-ray-SJC",
    }));
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("secret");

    vi.advanceTimersByTime(2_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    const completedRetry = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(completedRetry.mutationRecoveryUntil).toBeUndefined();
    expect(completedRetry.freshMutationPending).toBeUndefined();
    expect(completedRetry.resources?.containerApplications?.[firstContainer.className]).toEqual({
      id: "application-1",
      name: `tiller-${"a".repeat(26)}-${firstContainer.applicationNameSuffix}`,
    });
    expect(applicationCreates).toBe(2);
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.container_registry.readiness",
      decision: "image-access-ready",
    }));
  });

  it("expires the exact application retry safely without extending its deadline", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    const release = operation.descriptor;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: Object.fromEntries(
        release.containers.map((container, index) => [container.className, `namespace-${index + 1}`]),
      ),
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.listContainerRegistries.mockResolvedValue([
      { domain: "docker.io", kind: "DockerHub" },
    ]);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let applicationCreates = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: {
              enabled: release.uploadTemplate.observability.enabled,
              head_sampling_rate: release.uploadTemplate.observability.headSamplingRate,
            },
          },
        });
      }
      if (url.pathname.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({
          success: true,
          result: { enabled: false, previews_enabled: false },
        });
      }
      if (url.pathname.endsWith("/containers/applications") && method === "POST") {
        applicationCreates += 1;
        return Response.json({
          success: false,
          errors: [{ code: 1605, message: '{"error":"IMAGE_REGISTRY_NOT_CONFIGURED"}' }],
        }, {
          status: 400,
          headers: { "cf-ray": `retry-ray-${applicationCreates}-SJC` },
        });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    }));

    await lifecycle.alarm();
    expect((memory.values.get(OPERATION_KEY) as TestStoredOperation).mutationRecoveryUntil)
      .toBe("2026-07-30T00:01:00.000Z");

    vi.advanceTimersByTime(60_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    const failed = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(failed).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "manual-cleanup-required",
      },
    });
    expect(failed.mutationRecoveryUntil).toBeUndefined();
    expect(failed.freshMutationPending).toBeUndefined();
    expect(applicationCreates).toBe(2);
    const detail = JSON.stringify(failed.projection);
    expect(detail).toContain("Container image access is not configured for this account");
    expect(detail).toContain("Cloudflare Ray ID: retry-ray-2-SJC");
    expect(detail).toContain(`Support reference: ${operation.operationId}`);
    expect(detail).not.toContain("IMAGE_REGISTRY_NOT_CONFIGURED");
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.container_registry.readiness",
      decision: "image-access-deadline-expired",
      cloudflareStatus: 400,
      cloudflareErrorCodes: [1605],
    }));
  });

  it("attaches concurrent sessions to the active pinned operation", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const first = await lifecycle.fetch(authorizationRequest({ placementRegion: "wnam" }));
    const firstId = (await first.json<{ operationId: string }>()).operationId;
    const second = await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      intent: "install",
      placementRegion: "enam",
      descriptor: descriptor("different-browser-target"),
    }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;

    expect(await second.json<{ operationId: string; authorizationAccepted: boolean }>()).toEqual({
      operationId: firstId,
      authorizationAccepted: false,
    });
    expect(operation.intent).toBe("install");
    expect(operation.placementRegion).toBe("wnam");
    expect(operation.descriptor.version).toBe("0.0.0-placeholder");
    expect(operation.operationId).toBe(firstId);
    expect(await (await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-3",
      accessToken: "oauth-token-3",
    }))).json()).toEqual({ operationId: firstId, authorizationAccepted: false });
  });

  it("terminalizes an abandoned regionless install before starting fresh", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest({ placementRegion: "wnam" }));
    const abandoned = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    const abandonedId = abandoned.operationId;
    abandoned.placementRegion = undefined;
    abandoned.projection = {
      stage: "action-required",
      issue: "reauthorization-required",
      nextAction: { kind: "reauthorize", url: "/deploy" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(abandoned));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    const response = await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      placementRegion: "enam",
    }));
    const restarted = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;

    expect(response.status).toBe(200);
    expect(restarted.operationId).not.toBe(abandonedId);
    expect(restarted).toMatchObject({
      intent: "install",
      placementRegion: "enam",
      step: "preflight",
      projection: { stage: "connect-cloudflare" },
    });
  });

  it("requires an existing managed Worker's selected placement to match its anchor", async () => {
    dependencyMocks.listWorkers.mockResolvedValue([{ id: "worker-1", name: "tiller" }]);
    const memory = durableState();
    const anchor = {
      schemaVersion: 1 as const,
      installationId: "a".repeat(26),
      workerId: "worker-1",
      placementRegion: "wnam" as const,
      resourceIdentity: {},
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      containerImages: {},
    };
    memory.values.set(ANCHOR_KEY, anchor);
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const preflight = (record: AccountOperationRecordV1) => (lifecycle as unknown as {
      preflight(
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ): Promise<void>;
    }).preflight(record, { accessToken: "oauth-token", deadline: Date.now() + 60_000 });

    const matching = statusRecord({ placementRegion: "wnam", step: "preflight" });
    await expect(preflight(matching)).resolves.toBeUndefined();
    expect(matching).toMatchObject({ placementRegion: "wnam", step: "maintenance-readback" });

    await expect(preflight(statusRecord({ placementRegion: "enam", step: "preflight" })))
      .rejects.toThrow(/differs from the installation anchor/);
    memory.values.set(ANCHOR_KEY, { ...anchor, placementRegion: undefined });
    await expect(preflight(statusRecord({ placementRegion: "wnam", step: "preflight" })))
      .rejects.toThrow(/anchored placement region is invalid/);
  });

  it("rejects missing, invalid, or conflicting maintenance anchors before Cloudflare readback", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const internal = lifecycle as unknown as {
      maintenanceReadback: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    const authorization = { accessToken: "oauth-token", deadline: Date.now() + 60_000 };
    const record = () => statusRecord({
      intent: "update",
      placementRegion: undefined,
      step: "maintenance-readback",
    });

    await expect(internal.maintenanceReadback(record(), authorization))
      .rejects.toThrow(/anchor is missing/);
    expect(dependencyMocks.listContainerRegistries).not.toHaveBeenCalled();
    expect(dependencyMocks.getUser).not.toHaveBeenCalled();

    memory.values.set(ANCHOR_KEY, { placementRegion: "WNAM" });
    await expect(internal.maintenanceReadback(record(), authorization))
      .rejects.toThrow(/anchored placement region is invalid/);
    expect(dependencyMocks.listContainerRegistries).not.toHaveBeenCalled();
    expect(dependencyMocks.getUser).not.toHaveBeenCalled();

    memory.values.set(ANCHOR_KEY, { placementRegion: "enam" });
    await expect(internal.maintenanceReadback(statusRecord({
      intent: "update",
      placementRegion: "wnam",
      step: "maintenance-readback",
    }), authorization)).rejects.toThrow(/differs from the installation anchor/);
    expect(dependencyMocks.listContainerRegistries).not.toHaveBeenCalled();
    expect(dependencyMocks.getUser).not.toHaveBeenCalled();

    const copied = record();
    memory.values.set(ANCHOR_KEY, { placementRegion: "wnam" });
    dependencyMocks.listContainerRegistries.mockRejectedValueOnce(new Error("stop after anchor"));
    await expect(internal.maintenanceReadback(copied, authorization)).rejects.toThrow(/topology changed/);
    expect(copied.placementRegion).toBe("wnam");
  });

  it("retains the selected placement when no Worker exists despite a stale anchor", async () => {
    const memory = durableState();
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId: "b".repeat(26),
      workerId: "stale-worker",
      placementRegion: "enam",
      resourceIdentity: {},
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      containerImages: {},
    });
    dependencyMocks.listWorkers.mockResolvedValue([]);
    dependencyMocks.getUser.mockResolvedValue({ email: "owner@example.com" });
    dependencyMocks.getWorkersSubdomain.mockResolvedValue({ subdomain: "demo" });
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    dependencyMocks.validateFreshAccessPreflight.mockResolvedValue(undefined);
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const record = statusRecord({ placementRegion: "wnam", step: "preflight" });

    await (lifecycle as unknown as {
      preflight(
        stored: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ): Promise<void>;
    }).preflight(record, { accessToken: "oauth-token", deadline: Date.now() + 60_000 });

    expect(record).toMatchObject({
      placementRegion: "wnam",
      step: "ensure-container-registry",
      projection: { stage: "connect-cloudflare" },
      resources: {
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
      },
    });
    expect(dependencyMocks.fetchReleaseBundle).toHaveBeenCalledOnce();
  });

  it("routes deploy for a managed Worker through forward maintenance", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const installationId = "a".repeat(26);
    const resources: InstallationResourcesV1 = {
      installationId,
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${installationId}-r2`,
      accessIdentityProviderId: "idp-1",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "service-client.access",
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      accessIssuer: "https://team.cloudflareaccess.com",
      accessApplicationId: "app-1",
      accessAudience: "audience",
      accessOwnerPolicyId: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
      accessServicePolicyId: "service-policy-1",
      accessPublicApplicationId: "public-app-1",
      accessPublicPolicyId: "public-policy-1",
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
      containerApplications: {
        SandboxDO: { id: "application-1", name: `tiller-${installationId}-sandbox` },
      },
    };
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId,
      workerId: "worker-1",
      placementRegion: "wnam",
      resourceIdentity: installationResourceIdentity(resources),
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      containerImages: {
        SandboxDO: `docker.io/example/tiller@sha256:${"b".repeat(64)}`,
      },
    });
    dependencyMocks.getUser.mockResolvedValue({ email: resources.ownerEmail });
    dependencyMocks.getWorkersSubdomain.mockResolvedValue({ subdomain: "demo" });
    dependencyMocks.listWorkers.mockResolvedValue([{ id: "worker-1", name: "tiller" }]);
    await lifecycle.fetch(authorizationRequest({ intent: "install", descriptor: release }));
    await lifecycle.alarm();

    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(operation).toMatchObject({
      intent: "update",
      step: "maintenance-readback",
      projection: { stage: "deploy-tiller" },
    });
    await expect((await lifecycleStatus(lifecycle, operation.operationId)).json()).resolves.toEqual({
      stage: "deploy-tiller",
      detail: "Checking your existing Hub",
      intent: "update",
    });
    expect(dependencyMocks.readAndVerifyManagedTopology).not.toHaveBeenCalled();
    expect(dependencyMocks.readAndVerifyMaintenanceWorker).not.toHaveBeenCalled();
    expect(dependencyMocks.validateManagedAccess).not.toHaveBeenCalled();
  });

  it("reports Worker placement drift without uploading a replacement", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const resources = managedResources();
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId: resources.installationId,
      workerId: resources.workerId,
      placementRegion: "wnam",
      resourceIdentity: installationResourceIdentity(resources),
      accessTokenExpiresAt: resources.accessTokenExpiresAt,
      containerImages: {},
    });
    await lifecycle.fetch(authorizationRequest({
      intent: "update",
      descriptor: release,
    }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.placementRegion = "wnam";
    operation.step = "maintenance-upload-worker";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = resources;
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.readAndVerifyManagedTopology.mockResolvedValue({
      resources,
      sourceVersionId: "version-1",
      currentReleaseId: release.releaseId,
      containerImages: {},
    });
    dependencyMocks.validateManagedAccess.mockResolvedValue(undefined);
    dependencyMocks.readAndVerifyMaintenanceWorker.mockRejectedValue(
      new PlacementTopologyError("The deployed Worker location hint is incorrect"),
    );
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "topology-drift" },
    });
    expect(dependencyMocks.fetchReleaseBundle).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("reports Container placement drift without patching constraints", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const resources = managedResources();
    const targetImage = `docker.io/example/tiller@sha256:${"b".repeat(64)}` as `${string}@sha256:${string}`;
    release.containers = [{
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: targetImage,
      instanceType: "basic",
      maxInstances: 2,
    }];
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId: resources.installationId,
      workerId: resources.workerId,
      placementRegion: "wnam",
      resourceIdentity: installationResourceIdentity(resources),
      accessTokenExpiresAt: resources.accessTokenExpiresAt,
      containerImages: { SandboxDO: targetImage },
    });
    await lifecycle.fetch(authorizationRequest({
      intent: "update",
      descriptor: release,
    }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.placementRegion = "wnam";
    operation.step = "maintenance-container-patch";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = resources;
    operation.sourceVersionId = "version-1";
    operation.containerCursor = { index: 0, applicationId: "application-1" };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.getContainerApplication.mockResolvedValue({
      id: "application-1",
      name: `tiller-${resources.installationId}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["ENAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: targetImage, instance_type: "basic" },
    });
    const internal = lifecycle as unknown as {
      assertTargetWorker: () => Promise<void>;
    };
    internal.assertTargetWorker = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "topology-drift" },
    });
    expect(dependencyMocks.patchContainerApplication).not.toHaveBeenCalled();
  });

  it("renews Access before uploading an update even with more than 30 days remaining", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor("0.3.0");
    const installationId = "a".repeat(26);
    const currentExpiration = "2027-07-30T00:00:00.000Z";
    const renewedExpiration = "2028-07-29T00:00:00.000Z";
    const resources: InstallationResourcesV1 = {
      installationId,
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${installationId}-r2`,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessAudience: "audience",
      accessIdentityProviderId: "idp-1",
      accessApplicationId: "app-1",
      accessOwnerPolicyId: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
      accessServicePolicyId: "service-policy-1",
      accessPublicApplicationId: "public-app-1",
      accessPublicPolicyId: "public-policy-1",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "service-client.access",
      accessTokenExpiresAt: currentExpiration,
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
      containerApplications: {
        SandboxDO: { id: "application-1", name: `tiller-${installationId}-sandbox` },
      },
    };
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId,
      workerId: resources.workerId,
      placementRegion: "wnam",
      resourceIdentity: installationResourceIdentity(resources),
      accessTokenExpiresAt: currentExpiration,
      containerImages: {},
    });
    dependencyMocks.getUser.mockResolvedValue({ email: resources.ownerEmail });
    dependencyMocks.validateManagedAccess.mockResolvedValue(undefined);
    dependencyMocks.readAndVerifyManagedTopology.mockResolvedValue({
      resources,
      sourceVersionId: "version-1",
      currentReleaseId: "b".repeat(40),
    });
    dependencyMocks.renewManagedAccess.mockResolvedValue({
      ...resources,
      accessTokenExpiresAt: renewedExpiration,
    });
    dependencyMocks.listContainerRegistries.mockResolvedValue([
      { domain: "registry.cloudflare.com", kind: "Cloudflare" },
    ]);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.fetch(authorizationRequest({ intent: "update", descriptor: release }));
    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      intent: "update",
      step: "maintenance-renew-access",
      resources: { accessTokenExpiresAt: currentExpiration },
    });
    expect(dependencyMocks.renewManagedAccess).not.toHaveBeenCalled();
    expect(dependencyMocks.readAndVerifyMaintenanceWorker).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.container_registry.readiness",
      phase: "maintenance-observation",
      decision: "observation",
      registries: [{ domain: "registry.cloudflare.com", kind: "Cloudflare" }],
    }));

    await lifecycle.alarm();

    expect(dependencyMocks.renewManagedAccess).toHaveBeenCalledOnce();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "maintenance-upload-worker",
      resources: { accessTokenExpiresAt: renewedExpiration },
    });
    expect(dependencyMocks.readAndVerifyMaintenanceWorker).not.toHaveBeenCalled();
  });

  it("retains an incomplete operation and requests reauthorization after grant expiry", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const response = await lifecycle.fetch(authorizationRequest());
    const operationId = (await response.json<{ operationId: string }>()).operationId;

    vi.advanceTimersByTime(30 * 60 * 1_000);
    await lifecycle.alarm();
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(operation.operationId).toBe(operationId);
    expect(operation.step).toBe("preflight");
    expect(operation.projection).toEqual({
      stage: "action-required",
      issue: "reauthorization-required",
      nextAction: { kind: "reauthorize", url: "/deploy" },
    });
    expect(memory.values.has(AUTHORIZATION_KEY)).toBe(false);

    const resumed = await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    }));
    expect((await resumed.json<{ operationId: string }>()).operationId).toBe(operationId);
    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).step).toBe("preflight");
  });

  it("reports a definite Container application 403 instead of looping through reauthorization", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    const error = new CloudflareApiError(403, {
      rayId: "a262d7b50ea4329b-BNE",
      requestMethod: "POST",
      operation: "container-applications.create",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await (lifecycle as unknown as {
      handleStepError(
        stored: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
        failure: unknown,
      ): Promise<void>;
    }).handleStepError(
      operation,
      { accessToken: "oauth-token-1", deadline: Date.now() + 60_000 },
      error,
    );

    const failed = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(failed).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "manual-cleanup-required",
      },
    });
    expect(failed.projection).not.toMatchObject({ issue: "reauthorization-required" });
    expect(JSON.stringify(failed.projection)).toContain("HTTP 403");
    expect(JSON.stringify(failed.projection)).toContain("Cloudflare Ray ID: a262d7b50ea4329b-BNE");
    expect(memory.values.has(AUTHORIZATION_KEY)).toBe(false);
  });

  it("fails closed instead of reauthorizing when OAuth expires with a fresh mutation pending", async () => {
    const memory = durableState();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "create-worker";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = initialFreshResources();
    operation.freshMutationPending = true;
    memory.values.set(OPERATION_KEY, structuredClone(operation));

    vi.advanceTimersByTime(30 * 60 * 1_000);
    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "manual-cleanup-required" },
    });
  });

  it("retries a newly checkpointed Worker that temporarily returns 404", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "create-kv";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = { ...initialFreshResources(), workerId: "worker-1" };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      throw new Error(`unexpected ${path}`);
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "create-kv",
      projection: { stage: "deploy-tiller" },
      resources: { workerId: "worker-1" },
      workerReadback: {
        workerId: "worker-1",
        firstMissingAt: "2026-07-30T00:00:00.000Z",
        retryUntil: "2026-07-30T00:00:10.000Z",
      },
    });
    expect(dependencyMocks.listWorkers).not.toHaveBeenCalled();
    expect(memory.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("terminalizes a persistently missing recorded Worker and lets the next authorization start fresh", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    const oldOperationId = operation.operationId;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${"a".repeat(26)}-r2`,
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listWorkers.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: false,
          errors: [{ code: 10090, message: "Worker not found" }],
        }, {
          status: 404,
          headers: { "cf-ray": "a26299ed12345678-SJC" },
        });
      }
      return new Response(null, { status: 200 });
    }));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "containers",
      workerReadback: { retryUntil: "2026-07-30T00:00:10.000Z" },
    });
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.worker_readback.retry",
      step: "containers",
      retryRemainingMs: 10_000,
      cloudflareStatus: 404,
      cloudflareOperation: "workers.get",
      cloudflareErrorCodes: [10090],
      cloudflareRayId: "a26299ed12345678-SJC",
    }));

    vi.advanceTimersByTime(10_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    const stopped = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    expect(stopped).toMatchObject({
      operationId: oldOperationId,
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "installation-restart-required",
        nextAction: { kind: "start-fresh", url: "/deploy" },
      },
    });
    expect(stopped.workerReadback).toBeUndefined();
    expect(JSON.stringify(stopped.projection)).toContain("no more cleanup is needed");
    expect(JSON.stringify(stopped.projection)).toContain("Cloudflare Ray ID: a26299ed12345678-SJC");
    expect(JSON.stringify(stopped.projection)).not.toContain("manual-cleanup-required");
    expect(dependencyMocks.listWorkers).toHaveBeenCalledOnce();
    expect(memory.values.has(AUTHORIZATION_KEY)).toBe(false);
    expect(memory.values.has(ACCESS_SECRET_KEY)).toBe(false);
    expect(memory.deleteAlarm).toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "tiller.lifecycle.outcome",
      step: "containers",
      outcome: "action-required",
      issue: "installation-restart-required",
      cloudflareStatus: 404,
      cloudflareOperation: "workers.get",
      cloudflareErrorCodes: [10090],
      cloudflareRayId: "a26299ed12345678-SJC",
    }));

    const restarted = await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    }));
    const restartedOperationId = (await restarted.json<{ operationId: string }>()).operationId;
    expect(restartedOperationId).not.toBe(oldOperationId);
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      operationId: restartedOperationId,
      step: "preflight",
      projection: { stage: "connect-cloudflare" },
    });
    expect((memory.values.get(OPERATION_KEY) as TestStoredOperation).resources).toBeUndefined();
  });

  it("fails closed when the final Worker absence check is inconclusive", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listWorkers.mockRejectedValue(new CloudflareApiError(503, {
      requestMethod: "GET",
      operation: "workers.list",
      rayId: "list1234abcd5678-SJC",
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      return new Response(null, { status: 200 });
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();
    vi.advanceTimersByTime(10_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "manual-cleanup-required" },
    });
    expect((memory.values.get(OPERATION_KEY) as TestStoredOperation).workerReadback).toBeUndefined();
    expect(dependencyMocks.listWorkers).toHaveBeenCalledOnce();
    expect(memory.deleteAlarm).toHaveBeenCalled();
  });

  it("fails closed when point and list Worker readback disagree after the fixed deadline", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listWorkers.mockResolvedValue([{ id: "worker-1", name: "tiller" }]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      throw new Error(`unexpected ${path}`);
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();
    vi.advanceTimersByTime(10_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "manual-cleanup-required" },
    });
    expect((memory.values.get(OPERATION_KEY) as TestStoredOperation).workerReadback).toBeUndefined();
    expect(memory.values.has(AUTHORIZATION_KEY)).toBe(false);
    expect(dependencyMocks.listWorkers).toHaveBeenCalledOnce();
    expect(memory.deleteAlarm).toHaveBeenCalled();
  });

  it("reports a replacement tiller Worker instead of offering a fresh-start loop", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as TestStoredOperation;
    operation.step = "containers";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listWorkers.mockResolvedValue([{ id: "worker-2", name: "tiller" }]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      return new Response(null, { status: 200 });
    }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await lifecycle.alarm();
    vi.advanceTimersByTime(10_000);
    await new AccountLifecycleDO(memory.state, env()).alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: {
        stage: "action-required",
        issue: "foreign-worker-conflict",
      },
    });
    const projection = (memory.values.get(OPERATION_KEY) as TestStoredOperation).projection;
    expect(projection).not.toHaveProperty("nextAction");
    expect(JSON.stringify(projection)).toContain("different Worker named tiller");
  });

  it("retries a stale disabled Worker route after the enable checkpoint", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "health-probe";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = { ...initialFreshResources(), workerId: "worker-1" };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    let healthProbes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: { enabled: true, head_sampling_rate: 1 },
          },
        });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      if (url.hostname === "tiller.demo.workers.dev") {
        healthProbes += 1;
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected ${path}`);
    }));

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "health-probe",
      projection: { stage: "deploy-tiller" },
      resources: { workerId: "worker-1" },
    });
    expect(healthProbes).toBe(0);
    expect(memory.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("retries an incomplete fresh Container list before enabling the Worker", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    await lifecycle.fetch(authorizationRequest({ descriptor: release }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    const resources = initialFreshResources();
    operation.step = "enable-worker";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...resources,
      workerId: "worker-1",
      durableObjectNamespaceIds: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, `namespace-${index + 1}`]
      ))),
      containerApplications: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, {
          id: `application-${index + 1}`,
          name: `tiller-${resources.installationId}-${container.applicationNameSuffix}`,
        }]
      ))),
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listContainerApplications.mockResolvedValue([]);
    let enableRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: { enabled: true, head_sampling_rate: 1 },
          },
        });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        if (init?.method === "POST") enableRequests += 1;
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    }));

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "enable-worker",
      projection: { stage: "deploy-tiller" },
      resources: { workerId: "worker-1" },
    });
    expect(enableRequests).toBe(0);
    expect(memory.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("retries a transient fresh Container detail 404 before enabling the Worker", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    await lifecycle.fetch(authorizationRequest({ descriptor: release }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    const resources = initialFreshResources();
    operation.step = "enable-worker";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...resources,
      workerId: "worker-1",
      durableObjectNamespaceIds: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, `namespace-${index + 1}`]
      ))),
      containerApplications: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, {
          id: `application-${index + 1}`,
          name: `tiller-${resources.installationId}-${container.applicationNameSuffix}`,
        }]
      ))),
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    dependencyMocks.listContainerApplications.mockResolvedValue(release.containers.map((container, index) => ({
      id: `application-${index + 1}`,
      name: `tiller-${resources.installationId}-${container.applicationNameSuffix}`,
    })));
    dependencyMocks.getContainerApplication.mockRejectedValue(new CloudflareApiError(404));
    let enableRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: { enabled: true, head_sampling_rate: 1 },
          },
        });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        if (init?.method === "POST") enableRequests += 1;
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    }));

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "enable-worker",
      projection: { stage: "deploy-tiller" },
      resources: { workerId: "worker-1" },
    });
    expect(dependencyMocks.getContainerApplication).toHaveBeenCalledTimes(release.containers.length);
    expect(enableRequests).toBe(0);
    expect(memory.setAlarm).toHaveBeenCalledTimes(2);
  });

  it("keeps automatic Access IdP propagation resumable through OAuth reauthorization", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    const createdAt = new Date(Date.now() - 5 * 60_000).toISOString();
    operation.step = "access";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${"a".repeat(26)}-r2`,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessOrganizationCreatedAt: createdAt,
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    vi.advanceTimersByTime(30 * 60 * 1_000);
    await lifecycle.alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "access",
      projection: { stage: "action-required", issue: "reauthorization-required" },
      resources: { accessOrganizationCreatedAt: createdAt },
    });

    await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      expiresAt: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: { enabled: true, head_sampling_rate: 1 },
          },
        });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      if (path.endsWith("/storage/kv/namespaces")) {
        return Response.json({
          success: true,
          result: [{ id: "kv-1", title: `tiller-${"a".repeat(26)}-kv` }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith(`/r2/buckets/tiller-${"a".repeat(26)}-r2`)) {
        return Response.json({ success: true, result: { name: `tiller-${"a".repeat(26)}-r2` } });
      }
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${path}`);
    }));

    await lifecycle.alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "access",
      projection: { stage: "deploy-tiller" },
      resources: { accessOrganizationCreatedAt: createdAt },
    });
    await expect((await lifecycleStatus(lifecycle, operation.operationId)).json()).resolves.toEqual({
      stage: "deploy-tiller",
      detail: "Waiting for Cloudflare Access to finish setup; this can take a few minutes.",
      intent: "install",
    });
  });

  it("fails closed after an uncertain explicit IdP creation without searching for adoption", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest());
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "access";
    operation.projection = { stage: "deploy-tiller" };
    operation.resources = {
      ...initialFreshResources(),
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${"a".repeat(26)}-r2`,
      accessIssuer: "https://team.cloudflareaccess.com",
    };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    let providerReads = 0;
    let providerCreates = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (url.hostname === "dash.cloudflare.com") return new Response(null, { status: 200 });
      if (path.endsWith("/workers/workers/worker-1")) {
        return Response.json({
          success: true,
          result: {
            id: "worker-1",
            name: "tiller",
            tags: ["tiller-installer-v1"],
            observability: { enabled: true, head_sampling_rate: 1 },
          },
        });
      }
      if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        return Response.json({ success: true, result: { enabled: false, previews_enabled: false } });
      }
      if (path.endsWith("/storage/kv/namespaces")) {
        return Response.json({
          success: true,
          result: [{ id: "kv-1", title: `tiller-${"a".repeat(26)}-kv` }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith(`/r2/buckets/tiller-${"a".repeat(26)}-r2`)) {
        return Response.json({ success: true, result: { name: `tiller-${"a".repeat(26)}-r2` } });
      }
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers") && init?.method === "POST") {
        providerCreates += 1;
        return Response.json({ success: true }, { status: 201 });
      }
      if (path.endsWith("/access/identity_providers")) {
        providerReads += 1;
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    }));

    await lifecycle.alarm();

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "failed",
      projection: { stage: "action-required", issue: "manual-cleanup-required" },
    });
    expect(providerCreates).toBe(1);
    expect(providerReads).toBe(1);
  });

  it("clears an interrupted maintenance mutation marker without losing its forward cursor", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    await lifecycle.fetch(authorizationRequest({ intent: "update" }));
    const operation = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    operation.step = "maintenance-container-rollout";
    operation.mutation = true;
    operation.containerCursor = { index: 1, applicationId: "application-1" };
    memory.values.set(OPERATION_KEY, structuredClone(operation));
    memory.values.delete(AUTHORIZATION_KEY);

    await lifecycle.alarm();
    const retained = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(retained.operationId).toBe(operation.operationId);
    expect(retained.step).toBe("maintenance-container-rollout");
    expect(retained.containerCursor).toEqual({ index: 1, applicationId: "application-1" });
    expect(retained.mutation).toBeUndefined();
    expect(retained.projection).toMatchObject({
      stage: "action-required",
      issue: "reauthorization-required",
    });
  });

  it("rolls out a target image again when a replacement operation lacks completion proof", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const installationId = "a".repeat(26);
    const targetImage = `docker.io/example/tiller@sha256:${"b".repeat(64)}` as `${string}@sha256:${string}`;
    release.containers = [{
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: targetImage,
      instanceType: "basic",
      maxInstances: 2,
    }];
    const application = {
      id: "application-1",
      name: `tiller-${installationId}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: targetImage, instance_type: "basic" },
    };
    const operation: AccountOperationRecordV1 = {
      operationId: "replacement-operation",
      accountId: "account-1",
      intent: "update",
      placementRegion: "wnam",
      descriptor: release,
      projection: { stage: "deploy-tiller" },
      step: "maintenance-container-patch",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        workerId: "worker-1",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: { SandboxDO: { id: "application-1", name: application.name } },
      },
      containerCursor: { index: 0 },
    };
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId,
      workerId: "worker-1",
      placementRegion: "wnam",
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      containerImages: {
        SandboxDO: `docker.io/example/tiller@sha256:${"a".repeat(64)}`,
      },
    });
    dependencyMocks.getContainerApplication.mockResolvedValue(application);
    dependencyMocks.listContainerRollouts.mockResolvedValue([]);
    dependencyMocks.createImmediateContainerRollout.mockResolvedValue({
      id: "rollout-1",
      status: "pending",
      description: "Tiller fixed-topology image update",
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: null,
      target_configuration: {
        image: targetImage,
        vcpu: 0.25,
        memory: "1GiB",
        memory_mib: 1_024,
        disk: { size: "4GB", size_mb: 4_000 },
      },
    });
    const internal = lifecycle as unknown as {
      assertTargetWorker: () => Promise<void>;
      maintenanceContainerPatch: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
      maintenanceContainerRollout: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    internal.assertTargetWorker = vi.fn(async () => undefined);
    const authorization = { accessToken: "oauth", deadline: Date.now() + 60_000 };

    await internal.maintenanceContainerPatch(operation, authorization);
    expect(operation.containerCursor).toEqual({ index: 0, applicationId: "application-1" });
    expect(operation.step).toBe("maintenance-container-patch");
    await internal.maintenanceContainerPatch(operation, authorization);
    expect(operation.step).toBe("maintenance-container-rollout");
    await internal.maintenanceContainerRollout(operation, authorization);

    expect(dependencyMocks.createImmediateContainerRollout).toHaveBeenCalledOnce();
    expect(operation.containerCursor).toEqual({
      index: 0,
      applicationId: "application-1",
      rolloutId: "rollout-1",
    });
    expect(operation.step).toBe("maintenance-container-wait");
  });

  it("adopts the exact active rollout after an interrupted create response", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const installationId = "a".repeat(26);
    const previousImage = `docker.io/example/tiller@sha256:${"a".repeat(64)}` as `${string}@sha256:${string}`;
    const targetImage = `docker.io/example/tiller@sha256:${"b".repeat(64)}` as `${string}@sha256:${string}`;
    const target = {
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: targetImage,
      instanceType: "basic",
      maxInstances: 2,
    };
    release.containers = [target];
    const application = {
      id: "application-1",
      name: `tiller-${installationId}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: previousImage, instance_type: "basic" },
    };
    const operation: AccountOperationRecordV1 = {
      operationId: "update-operation",
      accountId: "account-1",
      intent: "update",
      placementRegion: "wnam",
      descriptor: release,
      projection: { stage: "deploy-tiller" },
      step: "maintenance-container-rollout",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        workerId: "worker-1",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: { SandboxDO: { id: "application-1", name: application.name } },
      },
      containerCursor: { index: 0, applicationId: "application-1" },
    };
    dependencyMocks.getContainerApplication.mockResolvedValue(application);
    dependencyMocks.listContainerRollouts.mockResolvedValue([{
      id: "rollout-committed-before-interruption",
      status: "progressing",
      description: "Tiller fixed-topology image update",
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: null,
      target_configuration: {
        image: targetImage,
        vcpu: 0.25,
        memory: "1GiB",
        memory_mib: 1_024,
        disk: { size: "4GB", size_mb: 4_000 },
      },
    }]);
    const internal = lifecycle as unknown as {
      assertTargetWorker: () => Promise<void>;
      maintenanceContainerRollout: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    internal.assertTargetWorker = vi.fn(async () => undefined);

    await internal.maintenanceContainerRollout(
      operation,
      { accessToken: "oauth", deadline: Date.now() + 60_000 },
    );

    expect(dependencyMocks.createImmediateContainerRollout).not.toHaveBeenCalled();
    expect(operation.containerCursor).toEqual({
      index: 0,
      applicationId: "application-1",
      rolloutId: "rollout-committed-before-interruption",
    });
    expect(operation.step).toBe("maintenance-container-wait");
  });

  it("persists live Cloudflare instance readiness while a Container rollout progresses", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const installationId = "a".repeat(26);
    const targetImage = `docker.io/example/tiller@sha256:${"b".repeat(64)}` as `${string}@sha256:${string}`;
    const target = {
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: targetImage,
      instanceType: "basic",
      maxInstances: 4,
    };
    release.containers = [target];
    const application = {
      id: "application-1",
      name: `tiller-${installationId}-sandbox`,
      max_instances: 4,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: targetImage, instance_type: "basic" },
    };
    const operation: AccountOperationRecordV1 = {
      operationId: "update-operation",
      accountId: "account-1",
      intent: "update",
      placementRegion: "wnam",
      descriptor: release,
      projection: { stage: "deploy-tiller" },
      step: "maintenance-container-wait",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        workerId: "worker-1",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: { SandboxDO: { id: "application-1", name: application.name } },
      },
      containerCursor: {
        index: 0,
        applicationId: "application-1",
        rolloutId: "rollout-1",
      },
    };
    dependencyMocks.getContainerApplication.mockResolvedValue(application);
    dependencyMocks.getContainerRollout.mockResolvedValue({
      id: "rollout-1",
      status: "progressing",
      health: { instances: { healthy: 2, starting: 2, failed: 0 } },
      progress: { total_instances: 4 },
    });
    const internal = lifecycle as unknown as {
      assertTargetWorker: () => Promise<void>;
      maintenanceContainerWait: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    internal.assertTargetWorker = vi.fn(async () => undefined);

    await internal.maintenanceContainerWait(
      operation,
      { accessToken: "oauth", deadline: Date.now() + 60_000 },
    );

    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "maintenance-container-wait",
      containerCursor: {
        index: 0,
        applicationId: "application-1",
        rolloutId: "rollout-1",
        readyInstances: 2,
        totalInstances: 4,
      },
    });
    expect(await (await lifecycleStatus(lifecycle, "update-operation")).json()).toEqual({
      stage: "deploy-tiller",
      detail: `Updating Container 1 of ${release.containers.length} · 2 of 4 instances ready. Cloudflare may take several minutes to finish each Container.`,
      intent: "update",
    });
    expect(memory.setAlarm).toHaveBeenCalledOnce();
  });

  it("starts a rollout when Cloudflare PATCH readback still shows the deployed image", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const release = descriptor();
    const installationId = "a".repeat(26);
    const previousImage = `docker.io/example/tiller@sha256:${"a".repeat(64)}` as `${string}@sha256:${string}`;
    const targetImage = `docker.io/example/tiller@sha256:${"b".repeat(64)}` as `${string}@sha256:${string}`;
    release.containers = [{
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: targetImage,
      instanceType: "basic",
      maxInstances: 2,
    }];
    const application = {
      id: "application-1",
      name: `tiller-${installationId}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: previousImage, instance_type: "basic" },
    };
    const operation: AccountOperationRecordV1 = {
      operationId: "update-operation",
      accountId: "account-1",
      intent: "update",
      placementRegion: "wnam",
      descriptor: release,
      projection: { stage: "deploy-tiller" },
      step: "maintenance-container-patch",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        workerId: "worker-1",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: { SandboxDO: { id: "application-1", name: application.name } },
      },
      containerCursor: { index: 0 },
    };
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId,
      workerId: "worker-1",
      placementRegion: "wnam",
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
      containerImages: { SandboxDO: previousImage },
    });
    dependencyMocks.getContainerApplication.mockResolvedValue(application);
    // This is Cloudflare's live contract: PATCH succeeds but the application
    // continues to report the currently deployed image until rollout.
    dependencyMocks.patchContainerApplication.mockResolvedValue(application);
    dependencyMocks.listContainerRollouts.mockResolvedValue([]);
    dependencyMocks.createImmediateContainerRollout.mockResolvedValue({
      id: "rollout-1",
      status: "pending",
      description: "Tiller fixed-topology image update",
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: 100,
      target_configuration: { image: targetImage, instance_type: "basic" },
    });
    const internal = lifecycle as unknown as {
      assertTargetWorker: () => Promise<void>;
      maintenanceContainerPatch: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
      maintenanceContainerRollout: (
        record: AccountOperationRecordV1,
        authorization: { accessToken: string; deadline: number },
      ) => Promise<void>;
    };
    internal.assertTargetWorker = vi.fn(async () => undefined);
    const authorization = { accessToken: "oauth", deadline: Date.now() + 60_000 };

    await internal.maintenanceContainerPatch(operation, authorization);
    await internal.maintenanceContainerPatch(operation, authorization);

    expect(dependencyMocks.patchContainerApplication).toHaveBeenCalledWith(
      authorization,
      "account-1",
      "application-1",
      { configuration: { image: targetImage, instance_type: "basic" } },
    );
    expect(operation.step).toBe("maintenance-container-rollout");

    await internal.maintenanceContainerRollout(operation, authorization);

    expect(dependencyMocks.createImmediateContainerRollout).toHaveBeenCalledWith(
      authorization,
      "account-1",
      "application-1",
      { image: targetImage, instance_type: "basic" },
    );
    expect(operation.step).toBe("maintenance-container-wait");
  });

  it("uses strict Access validation when the Worker binding matches the anchor", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const resources: InstallationResourcesV1 = {
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "service-client.access",
      accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
    };
    memory.values.set(ANCHOR_KEY, {
      accessTokenExpiresAt: resources.accessTokenExpiresAt,
    });
    dependencyMocks.validateManagedAccess.mockResolvedValue(undefined);

    const result = await (lifecycle as unknown as {
      validateAccessWithAnchor: (
        authorization: { accessToken: string; deadline: number },
        accountId: string,
        resources: InstallationResourcesV1,
        ownerEmail: string,
      ) => Promise<InstallationResourcesV1>;
    }).validateAccessWithAnchor(
      { accessToken: "oauth", deadline: Date.now() + 60_000 },
      "account-1",
      resources,
      resources.ownerEmail,
    );

    expect(result.accessTokenExpiresAt).toBe(resources.accessTokenExpiresAt);
    expect(dependencyMocks.validateManagedAccess).toHaveBeenCalledOnce();
    expect(dependencyMocks.readManagedAccessExpiration).not.toHaveBeenCalled();
  });

  it("rejects lagging Worker metadata when Access does not match the anchored renewal", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const resources: InstallationResourcesV1 = {
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "service-client.access",
      accessTokenExpiresAt: "2026-08-01T00:00:00.000Z",
    };
    memory.values.set(ANCHOR_KEY, {
      accessTokenExpiresAt: "2027-07-30T00:00:00.000Z",
    });
    dependencyMocks.readManagedAccessExpiration.mockResolvedValue("2027-08-01T00:00:00.000Z");

    await expect((lifecycle as unknown as {
      validateAccessWithAnchor: (
        authorization: { accessToken: string; deadline: number },
        accountId: string,
        resources: InstallationResourcesV1,
        ownerEmail: string,
      ) => Promise<InstallationResourcesV1>;
    }).validateAccessWithAnchor(
      { accessToken: "oauth", deadline: Date.now() + 60_000 },
      "account-1",
      resources,
      resources.ownerEmail,
    )).rejects.toThrow(/anchored Tiller Access service-token expiration changed/);
    expect(dependencyMocks.validateManagedAccess).not.toHaveBeenCalled();
  });

  it("carries an anchored Access renewal across terminal operation replacement", async () => {
    const memory = durableState();
    const lifecycle = new AccountLifecycleDO(memory.state, env());
    const oldExpiration = "2026-08-01T00:00:00.000Z";
    const renewedExpiration = "2027-07-30T00:00:00.000Z";
    const installationId = "a".repeat(26);
    const release = descriptor();
    const resources: InstallationResourcesV1 = {
      installationId,
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      workerId: "worker-1",
      kvNamespaceId: "kv-1",
      r2BucketName: `tiller-${installationId}-r2`,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessAudience: "audience",
      accessIdentityProviderId: "idp-1",
      accessApplicationId: "app-1",
      accessOwnerPolicyId: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
      accessServicePolicyId: "service-policy-1",
      accessPublicApplicationId: "public-app-1",
      accessPublicPolicyId: "public-policy-1",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "service-client.access",
      accessTokenExpiresAt: oldExpiration,
      durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
      containerApplications: {
        SandboxDO: { id: "application-1", name: `tiller-${installationId}-sandbox` },
      },
    };
    let topologyReads = 0;
    dependencyMocks.getUser.mockResolvedValue({ email: resources.ownerEmail });
    dependencyMocks.validateManagedAccess.mockResolvedValue(undefined);
    dependencyMocks.readManagedAccessExpiration.mockResolvedValue(renewedExpiration);
    dependencyMocks.renewManagedAccess.mockResolvedValue({
      ...resources,
      accessTokenExpiresAt: renewedExpiration,
    });
    dependencyMocks.readAndVerifyManagedTopology.mockImplementation(async () => {
      topologyReads += 1;
      return {
        resources: {
          ...resources,
          accessTokenExpiresAt: topologyReads >= 3 ? renewedExpiration : oldExpiration,
        },
        sourceVersionId: "version-1",
        currentReleaseId: release.releaseId,
      };
    });
    dependencyMocks.readAndVerifyMaintenanceWorker.mockResolvedValue("version-1");
    memory.values.set(ANCHOR_KEY, {
      schemaVersion: 1,
      installationId,
      workerId: "worker-1",
      placementRegion: "wnam",
      resourceIdentity: installationResourceIdentity(resources),
      accessTokenExpiresAt: oldExpiration,
      containerImages: {},
    });

    await lifecycle.fetch(authorizationRequest({ intent: "update", descriptor: release }));
    await lifecycle.alarm();
    expect((memory.values.get(OPERATION_KEY) as AccountOperationRecordV1).step)
      .toBe("maintenance-renew-access");
    await lifecycle.alarm();

    expect(memory.values.get(ANCHOR_KEY)).toMatchObject({
      accessTokenExpiresAt: renewedExpiration,
    });

    const failed = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    const failedOperationId = failed.operationId;
    failed.step = "failed";
    failed.projection = {
      stage: "failed",
      error: { code: "container_rollout_reverted", message: "retry" },
    };
    memory.values.set(OPERATION_KEY, structuredClone(failed));

    const replacement = await lifecycle.fetch(authorizationRequest({
      authorizationId: "authorization-2",
      accessToken: "oauth-token-2",
      intent: "update",
      descriptor: release,
    }));
    const replacementOperationId = (await replacement.json<{ operationId: string }>()).operationId;
    expect(replacementOperationId).not.toBe(failedOperationId);
    expect(memory.values.get(ANCHOR_KEY)).toMatchObject({ accessTokenExpiresAt: renewedExpiration });

    await lifecycle.alarm();
    const resumed = memory.values.get(OPERATION_KEY) as AccountOperationRecordV1;
    expect(resumed.resources?.accessTokenExpiresAt).toBe(renewedExpiration);
    expect(resumed.step).toBe("maintenance-renew-access");
    expect(dependencyMocks.readManagedAccessExpiration).toHaveBeenCalledOnce();
    expect(dependencyMocks.readAndVerifyMaintenanceWorker).not.toHaveBeenCalled();

    await lifecycle.alarm();
    expect(memory.values.get(OPERATION_KEY)).toMatchObject({
      step: "maintenance-upload-worker",
      resources: { accessTokenExpiresAt: renewedExpiration },
    });

    await lifecycle.alarm();
    expect(dependencyMocks.readAndVerifyMaintenanceWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        values: expect.objectContaining({ accessTokenExpiresAt: renewedExpiration }),
      }),
    );
    expect(memory.values.get(ANCHOR_KEY)).toMatchObject({ accessTokenExpiresAt: renewedExpiration });
  });
});
