import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productionReleaseDescriptorFixture } from "./release-fixture";
import { InstallJobDO } from "./job-do";
import { REQUIRED_CLOUDFLARE_OAUTH_SCOPES } from "./oauth";
import type { Env, InstallJobRecordV1 } from "./types";

const stableDescriptor = productionReleaseDescriptorFixture();

const RECORD_KEY = "lifecycle-session:v1";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SESSION = "browser-session";
const CONTAINER_PROGRESS_DETAIL = `Creating Containers (2 of ${stableDescriptor.containers.length})`;

function durableState() {
  const values = new Map<string, unknown>();
  const setAlarm = vi.fn(async (_value?: number | Date) => undefined);
  const deleteAlarm = vi.fn(async () => undefined);
  const storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    setAlarm,
    deleteAlarm,
    transaction: async <T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> => {
      const snapshot = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
      const transaction = {
        get: async <Value>(key: string) => structuredClone(snapshot.get(key)) as Value | undefined,
        put: async (key: string, value: unknown) => { snapshot.set(key, structuredClone(value)); },
        delete: async (key: string) => snapshot.delete(key),
        setAlarm: async () => undefined,
        deleteAlarm: async () => undefined,
        rollback: () => undefined,
        getAlarm: async () => null,
      } as unknown as DurableObjectTransaction;
      const result = await closure(transaction);
      values.clear();
      for (const [key, value] of snapshot) values.set(key, structuredClone(value));
      return result;
    },
  };
  return { state: { storage } as unknown as DurableObjectState, values, setAlarm, deleteAlarm };
}

type StubFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function bindings(accountFetch = vi.fn<StubFetch>(async () => Response.json({
  operationId: "operation-1",
  authorizationAccepted: true,
}))) {
  const env = {
    CLOUDFLARE_OAUTH_CLIENT_ID: "client-id",
    CLOUDFLARE_OAUTH_CLIENT_SECRET: "client-secret",
    OAUTH_REDIRECT_URI: "https://install.paperwing.dev/oauth/callback",
    INSTALLER_TOKEN_ENCRYPTION_KEY_V1: KEY,
    ACCOUNT_LIFECYCLE: {
      idFromName: vi.fn(() => "account-do-id"),
      get: vi.fn(() => ({ fetch: accountFetch })),
    },
  } as unknown as Env;
  return { env, accountFetch };
}

async function createJob(
  job: InstallJobDO,
  intent: "install" | "update" | "renew" = "install",
  placementRegion: "wnam" | null | undefined = intent === "install" ? "wnam" : undefined,
) {
  return job.fetch(new Request("https://install-job.internal/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tiller-Browser-Session": SESSION },
    body: JSON.stringify({
      jobId: "job-1",
      intent,
      descriptor: stableDescriptor,
      ...(placementRegion ? { placementRegion } : {}),
    }),
  }));
}

function callback(job: InstallJobDO, state: string, session = SESSION) {
  return job.fetch(new Request("https://install-job.internal/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Tiller-Browser-Session": session },
    body: JSON.stringify({ state, code: "authorization-code" }),
  }));
}

