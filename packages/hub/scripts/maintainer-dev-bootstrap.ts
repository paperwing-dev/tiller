#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  CloudflareApiError,
  getAccessOrganization,
  getUser,
  getWorkersSubdomain,
  listAccounts,
  listIdentityProviders,
  listWorkers,
  type CloudflareAuthorization,
} from "../../installer/src/cloudflare-api";
import {
  provisionFreshAccessStep,
  readManagedAccessExpiration,
  renewManagedAccess,
  validateFreshAccessPreflight,
  validateManagedAccess,
} from "../../installer/src/access";
import { randomInstallationId } from "../../installer/src/crypto";
import type { InstallationResourcesV1 } from "../../installer/src/types";
import { readDeployRecordFile } from "../../../scripts/deploy-record.mjs";
import { isPlacementRegion, type PlacementRegion } from "../shared/placement";
import {
  defaultMaintainerDevCheckpointPath,
  MAINTAINER_DEV_ACCOUNT_ID,
  MAINTAINER_DEV_ACCOUNT_SUBDOMAIN,
  MAINTAINER_DEV_HOSTNAME,
  MAINTAINER_DEV_PROFILE_NAME,
  MAINTAINER_DEV_WORKER_NAME,
  normalizeMaintainerDevCheckpoint,
} from "./maintainer-dev-profile.mjs";
import { verifyMaintainerDevTarget } from "./verify-maintainer-dev-target.mjs";

type CheckpointState = "seeding" | "provisioning" | "ready";

export interface MaintainerDevCheckpoint {
  schemaVersion: 1;
  state: CheckpointState;
  accountId: string;
  workerName: string;
  placementRegion?: PlacementRegion;
  resources: InstallationResourcesV1;
  serviceClientSecret?: string;
  accessMutationPending?: true;
}
interface BootstrapInspection {
  ownerEmail: string;
  workers: Array<{ id?: string | null; name?: string | null }>;
}

