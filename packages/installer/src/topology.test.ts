import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseDescriptorFixture } from "./release-fixture";
import {
  containerApplicationName,
  createFreshContainerStep,
  installationResourceIdentity,
  PlacementTopologyError,
  readAndVerifyManagedTopology,
  resourceNames,
  stageFreshHubAssets,
  uploadMaintenanceHub,
  uploadFreshHub,
  validateFreshExports,
  verifyFreshContainers,
} from "./topology";
import type { ReleaseDescriptorV1 } from "./types";

function authorization() {
  return { accessToken: "oauth", deadline: Date.now() + 60_000 };
}

afterEach(() => vi.unstubAllGlobals());

function descriptor(): ReleaseDescriptorV1 {
  return releaseDescriptorFixture();
}

function runtimeValues(release: ReleaseDescriptorV1) {
  return {
    installationId: "a".repeat(26),
    releaseId: release.releaseId,
    workersDevHostname: "tiller.demo.workers.dev",
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
    ownerEmail: "owner@example.com",
    accessServiceClientSecret: "secret",
  };
}

function managedDescriptor(): ReleaseDescriptorV1 {
  return descriptor();
}

describe("fresh topology", () => {
  it("derives opaque resource names from the random installation ID", () => {
    const id = "a".repeat(26);
    expect(resourceNames(id)).toEqual({ kvTitle: `tiller-${id}-kv`, r2Bucket: `tiller-${id}-r2` });
    expect(containerApplicationName(id, "sandbox")).toBe(`tiller-${id}-sandbox`);
  });

  it("requires the one fresh export reconciliation result", () => {
    const release = descriptor();
    expect(() => validateFreshExports({
      id: "tiller",
      exports_reconciliation: { created: ["SandboxDO"] },
    }, release)).not.toThrow();
    expect(() => validateFreshExports({
      id: "tiller",
      exports_reconciliation: { created: [], updated: ["SandboxDO"] },
    }, release)).toThrow(/exact fresh/);
  });

  it("uses Wrangler's exact Worker upload shape for Container classes", async () => {
    const release = descriptor();
    let metadata: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt", buckets: [] } });
      }
      if (url.pathname.endsWith("/workers/scripts/tiller") && init?.method === "PUT") {
        const form = init.body as FormData;
        metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
        return Response.json({
          success: true,
          result: { id: "tiller", exports_reconciliation: { created: ["SandboxDO"] } },
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadFreshHub({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      resources: {
        installationId: "a".repeat(26),
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        kvNamespaceId: "kv-1",
        r2BucketName: `tiller-${"a".repeat(26)}-r2`,
      },
      values: runtimeValues(release),
      bundle: {
        modules: [{ name: release.uploadTemplate.mainModule, content: new Uint8Array([1]), contentType: "application/javascript+module" }],
        assets: [{ path: "index.html", content: new Uint8Array([1]), contentType: "text/html" }],
      },
      assetsJwt: "assets-jwt",
      placementRegion: "wnam",
    });

    expect(metadata?.containers).toEqual([{ class_name: "SandboxDO" }]);
    expect(metadata?.exports).toEqual({
      SandboxDO: {
        type: "durable-object",
        storage: "sqlite",
        state: "created",
      },
    });
    expect(metadata?.bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" },
    ]));
    expect(release.uploadTemplate.bindings.some((binding) => binding.name === "DO_LOCATION_HINT"))
      .toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => (
      new URL(String(input)).pathname.endsWith("/assets-upload-session")
    ))).toBe(false);
  });

  it("stages content-addressed assets repeatably without starting the final Worker PUT", async () => {
    const release = descriptor();
    let sessions = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/assets-upload-session")) {
        sessions += 1;
        return Response.json({ success: true, result: { jwt: `assets-jwt-${sessions}`, buckets: [] } });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const bundle = {
      modules: [{ name: release.uploadTemplate.mainModule, content: new Uint8Array([1]), contentType: "application/javascript+module" }],
      assets: [{ path: "index.html", content: new Uint8Array([1]), contentType: "text/html" }],
    };

    await expect(stageFreshHubAssets({
      authorization: authorization(),
      accountId: "account-1",
      bundle,
    })).resolves.toBe("assets-jwt-1");
    await expect(stageFreshHubAssets({
      authorization: authorization(),
      accountId: "account-1",
      bundle,
    })).resolves.toBe("assets-jwt-2");

    expect(sessions).toBe(2);
    expect(fetchMock.mock.calls.some(([input], index) => (
      new URL(String(input)).pathname.endsWith("/workers/scripts/tiller")
      && (fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.method === "PUT"
    ))).toBe(false);
  });

  it("updates v0.2.44 to v0.2.45 with the same Access client ID and inherited secret", async () => {
    const installedRelease = {
      ...managedDescriptor(),
      releaseId: "4".repeat(40),
      version: "0.2.44",
    };
    const release = {
      ...managedDescriptor(),
      releaseId: "5".repeat(40),
      version: "0.2.45",
    };
    const installedValues = {
      ...runtimeValues(installedRelease),
      accessServiceClientId: "installed-client.access",
      accessServiceClientSecret: "installed-secret",
    };
    const values = {
      ...runtimeValues(release),
      accessServiceClientId: installedValues.accessServiceClientId,
    };
    const installedVersionId = "version-v0-2-44";
    let metadata: { bindings?: Array<Record<string, unknown>> } | undefined;
    let uploadUrl: URL | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt", buckets: [] } });
      }
      if (url.pathname.endsWith("/workers/scripts/tiller/versions") && init?.method === "GET") {
        return Response.json({ success: true, result: { items: [{ id: installedVersionId }] } });
      }
      if (url.pathname.endsWith("/workers/scripts/tiller") && init?.method === "PUT") {
        uploadUrl = url;
        metadata = JSON.parse(String((init.body as FormData).get("metadata")));
        return Response.json({
          success: true,
          result: { id: "tiller", exports_reconciliation: {} },
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${url.pathname}`);
    }));
    await uploadMaintenanceHub({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      resources: {
        installationId: values.installationId,
        ownerEmail: values.ownerEmail,
        workersDevHostname: values.workersDevHostname,
        kvNamespaceId: "kv-1",
        r2BucketName: `tiller-${values.installationId}-r2`,
      },
      values,
      sourceVersionId: installedVersionId,
      bundle: {
        modules: [{ name: "index.js", content: new Uint8Array([1]), contentType: "application/javascript+module" }],
        assets: [{ path: "index.html", content: new Uint8Array([1]), contentType: "text/html" }],
      },
      placementRegion: "wnam",
    });
    expect(uploadUrl?.searchParams.get("bindings_inherit")).toBe("strict");
    expect(metadata?.bindings).toEqual(expect.arrayContaining([
      { type: "plain_text", name: "TILLER_RELEASE_ID", text: release.releaseId },
      { type: "plain_text", name: "CF_ACCESS_SERVICE_CLIENT_ID", text: installedValues.accessServiceClientId },
      { type: "inherit", name: "TILLER_OWNER_EMAIL", version_id: "latest" },
      { type: "inherit", name: "CF_ACCESS_SERVICE_CLIENT_SECRET", version_id: "latest" },
      { type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" },
    ]));
    expect(metadata?.bindings?.some((binding) => binding.type === "secret_text")).toBe(false);
  });

  it("reads the exact managed v1 topology while allowing only Container digest drift", async () => {
    const release = managedDescriptor();
    const values = runtimeValues(release);
    const currentRelease = "b".repeat(40);
    const r2Name = `tiller-${values.installationId}-r2`;
    let workerPlacement: unknown;
    const containerDetail = {
      id: "application-1",
      name: `tiller-${values.installationId}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: {
        image: `docker.io/example/tiller@sha256:${"d".repeat(64)}`,
        instance_type: "basic",
      },
    };
    const settingsBindings: Array<Record<string, unknown>> = release.uploadTemplate.bindings.map((binding) => {
      if (binding.type === "durable_object_namespace") {
        return { type: binding.type, name: binding.name, class_name: binding.className, namespace_id: "namespace-1" };
      }
      if (binding.type === "kv_namespace") return { type: binding.type, name: binding.name, namespace_id: "kv-1" };
      if (binding.type === "r2_bucket") return { type: binding.type, name: binding.name, bucket_name: r2Name };
      if (binding.type === "secret_text") return { type: binding.type, name: binding.name };
      if (binding.type === "plain_text") {
        const text = "text" in binding
          ? binding.text
          : binding.runtimeSlot === "installer-schema"
            ? "1"
            : binding.runtimeSlot === "release-id"
              ? currentRelease
              : values[Object.entries({
                "installation-id": "installationId",
                "workers-dev-hostname": "workersDevHostname",
                "access-issuer": "accessIssuer",
                "access-audience": "accessAudience",
                "access-identity-provider-id": "accessIdentityProviderId",
                "access-application-id": "accessApplicationId",
                "access-owner-policy-id": "accessOwnerPolicyId",
                "access-service-policy-id": "accessServicePolicyId",
                "access-public-application-id": "accessPublicApplicationId",
                "access-public-policy-id": "accessPublicPolicyId",
                "access-service-token-id": "accessServiceTokenId",
                "access-service-client-id": "accessServiceClientId",
                "access-token-expires-at": "accessTokenExpiresAt",
              }).find(([slot]) => slot === binding.runtimeSlot)![1] as keyof typeof values];
        return { type: binding.type, name: binding.name, text };
      }
      return { type: binding.type, name: binding.name };
    });
    settingsBindings.push({ type: "plain_text", name: "DO_LOCATION_HINT", text: "wnam" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      let result: unknown;
      if (path.endsWith("/workers/workers/worker-1")) {
        result = { id: "worker-1", name: "tiller", tags: ["tiller-installer-v1"] };
      } else if (path.endsWith("/workers/scripts/tiller/subdomain")) {
        result = { enabled: true, previews_enabled: false };
      } else if (path.endsWith("/workers/subdomain")) {
        result = { subdomain: "demo" };
      } else if (path.endsWith("/workers/scripts/tiller/deployments")) {
        result = { deployments: [{ id: "deployment-1", versions: [{ version_id: "version-1", percentage: 100 }] }] };
      } else if (path.endsWith("/workers/scripts/tiller/versions/version-1")) {
        result = {
          id: "version-1",
          resources: {
            bindings: settingsBindings,
            script_runtime: {
              containers: [{ class_name: "SandboxDO" }],
              exports: {
                SandboxDO: {
                  type: "durable-object",
                  storage: "sqlite",
                  state: "created",
                },
              },
            },
          },
        };
      } else if (path.endsWith("/workers/scripts/tiller/versions")) {
        result = { items: [{ id: "version-1" }] };
      } else if (path.endsWith("/workers/scripts/tiller/script-settings")) {
        result = {
          logpush: false,
          observability: { enabled: false, head_sampling_rate: 0 },
          tags: ["tiller-installer-v1"],
          tail_consumers: [],
        };
      } else if (path.endsWith("/workers/scripts/tiller/settings")) {
        result = {
          annotations: { "workers/tag": currentRelease },
          placement: workerPlacement,
          bindings: settingsBindings,
        };
      } else if (path.endsWith("/storage/kv/namespaces")) {
        result = [{ id: "kv-1", title: `tiller-${values.installationId}-kv` }];
      } else if (path.endsWith(`/r2/buckets/${r2Name}`)) {
        result = { name: r2Name };
      } else if (path.endsWith("/containers/applications")) {
        result = [{
          id: "application-1",
          name: `tiller-${values.installationId}-sandbox`,
        }];
      } else if (path.endsWith("/containers/applications/application-1")) {
        result = containerDetail;
      } else {
        throw new Error(`unexpected ${path}`);
      }
      return Response.json({
        success: true,
        result,
        ...(path.endsWith("/storage/kv/namespaces") ? { result_info: { page: 1, total_pages: 1 } } : {}),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const anchor = {
      schemaVersion: 1 as const,
      placementRegion: "wnam" as const,
      installationId: values.installationId,
      workerId: "worker-1",
      accessTokenExpiresAt: values.accessTokenExpiresAt,
      resourceIdentity: {
        ownerEmail: values.ownerEmail,
        workersDevHostname: values.workersDevHostname,
        kvNamespaceId: "kv-1",
        r2BucketName: r2Name,
        accessIdentityProviderId: values.accessIdentityProviderId,
        accessServiceTokenId: values.accessServiceTokenId,
        accessServiceClientId: values.accessServiceClientId,
        accessIssuer: values.accessIssuer,
        accessApplicationId: values.accessApplicationId,
        accessAudience: values.accessAudience,
        accessOwnerPolicyId: values.accessOwnerPolicyId,
        accessServicePolicyId: values.accessServicePolicyId,
        accessPublicApplicationId: values.accessPublicApplicationId,
        accessPublicPolicyId: values.accessPublicPolicyId,
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: {
          SandboxDO: { id: "application-1", name: `tiller-${values.installationId}-sandbox` },
        },
      },
      containerImages: {
        SandboxDO: `docker.io/example/tiller@sha256:${"d".repeat(64)}`,
      },
    };
    const result = await readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    });
    expect(result).toMatchObject({
      currentReleaseId: currentRelease,
      sourceVersionId: "version-1",
      containerImages: {
        SandboxDO: `docker.io/example/tiller@sha256:${"d".repeat(64)}`,
      },
      resources: {
        kvNamespaceId: "kv-1",
        r2BucketName: r2Name,
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
        containerApplications: { SandboxDO: { id: "application-1" } },
      },
    });
    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname.endsWith("/containers/applications/application-1")
    ))).toHaveLength(1);
    settingsBindings.pop();
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toBeInstanceOf(PlacementTopologyError);
    settingsBindings.push({ type: "plain_text", name: "DO_LOCATION_HINT", text: "enam" });
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toBeInstanceOf(PlacementTopologyError);
    settingsBindings[settingsBindings.length - 1].text = "wnam";
    containerDetail.constraints.regions = ["ENAM"];
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/topology drift/);
    containerDetail.constraints.regions = ["WNAM"];
    containerDetail.durable_objects.namespace_id = "wrong-namespace";
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/topology drift/);
    containerDetail.durable_objects.namespace_id = "namespace-1";
    containerDetail.id = "different-application";
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/incomplete/);
    containerDetail.id = "application-1";
    (settingsBindings[0] as { class_name?: string }).class_name = "ForeignDO";
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/topology drift/);
    (settingsBindings[0] as { class_name?: string; script_name?: string }).class_name = "SandboxDO";
    (settingsBindings[0] as { script_name?: string }).script_name = "foreign-worker";
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/topology drift/);
    (settingsBindings[0] as { script_name?: string }).script_name = undefined;
    workerPlacement = { mode: "smart" };
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/unsupported fixed-topology settings/);
    workerPlacement = {};
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).resolves.toBeDefined();
    workerPlacement = undefined;
    anchor.resourceIdentity.kvNamespaceId = "replacement-kv";
    await expect(readAndVerifyManagedTopology({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      anchor,
      placementRegion: anchor.placementRegion,
      ownerEmail: values.ownerEmail,
    })).rejects.toThrow(/resource identities changed/);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("requires exact regional Container placement before maintenance", async () => {
    const release = descriptor();
    const application = {
      id: "application-1",
      name: `tiller-${"a".repeat(26)}-sandbox`,
      max_instances: 2,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
      configuration: { image: release.containers[0].image, instance_type: "basic" },
    };
    const { assertManagedContainerTopology } = await import("./topology");
    expect(() => assertManagedContainerTopology(
      application,
      release.containers[0],
      "namespace-1",
      application.name,
      "enam",
    )).toThrow(/topology drift/);
    expect(() => assertManagedContainerTopology(
      application,
      release.containers[0],
      "namespace-1",
      application.name,
      "wnam",
    )).not.toThrow();
    expect(() => assertManagedContainerTopology(
      { ...application, constraints: { regions: ["WNAM"], tier: 1 } },
      release.containers[0],
      "namespace-1",
      application.name,
      "wnam",
    )).not.toThrow();
    expect(() => assertManagedContainerTopology(
      { ...application, constraints: { regions: ["WNAM"], tiers: [1, 2] } },
      release.containers[0],
      "namespace-1",
      application.name,
      "wnam",
    )).not.toThrow();
    expect(() => assertManagedContainerTopology(
      { ...application, constraints: { regions: ["ENAM"] } },
      release.containers[0],
      "namespace-1",
      application.name,
      "wnam",
    )).toThrow(/topology drift/);
    for (const constraints of [
      { regions: ["WNAM"], jurisdictions: [] },
      { regions: ["WNAM"], futurePolicy: null },
      { regions: ["WNAM"], tier: null },
    ]) {
      expect(() => assertManagedContainerTopology(
        { ...application, constraints },
        release.containers[0],
        "namespace-1",
        application.name,
        "wnam",
      )).toThrow(/topology drift/);
    }
  });

  it("refuses to adopt a pre-existing derived Container name", async () => {
    const id = "a".repeat(26);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/containers/applications")) {
        return Response.json({
          success: true,
          result: [{ id: "foreign", name: `tiller-${id}-sandbox` }],
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutate = vi.fn();
    await expect(createFreshContainerStep({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: descriptor(),
      resources: {
        installationId: id,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
      },
      placementRegion: "wnam",
      mutate,
    })).rejects.toThrow(/will not be adopted/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("creates and verifies Containers with Cloudflare's default scheduling policy", async () => {
    const id = "a".repeat(26);
    const release = descriptor();
    const expected = {
      id: "application-1",
      name: `tiller-${id}-sandbox`,
      configuration: {
        image: release.containers[0].image,
        vcpu: 0.25,
        memory: "1GiB",
        memory_mib: 1_024,
        disk: { size: "4GB", size_mb: 4_000 },
        network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
        command: [],
        entrypoint: [],
        runtime: "firecracker",
      },
      instances: 0,
      max_instances: release.containers[0].maxInstances,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      durable_objects: { namespace_id: "namespace-1" },
    };
    let createBody: Record<string, unknown> | undefined;
    let readbacks = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/containers/applications") && method === "GET") {
        return Response.json({ success: true, result: [] });
      }
      if (url.pathname.endsWith("/containers/applications") && method === "POST") {
        createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ success: true, result: expected });
      }
      if (url.pathname.endsWith("/containers/applications/application-1")) {
        readbacks += 1;
        return Response.json({ success: true, result: expected });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutate = <T>(operation: () => Promise<T>): Promise<T> => operation();
    const result = await createFreshContainerStep({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      resources: {
        installationId: id,
        ownerEmail: "owner@example.com",
        workersDevHostname: "tiller.demo.workers.dev",
        durableObjectNamespaceIds: { SandboxDO: "namespace-1" },
      },
      mutate,
      placementRegion: "wnam",
    });

    expect(createBody).toMatchObject({
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      configuration: { instance_type: release.containers[0].instanceType },
    });
    expect(result.resources.containerApplications).toEqual({
      SandboxDO: { id: "application-1", name: `tiller-${id}-sandbox` },
    });
    expect(readbacks).toBe(0);
  });

  it("distinguishes a delayed fresh Container list from ambiguous topology", async () => {
    const id = "a".repeat(26);
    const release = descriptor();
    const resources = {
      installationId: id,
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      durableObjectNamespaceIds: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, `namespace-${index + 1}`]
      ))),
      containerApplications: Object.fromEntries(release.containers.map((container, index) => (
        [container.className, {
          id: `application-${index + 1}`,
          name: `tiller-${id}-${container.applicationNameSuffix}`,
        }]
      ))),
    };
    let applications: Array<{ id: string; name: string }> = [];
    const details = new Map<string, Record<string, unknown>>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/containers/applications")) {
        return Response.json({ success: true, result: applications });
      }
      const applicationId = path.split("/").at(-1) ?? "";
      const detail = details.get(applicationId);
      if (!detail) throw new Error(`unexpected ${path}`);
      return Response.json({ success: true, result: detail });
    });
    vi.stubGlobal("fetch", fetchMock);
    const args = {
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      resources,
      placementRegion: "wnam" as const,
    };

    await expect(verifyFreshContainers(args)).resolves.toBe(false);

    const container = release.containers[0];
    const name = `tiller-${id}-${container.applicationNameSuffix}`;
    applications = [{ id: "application-1", name }];
    details.set("application-1", {
      id: "application-1",
      name,
      max_instances: container.maxInstances,
      scheduling_policy: "default",
      constraints: { regions: ["WNAM"] },
      configuration: {
        image: container.image,
        instance_type: container.instanceType,
      },
      durable_objects: { namespace_id: "namespace-1" },
    });
    await expect(verifyFreshContainers(args)).resolves.toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname.endsWith("/containers/applications/application-1")
    ))).toHaveLength(1);

    details.set("application-1", {
      ...details.get("application-1"),
      durable_objects: { namespace_id: "wrong-namespace" },
    });
    await expect(verifyFreshContainers(args)).rejects.toThrow(/failed final verification/);

    details.set("application-1", {
      ...details.get("application-1"),
      id: "different-application",
      durable_objects: { namespace_id: "namespace-1" },
    });
    await expect(verifyFreshContainers(args)).rejects.toThrow(/failed final verification/);

    applications = [{
      id: "wrong-id",
      name,
    }];
    await expect(verifyFreshContainers(args)).rejects.toThrow(/failed final verification/);

    applications = [{ id: "foreign", name: `tiller-${id}-unexpected` }];
    await expect(verifyFreshContainers(args)).rejects.toThrow(/ambiguous/);
  });

  it("rejects a present checkpoint identity conflict even while another Container is missing", async () => {
    const id = "a".repeat(26);
    const release = descriptor();
    release.containers.push({
      ...release.containers[0],
      className: "SecondDO",
      applicationNameSuffix: "second",
    });
    const resources = {
      installationId: id,
      ownerEmail: "owner@example.com",
      workersDevHostname: "tiller.demo.workers.dev",
      durableObjectNamespaceIds: {
        SandboxDO: "namespace-1",
        SecondDO: "namespace-2",
      },
      containerApplications: {
        SandboxDO: { id: "application-1", name: `tiller-${id}-sandbox` },
        SecondDO: { id: "application-2", name: `tiller-${id}-second` },
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (!path.endsWith("/containers/applications")) throw new Error(`unexpected ${path}`);
      return Response.json({
        success: true,
        result: [{ id: "wrong-id", name: `tiller-${id}-sandbox` }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyFreshContainers({
      authorization: authorization(),
      accountId: "account-1",
      descriptor: release,
      resources,
      placementRegion: "wnam",
    })).rejects.toThrow(/failed final verification/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
