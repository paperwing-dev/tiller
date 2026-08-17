import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAINTAINER_DEV_ACCOUNT_ID,
  MAINTAINER_DEV_HOSTNAME,
  MAINTAINER_DEV_WORKER_NAME,
  maintainerDevRuntimeVars,
  normalizeMaintainerDevCheckpoint,
  probeMaintainerDevDeployment,
  readMaintainerDevCheckpoint,
  resolveMaintainerDevDeployment,
} from "./maintainer-dev-profile.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function readyCheckpoint() {
  return {
    schemaVersion: 1,
    state: "ready",
    accountId: MAINTAINER_DEV_ACCOUNT_ID,
    workerName: MAINTAINER_DEV_WORKER_NAME,
    placementRegion: "wnam",
    resources: {
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: MAINTAINER_DEV_HOSTNAME,
      workerId: "dev-worker-id",
      accessIdentityProviderId: "idp-1",
      accessServiceTokenId: "token-1",
      accessServiceClientId: "client.access",
      accessTokenExpiresAt: "2027-08-02T00:00:00.000Z",
      accessIssuer: "https://team.cloudflareaccess.com",
      accessApplicationId: "app-1",
      accessAudience: "audience-1",
      accessOwnerPolicyId: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
      accessServicePolicyId: "service-policy-1",
      accessPublicApplicationId: "public-app-1",
      accessPublicPolicyId: "public-policy-1",
    },
    serviceClientSecret: "service-secret",
  };
}

describe("fixed maintainer dev profile", () => {
  it("accepts only the exact account, Worker, and hostname", () => {
    expect(normalizeMaintainerDevCheckpoint(readyCheckpoint())).toMatchObject({
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      workerName: MAINTAINER_DEV_WORKER_NAME,
      resources: { workersDevHostname: MAINTAINER_DEV_HOSTNAME },
    });
    expect(() => normalizeMaintainerDevCheckpoint({
      ...readyCheckpoint(),
      workerName: "tiller",
    })).toThrow(/Worker name must be tiller-dev/);
    expect(() => normalizeMaintainerDevCheckpoint({
      ...readyCheckpoint(),
      accountId: "production-or-foreign-account",
    })).toThrow(/Cloudflare account ID/);
  });

  it("emits an isolated dev marker without serializing the service secret", () => {
    const vars = maintainerDevRuntimeVars(readyCheckpoint(), "b".repeat(40));
    expect(vars).toMatchObject({
      TILLER_MAINTAINER_DEV_SCHEMA: "1",
      TILLER_INSTALLER_SCHEMA: "",
      TILLER_RELEASE_ID: "b".repeat(40),
      TILLER_WORKERS_DEV_HOSTNAME: MAINTAINER_DEV_HOSTNAME,
      CF_ACCESS_SERVICE_CLIENT_ID: "client.access",
    });
    expect(vars).not.toHaveProperty("DO_LOCATION_HINT");
    expect(vars).not.toHaveProperty("CF_ACCESS_SERVICE_CLIENT_SECRET");
  });

  it("accepts only registry-backed placement regions", () => {
    expect(normalizeMaintainerDevCheckpoint(readyCheckpoint())).toMatchObject({
      placementRegion: "wnam",
    });
    expect(() => normalizeMaintainerDevCheckpoint({
      ...readyCheckpoint(),
      placementRegion: "texas",
    })).toThrow(/placement region is invalid/);
  });

  it("rejects target overrides before reading the checkpoint", () => {
    expect(() => resolveMaintainerDevDeployment({
      hubRoot: "/tmp/hub",
      workerName: "tiller",
      env: {
        TILLER_DEPLOY_PROFILE: "maintainer-dev",
        CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
      },
    })).toThrow(/must target Worker tiller-dev/);
    expect(() => resolveMaintainerDevDeployment({
      hubRoot: "/tmp/hub",
      workerName: MAINTAINER_DEV_WORKER_NAME,
      env: {
        TILLER_DEPLOY_PROFILE: "maintainer-dev",
        CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
        WRANGLER_CI_OVERRIDE_NAME: "tiller",
      },
    })).toThrow(/WRANGLER_CI_OVERRIDE_NAME/);
  });

  it("returns one checkpointed placement region for deploy materialization", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tiller-dev-profile-"));
    temporaryDirectories.push(directory);
    const checkpointPath = path.join(directory, ".tiller-dev-bootstrap.json");
    writeFileSync(checkpointPath, JSON.stringify(readyCheckpoint()), { mode: 0o600 });
    chmodSync(checkpointPath, 0o600);

    const deployment = resolveMaintainerDevDeployment({
      hubRoot: directory,
      workerName: MAINTAINER_DEV_WORKER_NAME,
      env: {
        TILLER_DEPLOY_PROFILE: "maintainer-dev",
        TILLER_DEV_CHECKPOINT_PATH: checkpointPath,
        TILLER_DEV_RELEASE_ID: "b".repeat(40),
        CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
      },
    });

    expect(deployment).toMatchObject({
      kind: "ready",
      placementRegion: "wnam",
    });
    expect(deployment).not.toHaveProperty("placement");
    expect(deployment.runtimeVars).not.toHaveProperty("DO_LOCATION_HINT");
  });

  it("rejects a secret-bearing checkpoint unless its mode is exactly 0600", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tiller-dev-profile-"));
    temporaryDirectories.push(directory);
    const checkpointPath = path.join(directory, ".tiller-dev-bootstrap.json");
    writeFileSync(checkpointPath, JSON.stringify(readyCheckpoint()), { mode: 0o600 });
    chmodSync(checkpointPath, 0o600);
    expect(readMaintainerDevCheckpoint(checkpointPath, { requireReady: true }))
      .toMatchObject({ state: "ready" });

    chmodSync(checkpointPath, 0o644);
    expect(() => readMaintainerDevCheckpoint(checkpointPath, { requireReady: true }))
      .toThrow(/mode 0600/);
  });
});

