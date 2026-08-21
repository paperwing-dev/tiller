import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accessTeamLabel,
  AccessPropagationError,
  destinationCanConflict,
  provisionFreshAccessStep,
  readManagedAccessExpiration,
  renewManagedAccess,
  validateFreshAccessPreflight,
  validateManagedAccess,
  type AccessMutation,
} from "./access";
import type { AccessApplication } from "./cloudflare-api";

function authorization() {
  return { accessToken: "oauth", deadline: Date.now() + 60_000 };
}

function app(destinations: AccessApplication["destinations"], domain?: string): AccessApplication {
  return { destinations, domain };
}

afterEach(() => vi.unstubAllGlobals());

describe("fresh Access provisioning", () => {
  const hostname = "tiller.demo.workers.dev";

  it("fails closed for exact, wildcard, account-wide, malformed, and legacy coverage", () => {
    expect(destinationCanConflict(app([{ type: "public", uri: `${hostname}/admin` }]), "worker-1", hostname)).toBe(true);
    expect(destinationCanConflict(app([{ type: "public", uri: "*.demo.workers.dev" }]), "worker-1", hostname)).toBe(true);
    expect(destinationCanConflict(app([{ type: "all_workers" }]), "worker-1", hostname)).toBe(true);
    expect(destinationCanConflict(app([{ type: "future_destination" }]), "worker-1", hostname)).toBe(true);
    expect(destinationCanConflict(app([{ type: "public", uri: "unrelated.example.com/path" }]), "worker-1", hostname)).toBe(false);
    expect(destinationCanConflict(app([{ type: "worker", worker_id: "worker-2" }]), "worker-1", hostname)).toBe(false);
  });

  it("rejects an existing hostname destination before fresh resource creation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith("/access/apps")) {
        return Response.json({
          success: true,
          result: [{
            id: "old-public-app",
            destinations: [{ type: "public", uri: `${hostname}/health` }],
          }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${path}`);
    }));

    await expect(validateFreshAccessPreflight({
      authorization: authorization(),
      accountId: "account-1",
      workersDevHostname: hostname,
    })).rejects.toThrow(/already protects/);
  });

  it("allows unrelated Access destinations during fresh preflight", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
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
      if (path.endsWith("/access/apps")) {
        return Response.json({
          success: true,
          result: [{ destinations: [{ type: "worker", worker_id: "old-worker" }] }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${path}`);
    }));

    await expect(validateFreshAccessPreflight({
      authorization: authorization(),
      accountId: "account-1",
      workersDevHostname: hostname,
    })).resolves.toBeUndefined();
  });

  it("never adopts a same-name service token whose one-time secret is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith("/access/service_tokens")) {
        return Response.json({
          success: true,
          result: [{ id: "token-1", name: `Tiller (${"a".repeat(26)})` }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      return Response.json({ success: false, errors: [] }, { status: 404 });
    }));
    const mutate = vi.fn();
    await expect(provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId: "a".repeat(26),
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
        accessIdentityProviderId: "idp-1",
      },
      mutate,
    })).rejects.toThrow(/already exists/);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("creates at most one Access resource per step", async () => {
    const installationId = "a".repeat(26);
    const teamLabel = `demo-tiller-${installationId}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations") && init?.method === "POST") {
        return Response.json({
          success: true,
          result: { name: "Tiller", auth_domain: `${teamLabel}.cloudflareaccess.com` },
        });
      }
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutateMock = vi.fn();
    const mutate: AccessMutation = async <T>(operation: () => Promise<T>) => {
      mutateMock();
      return operation();
    };
    const result = await provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
      },
      mutate,
    });
    expect(result.done).toBe(false);
    expect(result.resources.accessIssuer).toBe(`https://${teamLabel}.cloudflareaccess.com`);
    expect(mutateMock).toHaveBeenCalledOnce();
  });

  it("keeps polling for an automatic account-member IdP beyond thirty seconds", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
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
    const mutate = vi.fn();

    await expect(provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId: "a".repeat(26),
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
        accessIssuer: "https://team.cloudflareaccess.com",
        accessOrganizationCreatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      mutate,
    })).rejects.toBeInstanceOf(AccessPropagationError);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("normalizes and caps the readable Access team label while retaining the full installation ID", () => {
    const installationId = "b".repeat(26);
    const label = accessTeamLabel(
      `tiller.${"Readable___Prefix-".repeat(8)}.workers.dev`,
      installationId,
    );
    expect(label.length).toBeLessThanOrEqual(63);
    expect(label).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(label).toMatch(new RegExp(`-tiller-${installationId}$`));
    expect(label.startsWith("readable-prefix-")).toBe(true);
  });

  it("persists a newly created service token without requiring expires_at in the create response", async () => {
    const installationId = "a".repeat(26);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith("/access/service_tokens") && init?.method === "POST") {
        return Response.json({
          success: true,
          result: {
            id: "token-1",
            name: `Tiller (${installationId})`,
            client_id: "service-client.access",
            client_secret: "one-time-secret",
            duration: "8760h",
          },
        }, { status: 201 });
      }
      if (path.endsWith("/access/service_tokens")) {
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const mutate: AccessMutation = (operation) => operation();

    const result = await provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
        accessIdentityProviderId: "idp-1",
      },
      mutate,
    });

    expect(result).toMatchObject({
      done: false,
      serviceClientSecret: "one-time-secret",
      resources: {
        accessServiceTokenId: "token-1",
        accessServiceClientId: "service-client.access",
      },
    });
    expect(result.resources.accessTokenExpiresAt).toBeUndefined();
  });

  it("records service-token expiration from authoritative readback on the next step", async () => {
    const installationId = "a".repeat(26);
    const expiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith("/access/service_tokens/token-1")) {
        return Response.json({
          success: true,
          result: {
            id: "token-1",
            name: `Tiller (${installationId})`,
            client_id: "service-client.access",
            expires_at: expiration,
          },
        });
      }
      throw new Error(`unexpected ${path}`);
    }));
    const mutateMock = vi.fn();
    const mutate: AccessMutation = async <T>(_operation: () => Promise<T>): Promise<T> => {
      mutateMock();
      throw new Error("unexpected mutation");
    };

    const result = await provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
        accessIssuer: "https://team.cloudflareaccess.com",
        accessIdentityProviderId: "idp-1",
        accessServiceTokenId: "token-1",
        accessServiceClientId: "service-client.access",
      },
      mutate,
    });

    expect(result).toMatchObject({ done: false, resources: { accessTokenExpiresAt: expiration } });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("creates a Worker destination without the incompatible legacy domain field", async () => {
    const installationId = "a".repeat(26);
    const expiration = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
    let createBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/access/organizations")) {
        return Response.json({ success: true, result: { auth_domain: "team.cloudflareaccess.com" } });
      }
      if (path.endsWith("/access/identity_providers")) {
        return Response.json({
          success: true,
          result: [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      if (path.endsWith("/access/service_tokens/token-1")) {
        return Response.json({
          success: true,
          result: {
            id: "token-1",
            name: `Tiller (${installationId})`,
            client_id: "service-client.access",
            expires_at: expiration,
          },
        });
      }
      if (path.endsWith("/access/apps") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json({
          success: true,
          result: { id: "app-main", aud: "audience-1", ...createBody },
        }, { status: 201 });
      }
      if (path.endsWith("/access/apps")) {
        return Response.json({
          success: true,
          result: [],
          result_info: { page: 1, total_pages: 1 },
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    }));
    const mutate: AccessMutation = (operation) => operation();

    const result = await provisionFreshAccessStep({
      authorization: authorization(),
      accountId: "account-1",
      resources: {
        installationId,
        ownerEmail: "owner@example.com",
        workersDevHostname: hostname,
        workerId: "worker-1",
        accessIssuer: "https://team.cloudflareaccess.com",
        accessIdentityProviderId: "idp-1",
        accessServiceTokenId: "token-1",
        accessServiceClientId: "service-client.access",
        accessTokenExpiresAt: expiration,
      },
      mutate,
    });

    expect(createBody).not.toHaveProperty("domain");
    expect(createBody).toMatchObject({ destinations: [{ type: "worker", worker_id: "worker-1" }] });
    expect(result).toMatchObject({
      done: false,
      resources: { accessApplicationId: "app-main", accessAudience: "audience-1" },
    });
  });
});

describe("managed Access maintenance", () => {
  const installationId = "a".repeat(26);
  const hostname = "tiller.demo.workers.dev";
  const baseExpiration = "2027-07-30T00:00:00.000Z";
  const resources = {
    installationId,
    ownerEmail: "owner@example.com",
    workersDevHostname: hostname,
    workerId: "worker-1",
    accessIssuer: "https://team.cloudflareaccess.com",
    accessIdentityProviderId: "idp-1",
    accessServiceTokenId: "token-1",
    accessServiceClientId: "service-client.access",
    accessTokenExpiresAt: baseExpiration,
    accessApplicationId: "app-main",
    accessAudience: "audience-1",
    accessOwnerPolicyId: "policy-owner",
    accessServicePolicyId: "policy-service",
    accessPublicApplicationId: "app-public",
    accessPublicPolicyId: "policy-public",
  };

  function accessFetch(expiration = baseExpiration, refreshedExpiration?: string) {
    let currentExpiration = expiration;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const resultInfo = { page: 1, total_pages: 1 };
      let result: unknown;
      if (path.endsWith("/access/organizations")) {
        result = { auth_domain: "team.cloudflareaccess.com" };
      } else if (path.endsWith("/access/identity_providers")) {
        result = [{ id: "idp-1", type: "cloudflare", read_only: false, config: { restrict_to_account_members: true } }];
      } else if (path.endsWith("/access/service_tokens/token-1/refresh") && init?.method === "POST") {
        currentExpiration = refreshedExpiration ?? currentExpiration;
        result = { id: "token-1", name: `Tiller (${installationId})`, client_id: "service-client.access", expires_at: refreshedExpiration };
      } else if (path.endsWith("/access/service_tokens/token-1")) {
        result = { id: "token-1", name: `Tiller (${installationId})`, client_id: "service-client.access", expires_at: currentExpiration };
      } else if (path.endsWith("/access/apps")) {
        result = [];
      } else if (path.endsWith("/access/apps/app-main")) {
        result = {
          id: "app-main",
          type: "self_hosted",
          name: `Tiller Hub (${installationId})`,
          aud: "audience-1",
          destinations: [{ type: "worker", worker_id: "worker-1" }],
          allowed_idps: ["idp-1"],
          auto_redirect_to_identity: true,
          app_launcher_visible: false,
          service_auth_401_redirect: true,
          session_duration: "24h",
        };
      } else if (path.endsWith("/access/apps/app-main/policies")) {
        result = [
          { id: "policy-owner", name: "Allow Tiller owner", decision: "allow", include: [{ email: { email: "owner@example.com" } }] },
          { id: "policy-service", name: "Allow Tiller service token", decision: "non_identity", include: [{ service_token: { token_id: "token-1" } }] },
        ];
      } else if (path.endsWith("/access/apps/app-public")) {
        result = {
          id: "app-public",
          type: "self_hosted",
          name: `Tiller public endpoints (${installationId})`,
          domain: `${hostname}/health`,
          destinations: [
            { type: "public", uri: `${hostname}/health` },
            { type: "public", uri: `${hostname}/api/github/webhook` },
          ],
          app_launcher_visible: false,
          session_duration: "24h",
        };
      } else if (path.endsWith("/access/apps/app-public/policies")) {
        result = [{ id: "policy-public", name: "Allow Tiller public endpoints", decision: "bypass", include: [{ everyone: {} }] }];
      } else {
        throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
      }
      return Response.json({
        success: true,
        result,
        ...(Array.isArray(result) ? { result_info: resultInfo } : {}),
      });
    });
  }

  it("allows only the service-token expiration to lag during refresh recovery", async () => {
    const actual = "2028-07-30T00:00:00.000Z";
    vi.stubGlobal("fetch", accessFetch(actual));
    await expect(validateManagedAccess({
      authorization: authorization(), accountId: "account-1", resources, ownerEmail: resources.ownerEmail,
    })).rejects.toThrow(/service token changed/);
    await expect(readManagedAccessExpiration({
      authorization: authorization(), accountId: "account-1", resources, ownerEmail: resources.ownerEmail,
    })).resolves.toBe(actual);
  });

  it("renews the exact service token in place without replacing its client ID", async () => {
    const refreshed = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
    const fetchMock = accessFetch(baseExpiration, refreshed);
    vi.stubGlobal("fetch", fetchMock);
    const mutate: AccessMutation = (operation) => operation();
    const result = await renewManagedAccess({
      authorization: authorization(),
      accountId: "account-1",
      resources,
      ownerEmail: resources.ownerEmail,
      mutate,
    });
    expect(result.accessServiceTokenId).toBe("token-1");
    expect(result.accessServiceClientId).toBe("service-client.access");
    expect(result.accessTokenExpiresAt).toBe(refreshed);
    expect(fetchMock.mock.calls.some(([input, init]) => (
      new URL(String(input)).pathname.endsWith("/token-1/refresh") && init?.method === "POST"
    ))).toBe(true);
  });
});
