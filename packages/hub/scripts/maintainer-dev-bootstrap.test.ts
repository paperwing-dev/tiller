import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareApiError } from "../../installer/src/cloudflare-api";
import {
  bootstrapMaintainerDev,
  type MaintainerDevCheckpoint,
  writeMaintainerDevCheckpoint,
} from "./maintainer-dev-bootstrap";
import {
  MAINTAINER_DEV_ACCOUNT_ID,
  MAINTAINER_DEV_ACCOUNT_SUBDOMAIN,
  MAINTAINER_DEV_HOSTNAME,
  MAINTAINER_DEV_WORKER_NAME,
} from "./maintainer-dev-profile.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});
async function checkpointPath() {
  const directory = await mkdtemp(path.join(tmpdir(), "tiller-dev-bootstrap-"));
  temporaryDirectories.push(directory);
  return path.join(directory, ".tiller-dev-bootstrap.json");
}

function accessResources(resources: MaintainerDevCheckpoint["resources"]) {
  return {
    ...resources,
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
  };
}

function readyCheckpoint(): MaintainerDevCheckpoint {
  return {
    schemaVersion: 1,
    state: "ready",
    accountId: MAINTAINER_DEV_ACCOUNT_ID,
    workerName: MAINTAINER_DEV_WORKER_NAME,
    placementRegion: "wnam",
    resources: accessResources({
      installationId: "a".repeat(26),
      ownerEmail: "owner@example.com",
      workersDevHostname: MAINTAINER_DEV_HOSTNAME,
      workerId: "dev-worker-id",
    }),
    serviceClientSecret: "service-secret",
  };
}

function dependencies(workers: Array<{ id: string; name: string }>) {
  return {
    verifyDeployTarget: vi.fn(async () => undefined),
    listAccounts: vi.fn(async () => [{ id: MAINTAINER_DEV_ACCOUNT_ID }]),
    getUser: vi.fn(async () => ({ email: "owner@example.com" })),
    getWorkersSubdomain: vi.fn(async () => ({ subdomain: MAINTAINER_DEV_ACCOUNT_SUBDOMAIN })),
    getAccessOrganization: vi.fn(async () => ({ auth_domain: "team.cloudflareaccess.com" })),
    listIdentityProviders: vi.fn(async () => [{
      id: "idp-1",
      type: "cloudflare",
      read_only: false,
      config: { restrict_to_account_members: true },
    }]),
    listWorkers: vi.fn(async () => workers),
    validateFreshAccessPreflight: vi.fn(async () => undefined),
    validateManagedAccess: vi.fn(async () => undefined),
    readManagedAccessExpiration: vi.fn(async ({ resources }) => resources.accessTokenExpiresAt),
    renewManagedAccess: vi.fn(async ({ resources }) => resources),
    provisionFreshAccessStep: vi.fn(),
    runSeedDeploy: vi.fn(async () => undefined),
    putServiceSecret: vi.fn(async () => undefined),
    runReadyDeploy: vi.fn(async () => undefined),
  };
}

