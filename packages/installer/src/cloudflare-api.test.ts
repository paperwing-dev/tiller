import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudflareApi,
  CloudflareApiError,
  createContainerApplication,
  createImmediateContainerRollout,
  getActiveWorkerVersion,
  getContainerRollout,
  getWorker,
  listAccounts,
  listContainerRegistries,
  listContainerRollouts,
  listWorkers,
  patchContainerApplication,
  refreshAccessServiceToken,
  uploadWorkerScript,
  uploadWorkerScriptWithInheritance,
} from "./cloudflare-api";

function authorization(deadline = Date.now() + 60_000) {
  return { accessToken: "token", deadline };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Cloudflare API mutation boundaries", () => {
  it("marks malformed successful mutation responses as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    const error = await cloudflareApi(authorization(), "/resource", { method: "POST" }, { mutation: true })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).uncertain).toBe(true);
  });

  it("treats a conclusive client rejection as non-ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [{ code: 10001, message: "not retained without an explicit safe operation" }],
    }, { status: 400 })));
    const error = await cloudflareApi(authorization(), "/resource", { method: "POST" }, { mutation: true })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect((error as CloudflareApiError).uncertain).toBe(false);
    expect((error as CloudflareApiError).errorCodes).toEqual([10001]);
    expect((error as CloudflareApiError).errorMessages).toEqual([]);
    expect((error as CloudflareApiError).requestMethod).toBe("POST");
  });

  it("retains bounded Container diagnostics and the Cloudflare Ray ID", async () => {
    const longMessage = "x".repeat(600);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      success: false,
      errors: [
        { code: 1605, message: " Durable Object namespace\nis not ready. " },
        { code: 1605, message: "Durable Object namespace is not ready." },
        { code: 1606, message: longMessage },
        { message: "third message" },
        { message: "fourth message" },
        { message: "discarded fifth message" },
      ],
    }, {
      status: 400,
      headers: { "cf-ray": "9abc123def456789-SJC" },
    })));

    const error = await createContainerApplication(
      authorization(),
      "account-1",
      { name: "tiller-test-sandbox" },
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error).toMatchObject({
      status: 400,
      uncertain: false,
      errorCodes: [1605, 1606],
      rayId: "9abc123def456789-SJC",
      requestMethod: "POST",
      operation: "container-applications.create",
    });
    expect((error as CloudflareApiError).errorMessages).toHaveLength(4);
    expect((error as CloudflareApiError).errorMessages[0])
      .toBe("Durable Object namespace is not ready.");
    expect((error as CloudflareApiError).errorMessages[1]).toHaveLength(512);
    expect((error as CloudflareApiError).errorMessages).not.toContain("discarded fifth message");
  });

  it("labels Worker point and list read failures for bounded recovery diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return Response.json({
        success: false,
        errors: [{ code: path.endsWith("worker-1") ? 10090 : 10091, message: "Worker read failed" }],
      }, {
        status: path.endsWith("worker-1") ? 404 : 503,
        headers: { "cf-ray": "a26299ed12345678-SJC" },
      });
    }));

    const pointError = await getWorker(authorization(), "account-1", "worker-1")
      .catch((value: unknown) => value);
    expect(pointError).toMatchObject({
      status: 404,
      errorCodes: [10090],
      errorMessages: [],
      rayId: "a26299ed12345678-SJC",
      requestMethod: "GET",
      operation: "workers.get",
    });

    const listError = await listWorkers(authorization(), "account-1")
      .catch((value: unknown) => value);
    expect(listError).toMatchObject({
      status: 503,
      errorCodes: [10091],
      errorMessages: [],
      rayId: "a26299ed12345678-SJC",
      requestMethod: "GET",
      operation: "workers.list",
    });
  });

  it("lists configured registries without mutating shared registry state", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: [{ domain: "registry.cloudflare.com", kind: "Cloudflare" }],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContainerRegistries(authorization(), "account/with spaces"))
      .resolves.toEqual([{ domain: "registry.cloudflare.com", kind: "Cloudflare" }]);

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(new URL(calls[0][0]).pathname).toBe(
      "/client/v4/accounts/account%2Fwith%20spaces/containers/registries",
    );
    expect(calls[0][1].method).toBe("GET");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses one coupled PUT fresh upload with direct bindings, no inheritance, and no script response", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { id: "tiller", exports_reconciliation: { created: ["HubDO"] } },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await uploadWorkerScript(
      authorization(),
      "account-1",
      "tiller",
      {
        main_module: "index.js",
        bindings: [{ type: "secret_text", name: "SECRET", text: "one-time-value" }],
        exports: { HubDO: { type: "durable-object", storage: "sqlite", state: "created" } },
      },
      [{ name: "index.js", content: new TextEncoder().encode("export default {}") }],
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(input);
    expect(url.pathname).toBe("/client/v4/accounts/account-1/workers/scripts/tiller");
    expect(url.searchParams.get("excludeScript")).toBe("true");
    expect(url.searchParams.has("bindings_inherit")).toBe(false);
    expect(init.method).toBe("PUT");
    const metadata = JSON.parse(String((init.body as FormData).get("metadata")));
    expect(metadata.bindings).toEqual([{ type: "secret_text", name: "SECRET", text: "one-time-value" }]);
    expect(String((init.body as FormData).get("metadata"))).not.toContain("inherit");
  });

  it("pins the sole active Worker version at 100% and returns its version and settings", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: {
            deployments: [{
              id: "deployment-1",
              versions: [{ version_id: "version-1", percentage: 100 }],
              annotations: { "workers/message": "Tiller 1.2.3" },
            }],
          },
        });
      }
      if (url.pathname.endsWith("/versions/version-1")) {
        return Response.json({
          success: true,
          result: {
            id: "version-1",
            resources: {
              bindings: [{ type: "secret_text", name: "SECRET" }],
              script_runtime: {
                assets: { not_found_handling: "single-page-application" },
                compatibility_date: "2026-07-30",
                compatibility_flags: ["nodejs_compat"],
                containers: [{ class_name: "HubDO" }],
                exports: { HubDO: { type: "durable-object", storage: "sqlite", state: "created" } },
                limits: {},
              },
            },
          },
        });
      }
      if (url.pathname.endsWith("/versions")) {
        return Response.json({ success: true, result: { items: [{ id: "version-1" }] } });
      }
      if (url.pathname.endsWith("/script-settings")) {
        return Response.json({
          success: true,
          result: {
            logpush: false,
            observability: { enabled: false, head_sampling_rate: 0 },
            tags: ["tiller-installer-v1"],
            tail_consumers: [],
          },
        });
      }
      if (url.pathname.endsWith("/settings")) {
        return Response.json({
          success: true,
          result: {
            annotations: { "workers/tag": "a".repeat(40) },
            bindings: [{ type: "secret_text", name: "SECRET" }],
            limits: { subrequests: 50 },
          },
        });
      }
      return Response.json({ success: false }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const active = await getActiveWorkerVersion(authorization(), "account-1", "tiller");

    expect(active.versionId).toBe("version-1");
    expect(active.deployment.id).toBe("deployment-1");
    expect(active.version.resources?.script_runtime?.compatibility_date).toBe("2026-07-30");
    expect(active.settings.annotations).toBeUndefined();
    expect(active.settings.assets).toEqual({ not_found_handling: "single-page-application" });
    expect(active.settings.compatibility_date).toBe("2026-07-30");
    expect(active.settings.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(active.settings.containers).toEqual([{ class_name: "HubDO" }]);
    expect(active.settings.exports).toEqual({
      HubDO: { type: "durable-object", storage: "sqlite", state: "created" },
    });
    expect(active.settings.limits).toEqual({ subrequests: 50 });
    expect(active.settings.observability).toEqual({ enabled: false, head_sampling_rate: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("rejects latest-upload settings when the active version is older", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: {
            deployments: [{
              id: "deployment-1",
              versions: [{ version_id: "version-1", percentage: 100 }],
            }],
          },
        });
      }
      if (path.endsWith("/versions/version-1")) {
        return Response.json({ success: true, result: { id: "version-1" } });
      }
      if (path.endsWith("/versions")) {
        return Response.json({ success: true, result: { items: [{ id: "version-2" }] } });
      }
      return Response.json({ success: false }, { status: 404 });
    }));

    await expect(getActiveWorkerVersion(authorization(), "account-1", "tiller"))
      .rejects.toThrow(/not the most recent upload/);

    const propagating = await getActiveWorkerVersion(
      authorization(),
      "account-1",
      "tiller",
      { retryPropagation: true },
    ).catch((error: unknown) => error);
    expect(propagating).toBeInstanceOf(CloudflareApiError);
    expect(propagating).toMatchObject({ status: 409, uncertain: false });
  });

  it("rejects settings read across an active deployment change", async () => {
    let deploymentReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/deployments")) {
        deploymentReads += 1;
        const versionId = deploymentReads === 1 ? "version-1" : "version-2";
        return Response.json({
          success: true,
          result: {
            deployments: [{
              id: deploymentReads === 1 ? "deployment-1" : "deployment-2",
              versions: [{ version_id: versionId, percentage: 100 }],
            }],
          },
        });
      }
      if (path.endsWith("/versions/version-1")) {
        return Response.json({ success: true, result: { id: "version-1" } });
      }
      if (path.endsWith("/versions")) {
        return Response.json({ success: true, result: { items: [{ id: "version-1" }] } });
      }
      if (path.endsWith("/script-settings")) {
        return Response.json({ success: true, result: {} });
      }
      if (path.endsWith("/settings")) {
        return Response.json({ success: true, result: { bindings: [] } });
      }
      return Response.json({ success: false }, { status: 404 });
    }));

    await expect(getActiveWorkerVersion(authorization(), "account-1", "tiller"))
      .rejects.toThrow(/wrong active Worker version/);
  });

  it.each([
    { versions: [] },
    { versions: [{ version_id: "version-1", percentage: 50 }, { version_id: "version-2", percentage: 50 }] },
    { versions: [{ version_id: "version-1", percentage: 99 }] },
    { versions: [{ version_id: "", percentage: 100 }] },
  ])("rejects a non-exclusive active Worker deployment before reading settings", async ({ versions }) => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { deployments: [{ id: "deployment-1", versions }] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getActiveWorkerVersion(authorization(), "account-1", "tiller"))
      .rejects.toThrow(/exactly one version at 100%/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses strict named inheritance from the pinned source version for a maintenance upload", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/versions")) {
        return Response.json({ success: true, result: { items: [{ id: "source-version" }] } });
      }
      return Response.json({
        success: true,
        result: { id: "tiller" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadWorkerScriptWithInheritance(
      authorization(),
      "account-1",
      "tiller",
      {
        main_module: "index.js",
        bindings: [{ type: "plain_text", name: "TILLER_RELEASE_ID", text: "b".repeat(40) }],
      },
      [{ name: "index.js", content: new TextEncoder().encode("export default {}") }],
      "source-version",
      ["OWNER_EMAIL", "SERVICE_CLIENT_SECRET"],
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [latestInput, latestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const latestUrl = new URL(latestInput);
    expect(latestUrl.pathname).toBe("/client/v4/accounts/account-1/workers/scripts/tiller/versions");
    expect(Object.fromEntries(latestUrl.searchParams)).toEqual({ page: "1", per_page: "1" });
    expect(latestInit?.method ?? "GET").toBe("GET");

    const [input, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const url = new URL(input);
    expect(url.pathname).toBe("/client/v4/accounts/account-1/workers/scripts/tiller");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      excludeScript: "true",
      bindings_inherit: "strict",
    });
    expect(init.method).toBe("PUT");
    const metadata = JSON.parse(String((init.body as FormData).get("metadata")));
    expect(metadata.bindings).toEqual([
      { type: "plain_text", name: "TILLER_RELEASE_ID", text: "b".repeat(40) },
      { type: "inherit", name: "OWNER_EMAIL", version_id: "latest" },
      { type: "inherit", name: "SERVICE_CLIENT_SECRET", version_id: "latest" },
    ]);
  });

  it("rejects a changed latest Worker version before the maintenance PUT", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => (
      Response.json({
        success: true,
        result: { items: [{ id: "unexpected-version" }] },
      })
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadWorkerScriptWithInheritance(
      authorization(),
      "account-1",
      "tiller",
      { main_module: "index.js", bindings: [] },
      [{ name: "index.js", content: new TextEncoder().encode("export default {}") }],
      "pinned-version",
      ["OWNER_EMAIL", "SERVICE_CLIENT_SECRET"],
    )).rejects.toThrow(/pinned Worker version is no longer the latest/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("GET");
  });

  it("rejects conflicting inherited binding names before upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadWorkerScriptWithInheritance(
      authorization(),
      "account-1",
      "tiller",
      { bindings: [{ type: "plain_text", name: "SAME", text: "value" }] },
      [],
      "source-version",
      ["SAME"],
    )).rejects.toThrow(/inheritance is invalid/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an Access service token without rotating it", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { id: "token-1", client_id: "client-1", expires_at: "2027-07-30T00:00:00Z" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await refreshAccessServiceToken(authorization(), "account-1", "token-1");

    expect(token).toMatchObject({ id: "token-1", client_id: "client-1" });
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(input).pathname).toBe("/client/v4/accounts/account-1/access/service_tokens/token-1/refresh");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("patches a Container application and creates, lists, and gets its immediate rollout", async () => {
    const statuses = ["pending", "progressing", "completed", "reverted", "replaced"] as const;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === "PATCH") {
        return Response.json({
          success: true,
          result: { id: "application-1", configuration: { image: "registry/image@sha256:new" } },
        });
      }
      if (init?.method === "POST") {
        return Response.json({ success: true, result: { id: "rollout-1", status: "pending" } });
      }
      if (url.pathname.endsWith("/rollouts/rollout-1")) {
        return Response.json({ success: true, result: { id: "rollout-1", status: "completed" } });
      }
      return Response.json({
        success: true,
        result: statuses.map((status, index) => ({ id: `rollout-${index}`, status })),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const targetConfiguration = {
      image: "registry/image@sha256:new",
      instance_type: "dev",
    };
    await patchContainerApplication(
      authorization(),
      "account-1",
      "application-1",
      { configuration: targetConfiguration },
    );
    await createImmediateContainerRollout(
      authorization(),
      "account-1",
      "application-1",
      targetConfiguration,
    );
    const rollouts = await listContainerRollouts(authorization(), "account-1", "application-1");
    const completed = await getContainerRollout(
      authorization(),
      "account-1",
      "application-1",
      "rollout-1",
    );

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(new URL(calls[0][0]).pathname).toBe("/client/v4/accounts/account-1/containers/applications/application-1");
    expect(calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ configuration: targetConfiguration });
    expect(new URL(calls[1][0]).pathname).toBe("/client/v4/accounts/account-1/containers/applications/application-1/rollouts");
    expect(calls[1][1].method).toBe("POST");
    expect(JSON.parse(String(calls[1][1].body))).toEqual({
      description: "Tiller fixed-topology image update",
      strategy: "rolling",
      target_configuration: targetConfiguration,
      step_percentage: 100,
      kind: "full_auto",
    });
    expect(rollouts.map((rollout) => rollout.status)).toEqual(statuses);
    expect(completed.status).toBe("completed");
  });

  it("does not start a later paginated read after the authorization deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-30T00:00:00.000Z");
    const deadline = Date.now() + 1_000;
    const fetchMock = vi.fn(async () => {
      vi.setSystemTime(deadline + 1);
      return Response.json({
        success: true,
        result: Array.from({ length: 50 }, (_, index) => ({ id: `account-${index}` })),
        result_info: { page: 1, total_pages: 2 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAccounts(authorization(deadline))).rejects.toThrow(/Cloudflare API request failed/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