describe("maintainer dev deployment probes", () => {
  it("proves health, Access rejection, and service-token release identity", async () => {
    const checkpoint = readyCheckpoint();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ok: true, releaseId: "b".repeat(40) }));

    await probeMaintainerDevDeployment({
      kind: "ready",
      checkpoint,
      runtimeVars: maintainerDevRuntimeVars(checkpoint, "b".repeat(40)),
    }, { fetchImpl, attempts: 1 });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      `https://${MAINTAINER_DEV_HOSTNAME}/api/installer/probe`,
      expect.objectContaining({
        headers: {
          "CF-Access-Client-Id": "client.access",
          "CF-Access-Client-Secret": "service-secret",
        },
      }),
    );
  });

  it("requires an untrusted seed to fail closed", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(probeMaintainerDevDeployment(
      { kind: "seed", checkpoint: null, runtimeVars: {} },
      { fetchImpl, attempts: 1 },
    )).rejects.toThrow(/unexpectedly accepted/);
  });

  it("bounds every live probe request", async () => {
    const fetchImpl = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    await expect(probeMaintainerDevDeployment(
      {
        kind: "ready",
        checkpoint: readyCheckpoint(),
        runtimeVars: maintainerDevRuntimeVars(readyCheckpoint(), "b".repeat(40)),
      },
      { fetchImpl, attempts: 1, requestTimeoutMs: 5 },
    )).rejects.toThrow(/timed out/);
  });

  it("bounds a live probe body that never finishes", async () => {
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
      },
    })));

    await expect(probeMaintainerDevDeployment(
      {
        kind: "ready",
        checkpoint: readyCheckpoint(),
        runtimeVars: maintainerDevRuntimeVars(readyCheckpoint(), "b".repeat(40)),
      },
      { fetchImpl, attempts: 1, requestTimeoutMs: 5 },
    )).rejects.toThrow(/timed out/);
  });

  it("rejects oversized live-probe responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true,
      padding: "x".repeat(128),
    }));

    await expect(probeMaintainerDevDeployment(
      {
        kind: "ready",
        checkpoint: readyCheckpoint(),
        runtimeVars: maintainerDevRuntimeVars(readyCheckpoint(), "b".repeat(40)),
      },
      { fetchImpl, attempts: 1, maxResponseBytes: 16 },
    )).rejects.toThrow(/exceeded 16 bytes/);
  });
});