function oauthAndAccountFetch(accountIds = ["account-1"]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "dash.cloudflare.com" && url.pathname === "/oauth2/token") {
      return Response.json({
        access_token: "oauth-token",
        scope: REQUIRED_CLOUDFLARE_OAUTH_SCOPES.join(" "),
      });
    }
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/accounts")) {
      return Response.json({
        success: true,
        result: accountIds.map((id) => ({ id })),
        result_info: { page: 1, total_pages: 1 },
      });
    }
    if (url.hostname === "dash.cloudflare.com" && url.pathname === "/oauth2/revoke") {
      return new Response("", { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-07-30T00:00:00.000Z");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("short-lived OAuth session Durable Object", () => {
  it("requires a valid region for install jobs and rejects one for maintenance", async () => {
    const { env } = bindings();
    expect((await createJob(new InstallJobDO(durableState().state, env), "install", null)).status)
      .toBe(400);
    expect((await createJob(new InstallJobDO(durableState().state, env), "update", "wnam")).status)
      .toBe(400);
  });

  it("creates only browser-bound PKCE state and performs no customer mutation", async () => {
    const memory = durableState();
    const { env } = bindings();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await createJob(new InstallJobDO(memory.state, env), "update");
    const stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    const authorization = new URL((await response.json<{ authorizationUrl: string }>()).authorizationUrl);
    expect(response.status).toBe(200);
    expect(stored.intent).toBe("update");
    expect(stored.step).toBe("authorize");
    expect(stored.oauthAttempt?.state).toMatch(/^job-1\.[A-Za-z0-9_-]+$/);
    expect(stored.oauthAttempt?.verifier).not.toBe(authorization.searchParams.get("code_challenge"));
    expect(Date.parse(stored.expiresAt) - Date.now()).toBe(30 * 60 * 1_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes OAuth state once, proves exactly one account, and hands authorization to its account DO", async () => {
    const memory = durableState();
    const { env, accountFetch } = bindings();
    const job = new InstallJobDO(memory.state, env);
    await createJob(job, "renew");
    const state = (memory.values.get(RECORD_KEY) as InstallJobRecordV1).oauthAttempt!.state;
    vi.stubGlobal("fetch", oauthAndAccountFetch());
    const callbackResponse = await callback(job, state);
    expect(callbackResponse.status).toBe(200);
    await expect(callbackResponse.json()).resolves.toEqual({ accepted: true, intent: "renew" });
    expect((memory.values.get(RECORD_KEY) as InstallJobRecordV1).step).toBe("attach");
    expect((await callback(job, state)).status).toBe(409);
    expect((await callback(job, state, "different-session")).status).toBe(400);

    await job.alarm();
    const stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    expect(stored.step).toBe("attached");
    expect(stored.operationId).toBe("operation-1");
    expect(stored.encryptedToken).toBeUndefined();
    const init = accountFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      accountId: "account-1",
      authorizationId: "job-1",
      intent: "renew",
      accessToken: "oauth-token",
    });
  });

  it("persists the selected region through OAuth and the account handoff", async () => {
    const memory = durableState();
    const { env, accountFetch } = bindings();
    const job = new InstallJobDO(memory.state, env);
    await createJob(job, "install", "wnam");
    let stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    expect(stored.placementRegion).toBe("wnam");
    vi.stubGlobal("fetch", oauthAndAccountFetch());
    await callback(job, stored.oauthAttempt!.state);
    await job.alarm();
    stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    expect(stored.placementRegion).toBe("wnam");
    const init = accountFetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ placementRegion: "wnam" });
  });

  it("revokes a redundant browser grant and observes the existing account operation", async () => {
    const accountFetch = vi.fn<StubFetch>(async () => Response.json({
      operationId: "operation-existing",
      authorizationAccepted: false,
    }));
    const memory = durableState();
    const { env } = bindings(accountFetch);
    const job = new InstallJobDO(memory.state, env);
    await createJob(job, "update");
    const state = (memory.values.get(RECORD_KEY) as InstallJobRecordV1).oauthAttempt!.state;
    const fetchMock = oauthAndAccountFetch();
    vi.stubGlobal("fetch", fetchMock);
    await callback(job, state);

    await job.alarm();

    const stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    expect(stored).toMatchObject({ step: "attached", operationId: "operation-existing" });
    expect(stored.encryptedToken).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname === "/oauth2/revoke"
    ))).toHaveLength(1);
  });

  it("rejects a multi-account grant before the account mutation owner is selected", async () => {
    const memory = durableState();
    const { env, accountFetch } = bindings();
    const job = new InstallJobDO(memory.state, env);
    await createJob(job);
    const state = (memory.values.get(RECORD_KEY) as InstallJobRecordV1).oauthAttempt!.state;
    vi.stubGlobal("fetch", oauthAndAccountFetch(["account-1", "account-2"]));
    expect((await callback(job, state)).status).toBe(200);
    expect((memory.values.get(RECORD_KEY) as InstallJobRecordV1).projection)
      .toEqual({
        stage: "action-required",
        issue: "single-account-required",
        nextAction: { kind: "reauthorize", url: "/deploy" },
      });
    expect(accountFetch).not.toHaveBeenCalled();
  });

  it("proxies only the projection for the attached operation", async () => {
    const accountFetch = vi.fn<StubFetch>(async () => Response.json({
      stage: "deploy-tiller",
      detail: CONTAINER_PROGRESS_DETAIL,
      intent: "update",
    }));
    const memory = durableState();
    const { env } = bindings(accountFetch);
    const job = new InstallJobDO(memory.state, env);
    await createJob(job);
    const stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    stored.step = "attached";
    stored.accountId = "account-1";
    stored.operationId = "operation-1";
    await memory.state.storage.put(RECORD_KEY, stored);
    const response = await job.fetch(new Request("https://install-job.internal/status", {
      headers: { "X-Tiller-Browser-Session": SESSION },
    }));
    await expect(response.json()).resolves.toEqual({
      stage: "deploy-tiller",
      detail: CONTAINER_PROGRESS_DETAIL,
      intent: "update",
    });
    expect(String(accountFetch.mock.calls[0]?.[0])).toContain("operationId=operation-1");
  });

  it("revokes an unattached grant before its encryption envelope expires", async () => {
    const accountFetch = vi.fn<StubFetch>(async () => Response.json({ error: "busy" }, { status: 409 }));
    const memory = durableState();
    const { env } = bindings(accountFetch);
    const job = new InstallJobDO(memory.state, env);
    await createJob(job);
    const state = (memory.values.get(RECORD_KEY) as InstallJobRecordV1).oauthAttempt!.state;
    const fetchMock = oauthAndAccountFetch();
    vi.stubGlobal("fetch", fetchMock);
    await callback(job, state);

    const stored = memory.values.get(RECORD_KEY) as InstallJobRecordV1;
    vi.setSystemTime(Date.parse(stored.expiresAt) - 60_000);
    await job.alarm();

    expect(memory.values.has(RECORD_KEY)).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = new URL(String(input));
      return url.hostname === "dash.cloudflare.com" && url.pathname === "/oauth2/revoke";
    })).toBe(true);
  });

  it("deletes the browser session without deleting the account operation", async () => {
    const memory = durableState();
    const { env, accountFetch } = bindings();
    const job = new InstallJobDO(memory.state, env);
    await createJob(job);
    vi.advanceTimersByTime(30 * 60 * 1_000);
    await job.alarm();
    expect(memory.values.has(RECORD_KEY)).toBe(false);
    expect(memory.deleteAlarm).toHaveBeenCalledOnce();
    expect(accountFetch).not.toHaveBeenCalled();
  });
});