describe("maintainer dev bootstrap", () => {
  it("refuses to adopt an existing dev Worker without its local checkpoint", async () => {
    const file = await checkpointPath();
    const deps = dependencies([{ id: "foreign-dev-id", name: MAINTAINER_DEV_WORKER_NAME }]);
    await expect(bootstrapMaintainerDev({
      checkpointPath: file,
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps)).rejects.toThrow(/refusing to adopt/);
    expect(deps.runSeedDeploy).not.toHaveBeenCalled();
    expect(deps.provisionFreshAccessStep).not.toHaveBeenCalled();
  });

  it("seeds a missing Worker, checkpoints the one-time secret, and finishes Access", async () => {
    const file = await checkpointPath();
    const workers = [{ id: "production-worker-id", name: "tiller" }];
    const deps = dependencies(workers);
    deps.runSeedDeploy.mockImplementation(async () => {
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ state: "seeding" });
      workers.push({ id: "dev-worker-id", name: MAINTAINER_DEV_WORKER_NAME });
    });
    let created = false;
    deps.provisionFreshAccessStep.mockImplementation(async (args) => {
      if (!created) {
        created = true;
        return args.mutate(async () => {
          expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
            state: "provisioning",
            accessMutationPending: true,
          });
          return {
            done: false,
            resources: accessResources(args.resources),
            serviceClientSecret: "one-time-secret",
          };
        });
      }
      return { done: true, resources: args.resources };
    });

    const result = await bootstrapMaintainerDev({
      checkpointPath: file,
      placementRegion: "wnam",
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps);

    expect(result).toMatchObject({
      state: "ready",
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      workerName: MAINTAINER_DEV_WORKER_NAME,
      placementRegion: "wnam",
      serviceClientSecret: "one-time-secret",
      resources: {
        installationId: expect.stringMatching(/^[a-z2-7]{26}$/),
        workerId: "dev-worker-id",
        workersDevHostname: MAINTAINER_DEV_HOSTNAME,
      },
    });
    expect(deps.validateFreshAccessPreflight).toHaveBeenCalledOnce();
    expect(deps.putServiceSecret).toHaveBeenCalledWith("one-time-secret", expect.any(Object));
    expect(deps.runReadyDeploy).toHaveBeenCalledWith(expect.any(Object), true);
    expect(deps.runSeedDeploy).toHaveBeenCalledWith(expect.not.objectContaining({
      TILLER_DEV_BOOTSTRAP_TOKEN: expect.anything(),
    }));
    expect(deps.putServiceSecret).toHaveBeenCalledWith(
      "one-time-secret",
      expect.not.objectContaining({ TILLER_DEV_BOOTSTRAP_TOKEN: expect.anything() }),
    );
    expect(deps.runReadyDeploy).toHaveBeenCalledWith(
      expect.not.objectContaining({ TILLER_DEV_BOOTSTRAP_TOKEN: expect.anything() }),
      true,
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = await readFile(file, "utf8");
    expect(stored).not.toContain("bootstrap-token");
  });

  it("rejects a bootstrap token with access to another account", async () => {
    const file = await checkpointPath();
    const deps = dependencies([]);
    deps.listAccounts.mockResolvedValue([
      { id: MAINTAINER_DEV_ACCOUNT_ID },
      { id: "another-account" },
    ]);
    await expect(bootstrapMaintainerDev({
      checkpointPath: file,
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "broad-token" },
    }, deps)).rejects.toThrow(/scoped only/);
    expect(deps.runSeedDeploy).not.toHaveBeenCalled();
  });

  it("refuses to change the checkpointed region on an existing installation", async () => {
    const file = await checkpointPath();
    await writeMaintainerDevCheckpoint(file, readyCheckpoint());
    const deps = dependencies([{ id: "dev-worker-id", name: MAINTAINER_DEV_WORKER_NAME }]);

    await expect(bootstrapMaintainerDev({
      checkpointPath: file,
      placementRegion: "enam",
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps)).rejects.toThrow(/destructive reset/);
    expect(deps.runReadyDeploy).not.toHaveBeenCalled();
  });

  it("fails closed when a fresh Access mutation has an ambiguous outcome", async () => {
    const file = await checkpointPath();
    const checkpoint = readyCheckpoint();
    await writeMaintainerDevCheckpoint(file, {
      ...checkpoint,
      state: "provisioning",
      serviceClientSecret: undefined,
    });
    const deps = dependencies([{ id: "dev-worker-id", name: MAINTAINER_DEV_WORKER_NAME }]);
    deps.provisionFreshAccessStep.mockImplementation(async (args) => args.mutate(async () => {
      throw new CloudflareApiError(503, { uncertain: true });
    }));

    await expect(bootstrapMaintainerDev({
      checkpointPath: file,
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps)).rejects.toMatchObject({ uncertain: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      state: "provisioning",
      accessMutationPending: true,
    });

    deps.provisionFreshAccessStep.mockClear();
    await expect(bootstrapMaintainerDev({
      checkpointPath: file,
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps)).rejects.toThrow(/manual cleanup is required/);
    expect(deps.provisionFreshAccessStep).not.toHaveBeenCalled();
  });

  it("renews an existing exact service token and redeploys its expiration", async () => {
    const file = await checkpointPath();
    await writeMaintainerDevCheckpoint(file, readyCheckpoint());
    const deps = dependencies([{ id: "dev-worker-id", name: MAINTAINER_DEV_WORKER_NAME }]);
    deps.renewManagedAccess.mockImplementation(async ({ resources }) => ({
      ...resources,
      accessTokenExpiresAt: "2028-08-02T00:00:00.000Z",
    }));

    const result = await bootstrapMaintainerDev({
      renew: true,
      checkpointPath: file,
      env: { TILLER_DEV_BOOTSTRAP_TOKEN: "bootstrap-token" },
    }, deps);

    expect(deps.renewManagedAccess).toHaveBeenCalledOnce();
    expect(result.resources.accessTokenExpiresAt).toBe("2028-08-02T00:00:00.000Z");
    expect(deps.runReadyDeploy).toHaveBeenCalledWith(expect.any(Object), false);
  });

});