interface BootstrapDependencies {
  getUser: typeof getUser;
  listAccounts: typeof listAccounts;
  getWorkersSubdomain: typeof getWorkersSubdomain;
  getAccessOrganization: typeof getAccessOrganization;
  listIdentityProviders: typeof listIdentityProviders;
  listWorkers: typeof listWorkers;
  validateFreshAccessPreflight: typeof validateFreshAccessPreflight;
  provisionFreshAccessStep: typeof provisionFreshAccessStep;
  validateManagedAccess: typeof validateManagedAccess;
  readManagedAccessExpiration: typeof readManagedAccessExpiration;
  renewManagedAccess: typeof renewManagedAccess;
  verifyDeployTarget: (env: NodeJS.ProcessEnv) => Promise<void>;
  runSeedDeploy: (env: NodeJS.ProcessEnv) => Promise<void>;
  putServiceSecret: (secret: string, env: NodeJS.ProcessEnv) => Promise<void>;
  runReadyDeploy: (env: NodeJS.ProcessEnv, seededThisRun: boolean) => Promise<void>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ACCESS_STEPS = 24;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const HUB_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(HUB_ROOT, "..", "..");
const DEPLOY_RECORD_PATH = path.join(REPO_ROOT, ".update-self-host-deploy-record.json");

function commandName(name: "npm" | "npx") {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runCommand(
  command: string,
  args: string[],
  { cwd, env, input }: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

function fixedDeployEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
    TILLER_WORKER_NAME: MAINTAINER_DEV_WORKER_NAME,
    TILLER_DEPLOY_PROFILE: MAINTAINER_DEV_PROFILE_NAME,
    TILLER_DEV_CHECKPOINT_PATH: env.TILLER_DEV_CHECKPOINT_PATH?.trim()
      || defaultMaintainerDevCheckpointPath(HUB_ROOT),
  };
  delete next.WRANGLER_CI_OVERRIDE_NAME;
  delete next.TILLER_DEV_BOOTSTRAP_TOKEN;
  delete next.TILLER_DEV_ALLOW_UNTRUSTED_SEED;
  return next;
}

const defaultDependencies: BootstrapDependencies = {
  getUser,
  listAccounts,
  getWorkersSubdomain,
  getAccessOrganization,
  listIdentityProviders,
  listWorkers,
  validateFreshAccessPreflight,
  provisionFreshAccessStep,
  validateManagedAccess,
  readManagedAccessExpiration,
  renewManagedAccess,
  verifyDeployTarget: async (env) => {
    await verifyMaintainerDevTarget({ env, hubRoot: HUB_ROOT });
  },
  runSeedDeploy: async (env) => {
    await runCommand(commandName("npm"), ["run", "deploy:dev", "--", "--full"], {
      cwd: REPO_ROOT,
      env: { ...env, TILLER_DEV_ALLOW_UNTRUSTED_SEED: "1" },
    });
  },
  putServiceSecret: async (secret, env) => {
    await runCommand(
      commandName("npx"),
      [
        "wrangler",
        "secret",
        "put",
        "CF_ACCESS_SERVICE_CLIENT_SECRET",
        "--name",
        MAINTAINER_DEV_WORKER_NAME,
        "--config",
        "wrangler.jsonc",
      ],
      { cwd: HUB_ROOT, env, input: `${secret}\n` },
    );
  },
  runReadyDeploy: async (env, seededThisRun) => {
    if (!seededThisRun) {
      await runCommand(commandName("npm"), ["run", "deploy:dev", "--", "--full"], {
        cwd: REPO_ROOT,
        env,
      });
      return;
    }
    const record = readDeployRecordFile(DEPLOY_RECORD_PATH);
    await runCommand(process.execPath, ["scripts/deploy-with-region.mjs"], {
      cwd: HUB_ROOT,
      env: {
        ...env,
        TILLER_DEV_RELEASE_ID: record.hubCommitSha,
        CONTAINER_IMAGE_TAG: record.sandboxImage,
        GITHUB_JOB_IMAGE_TAG: record.scmImage,
      },
    });
  },
};

function authorization(token: string): CloudflareAuthorization {
  return { accessToken: token, deadline: Date.now() + 15 * 60 * 1_000 };
}

function restrictedAccountIdentityProvider(value: {
  type?: string | null;
  read_only?: boolean | null;
  config?: { restrict_to_account_members?: boolean | null } | null;
}): boolean {
  return value.type === "cloudflare"
    && value.read_only !== true
    && value.config?.restrict_to_account_members === true;
}

async function inspectBootstrapAccount(
  auth: CloudflareAuthorization,
  dependencies: BootstrapDependencies,
): Promise<BootstrapInspection> {
  const [accounts, user, workersDev, organization, identityProviders, workers] = await Promise.all([
    dependencies.listAccounts(auth),
    dependencies.getUser(auth),
    dependencies.getWorkersSubdomain(auth, MAINTAINER_DEV_ACCOUNT_ID),
    dependencies.getAccessOrganization(auth, MAINTAINER_DEV_ACCOUNT_ID),
    dependencies.listIdentityProviders(auth, MAINTAINER_DEV_ACCOUNT_ID),
    dependencies.listWorkers(auth, MAINTAINER_DEV_ACCOUNT_ID),
  ]);
  const accountIds = accounts.map((account) => account.id?.trim()).filter(Boolean);
  if (accountIds.length !== 1 || accountIds[0] !== MAINTAINER_DEV_ACCOUNT_ID) {
    throw new Error(
      `TILLER_DEV_BOOTSTRAP_TOKEN must be scoped only to Cloudflare account ${MAINTAINER_DEV_ACCOUNT_ID}.`,
    );
  }
  const ownerEmail = user.email?.trim().toLowerCase() ?? "";
  if (!EMAIL.test(ownerEmail)) throw new Error("Cloudflare did not return a valid bootstrap-token owner email.");
  if (workersDev.subdomain?.trim().toLowerCase() !== MAINTAINER_DEV_ACCOUNT_SUBDOMAIN) {
    throw new Error(`Cloudflare workers.dev subdomain must be ${MAINTAINER_DEV_ACCOUNT_SUBDOMAIN}.`);
  }
  if (!organization?.auth_domain?.trim()) {
    throw new Error("The existing Cloudflare Zero Trust organization is required; bootstrap will not create it.");
  }
  const eligibleProviders = identityProviders.filter(restrictedAccountIdentityProvider);
  if (eligibleProviders.length !== 1) {
    throw new Error("Exactly one existing account-member Cloudflare identity provider is required.");
  }
  return { ownerEmail, workers };
}

async function readCheckpointOptional(checkpointPath: string): Promise<MaintainerDevCheckpoint | null> {
  try {
    const [content, fileStat] = await Promise.all([readFile(checkpointPath, "utf8"), stat(checkpointPath)]);
    if ((fileStat.mode & 0o777) !== 0o600) await chmod(checkpointPath, 0o600);
    return normalizeMaintainerDevCheckpoint(JSON.parse(content)) as MaintainerDevCheckpoint;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeMaintainerDevCheckpoint(
  checkpointPath: string,
  checkpoint: MaintainerDevCheckpoint,
): Promise<MaintainerDevCheckpoint> {
  const normalized = normalizeMaintainerDevCheckpoint(checkpoint) as MaintainerDevCheckpoint;
  const tempPath = `${checkpointPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, checkpointPath);
    await chmod(checkpointPath, 0o600);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
  return normalized;
}

function exactWorker(
  workers: BootstrapInspection["workers"],
  name: string,
): { id: string; name: string } | null {
  const matches = workers.filter((worker) => worker.name?.trim() === name);
  if (matches.length > 1) throw new Error(`Cloudflare returned multiple Workers named ${name}.`);
  if (matches.length === 0) return null;
  const id = matches[0].id?.trim() ?? "";
  if (!id) throw new Error(`Cloudflare did not return the ${name} Worker ID.`);
  return { id, name };
}

async function provisionAccess(
  checkpointPath: string,
  checkpoint: MaintainerDevCheckpoint,
  auth: CloudflareAuthorization,
  dependencies: BootstrapDependencies,
): Promise<MaintainerDevCheckpoint> {
  let current = checkpoint;
  for (let step = 0; step < MAX_ACCESS_STEPS; step += 1) {
    let checkpointedMutation: MaintainerDevCheckpoint | null = null;
    const result = await dependencies.provisionFreshAccessStep({
      authorization: auth,
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      resources: current.resources,
      mutate: async (operation) => {
        current = await writeMaintainerDevCheckpoint(checkpointPath, {
          ...current,
          state: "provisioning",
          accessMutationPending: true,
        });
        let value: Awaited<ReturnType<typeof operation>>;
        try {
          value = await operation();
        } catch (error) {
          if (error instanceof CloudflareApiError && !error.uncertain) {
            current = await writeMaintainerDevCheckpoint(checkpointPath, {
              ...current,
              accessMutationPending: undefined,
            });
          }
          throw error;
        }
        checkpointedMutation = await writeMaintainerDevCheckpoint(checkpointPath, {
          ...current,
          state: "provisioning",
          resources: value.resources,
          serviceClientSecret: value.serviceClientSecret ?? current.serviceClientSecret,
          accessMutationPending: undefined,
        });
        return value;
      },
    });
    current = checkpointedMutation ?? await writeMaintainerDevCheckpoint(checkpointPath, {
      ...current,
      state: "provisioning",
      resources: result.resources,
      serviceClientSecret: result.serviceClientSecret ?? current.serviceClientSecret,
    });
    if (result.done) return current;
  }
  throw new Error("Cloudflare Access bootstrap exceeded its bounded step count.");
}

async function renewAccess(
  checkpointPath: string,
  checkpoint: MaintainerDevCheckpoint,
  auth: CloudflareAuthorization,
  dependencies: BootstrapDependencies,
): Promise<MaintainerDevCheckpoint> {
  const actualExpiration = await dependencies.readManagedAccessExpiration({
    authorization: auth,
    accountId: MAINTAINER_DEV_ACCOUNT_ID,
    resources: checkpoint.resources,
    ownerEmail: checkpoint.resources.ownerEmail,
  });
  if (actualExpiration !== checkpoint.resources.accessTokenExpiresAt) {
    return writeMaintainerDevCheckpoint(checkpointPath, {
      ...checkpoint,
      resources: { ...checkpoint.resources, accessTokenExpiresAt: actualExpiration },
    });
  }

  try {
    const resources = await dependencies.renewManagedAccess({
      authorization: auth,
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      resources: checkpoint.resources,
      ownerEmail: checkpoint.resources.ownerEmail,
      mutate: (operation) => operation(),
    });
    return writeMaintainerDevCheckpoint(checkpointPath, { ...checkpoint, resources });
  } catch (error) {
    const recoveredExpiration = await dependencies.readManagedAccessExpiration({
      authorization: authorization(auth.accessToken),
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      resources: checkpoint.resources,
      ownerEmail: checkpoint.resources.ownerEmail,
    }).catch(() => checkpoint.resources.accessTokenExpiresAt ?? "");
    if (recoveredExpiration && recoveredExpiration !== checkpoint.resources.accessTokenExpiresAt) {
      return writeMaintainerDevCheckpoint(checkpointPath, {
        ...checkpoint,
        resources: { ...checkpoint.resources, accessTokenExpiresAt: recoveredExpiration },
      });
    }
    throw error;
  }
}

export async function bootstrapMaintainerDev(
  {
    renew = false,
    placementRegion,
    env = process.env,
    checkpointPath = defaultMaintainerDevCheckpointPath(HUB_ROOT),
  }: {
    renew?: boolean;
    placementRegion?: PlacementRegion;
    env?: NodeJS.ProcessEnv;
    checkpointPath?: string;
  } = {},
  dependencyOverrides: Partial<BootstrapDependencies> = {},
): Promise<MaintainerDevCheckpoint> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const token = env.TILLER_DEV_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (!token) throw new Error("Set TILLER_DEV_BOOTSTRAP_TOKEN before running bootstrap:dev.");
  if (env.WRANGLER_CI_OVERRIDE_NAME?.trim()) {
    throw new Error("WRANGLER_CI_OVERRIDE_NAME is not allowed during maintainer dev bootstrap.");
  }

  const deployEnv = fixedDeployEnvironment({ ...env, TILLER_DEV_CHECKPOINT_PATH: checkpointPath });
  await dependencies.verifyDeployTarget(deployEnv);
  let auth = authorization(token);
  let inspection = await inspectBootstrapAccount(auth, dependencies);
  let checkpoint = await readCheckpointOptional(checkpointPath);
  if (checkpoint?.accessMutationPending) {
    throw new Error(
      "A Cloudflare Access creation may have committed without a complete checkpoint; manual cleanup is required before bootstrap can continue.",
    );
  }
  const devWorkerBefore = exactWorker(inspection.workers, MAINTAINER_DEV_WORKER_NAME);
  const productionWorker = exactWorker(inspection.workers, "tiller");
  if (devWorkerBefore && productionWorker && devWorkerBefore.id === productionWorker.id) {
    throw new Error("Cloudflare returned the production Worker as the dev Worker; refusing to continue.");
  }
  if (!checkpoint && devWorkerBefore) {
    throw new Error(
      `Worker ${MAINTAINER_DEV_WORKER_NAME} already exists without the local checkpoint; refusing to adopt it.`,
    );
  }
  if (checkpoint && checkpoint.resources.ownerEmail !== inspection.ownerEmail) {
    throw new Error("The bootstrap-token owner differs from the checkpoint owner.");
  }
  if (checkpoint && placementRegion !== undefined && checkpoint.placementRegion !== placementRegion) {
    throw new Error(
      "The maintainer dev region can be chosen only during fresh bootstrap; changing it requires the documented destructive reset.",
    );
  }

  if (!checkpoint) {
    await dependencies.validateFreshAccessPreflight({
      authorization: auth,
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      workersDevHostname: MAINTAINER_DEV_HOSTNAME,
    });
    checkpoint = await writeMaintainerDevCheckpoint(checkpointPath, {
      schemaVersion: 1,
      state: "seeding",
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      workerName: MAINTAINER_DEV_WORKER_NAME,
      placementRegion,
      resources: {
        installationId: randomInstallationId(),
        ownerEmail: inspection.ownerEmail,
        workersDevHostname: MAINTAINER_DEV_HOSTNAME,
      },
    });
  }

  let seededThisRun = false;
  let devWorker = devWorkerBefore;
  if (!devWorker) {
    if (checkpoint.state !== "seeding") {
      throw new Error("The checkpoint names a missing dev Worker; refusing to recreate it implicitly.");
    }
    await dependencies.runSeedDeploy(deployEnv);
    seededThisRun = true;
    auth = authorization(token);
    inspection = await inspectBootstrapAccount(auth, dependencies);
    devWorker = exactWorker(inspection.workers, MAINTAINER_DEV_WORKER_NAME);
    if (!devWorker) throw new Error("The seed deploy did not create the fixed dev Worker.");
  }

  if (checkpoint.resources.workerId && checkpoint.resources.workerId !== devWorker.id) {
    throw new Error("The checkpoint Worker ID differs from Cloudflare; refusing to adopt the replacement.");
  }
  if (checkpoint.state === "seeding") {
    checkpoint = await writeMaintainerDevCheckpoint(checkpointPath, {
      ...checkpoint,
      state: "provisioning",
      resources: { ...checkpoint.resources, workerId: devWorker.id },
    });
  }

  const wasReady = checkpoint.state === "ready";
  if (!wasReady) {
    checkpoint = await provisionAccess(checkpointPath, checkpoint, auth, dependencies);
    if (!checkpoint.serviceClientSecret) {
      throw new Error("Cloudflare did not return the one-time Access service client secret.");
    }
    await dependencies.validateManagedAccess({
      authorization: auth,
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      resources: checkpoint.resources,
      ownerEmail: checkpoint.resources.ownerEmail,
    });
    checkpoint = await writeMaintainerDevCheckpoint(checkpointPath, { ...checkpoint, state: "ready" });
  } else if (renew) {
    checkpoint = await renewAccess(checkpointPath, checkpoint, auth, dependencies);
  } else {
    await dependencies.validateManagedAccess({
      authorization: auth,
      accountId: MAINTAINER_DEV_ACCOUNT_ID,
      resources: checkpoint.resources,
      ownerEmail: checkpoint.resources.ownerEmail,
    });
  }

  await dependencies.putServiceSecret(checkpoint.serviceClientSecret!, deployEnv);
  await dependencies.runReadyDeploy(deployEnv, seededThisRun);
  return normalizeMaintainerDevCheckpoint(checkpoint, { requireReady: true }) as MaintainerDevCheckpoint;
}

function parseArgs(argv: string[]): { renew: boolean; placementRegion?: PlacementRegion } {
  let renew = false;
  let placementRegion: PlacementRegion | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--renew" && !renew) {
      renew = true;
      continue;
    }
    if (argument === "--region" && placementRegion === undefined) {
      const candidate = argv[index + 1];
      if (!isPlacementRegion(candidate)) {
        throw new Error("--region must name a supported placement region.");
      }
      placementRegion = candidate;
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run bootstrap:dev -- [--renew] [--region <region>]");
  }
  return { renew, placementRegion };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(async () => {
    const options = parseArgs(process.argv.slice(2));
    const checkpoint = await bootstrapMaintainerDev(options);
    console.log(`Maintainer dev Access is ready for ${checkpoint.resources.ownerEmail}.`);
    console.log(`Dev Hub: https://${MAINTAINER_DEV_HOSTNAME}`);
  }).catch((error) => {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
