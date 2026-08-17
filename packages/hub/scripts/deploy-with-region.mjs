import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  probeMaintainerDevDeployment,
  resolveMaintainerDevDeployment,
} from "./maintainer-dev-profile.mjs";
import { placementRegionDefinition } from "../shared/placement.ts";

const ROOT_WRANGLER_CONFIG = "wrangler.jsonc";
const GENERATED_DEPLOY_CONFIG = path.join(".wrangler", "deploy", "config.json");
const TEMP_DEPLOY_CONFIG_NAME = "wrangler.deploy.generated.json";
const TILLER_WORKER_NAME_VAR = "TILLER_WORKER_NAME";
const WRANGLER_CI_OVERRIDE_NAME_VAR = "WRANGLER_CI_OVERRIDE_NAME";
const R2_BUCKET_BINDING = "BUCKET";
const CLOUDFLARE_API_TOKEN_ENV = "CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const HUB_PUBLIC_URL_VAR = "HUB_PUBLIC_URL";
const WORKER_SERVICE_NAME_VAR = "WORKER_SERVICE_NAME";
const RETIRED_WORKERS_DEV_ALIAS_DISABLED_VAR = "WORKERS_DEV_ALIAS_DISABLED";
const DOTENV_FILE = ".env";
const CONTAINER_IMAGE_TAG_ENV = "CONTAINER_IMAGE_TAG";
const GITHUB_JOB_IMAGE_TAG_ENV = "GITHUB_JOB_IMAGE_TAG";
const CONTAINER_ROLLOUT_TIMEOUT_MS = 15 * 60 * 1_000;
const CONTAINER_ROLLOUT_POLL_INTERVAL_MS = 5_000;
const CONTAINER_ROLLOUT_READY_CONFIRMATIONS = 2;
const READY_CONTAINER_APPLICATION_STATES = new Set(["active", "ready"]);
const FAILED_CONTAINER_APPLICATION_STATES = new Set(["error", "failed"]);

class CommandError extends Error {
  constructor(message, { code, stderr, stdout } = {}) {
    super(message);
    this.name = "CommandError";
    this.code = code;
    this.stderr = stderr ?? "";
    this.stdout = stdout ?? "";
  }
}

export function parseJsonc(content, filePath) {
  const errors = [];
  const value = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ");
    throw new Error(`Failed to parse ${filePath}: ${details}`);
  }

  return value;
}

export function parseWranglerJsonOutput(content, filePath) {
  const trimmed = content.trim();
  const candidateStarts = [];
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "{" || char === "[") {
      candidateStarts.push(index);
    }
  }

  for (const start of candidateStarts) {
    try {
      return parseJsonc(trimmed.slice(start), filePath);
    } catch {
      // Wrangler may print non-JSON notices before the requested JSON payload.
    }
  }

  return parseJsonc(content, filePath);
}

async function readJsoncFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return parseJsonc(content, filePath);
}

export function parseDotEnv(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

async function loadDotEnv(rootDir) {
  const dotenvPath = path.join(rootDir, DOTENV_FILE);
  try {
    await access(dotenvPath);
  } catch {
    return {};
  }

  const content = await readFile(dotenvPath, "utf8");
  const parsed = parseDotEnv(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] == null) {
      process.env[key] = value;
    }
  }
  return parsed;
}

export function normalizeWorkerName(rawValue, source = "Worker name") {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    throw new Error(`Missing ${source}.`);
  }

  const value = rawValue.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
    throw new Error(
      `${source} "${rawValue}" must use lowercase letters, numbers, and hyphens, and cannot start or end with a hyphen.`,
    );
  }

  return value;
}

export function resolveWorkerName(rootConfig, env = process.env) {
  const ciWorkerName = env[WRANGLER_CI_OVERRIDE_NAME_VAR]?.trim();
  if (ciWorkerName) {
    return normalizeWorkerName(ciWorkerName, WRANGLER_CI_OVERRIDE_NAME_VAR);
  }

  const explicitWorkerName = env[TILLER_WORKER_NAME_VAR]?.trim();
  if (explicitWorkerName) {
    return normalizeWorkerName(explicitWorkerName, TILLER_WORKER_NAME_VAR);
  }

  return normalizeWorkerName(rootConfig?.name, `Worker name in ${ROOT_WRANGLER_CONFIG}`);
}

export function deriveBucketName(workerName) {
  if (typeof workerName !== "string" || workerName.trim().length === 0) {
    throw new Error(`Missing Worker name in ${ROOT_WRANGLER_CONFIG}.`);
  }

  const slug = workerName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const base = (slug || "tiller-hub").slice(0, 48).replace(/^-+|-+$/g, "") || "tiller-hub";
  const hash = createHash("sha1").update(workerName).digest("hex").slice(0, 8);
  return `${base}-r2-${hash}`;
}

function getNpxCommand() {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function isMissingBucketError(stderr) {
  const text = stderr.toLowerCase();
  return (
    text.includes("does not exist") ||
    text.includes("not found") ||
    text.includes("could not find") ||
    text.includes("unknown bucket")
  );
}

function runCommand(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";

    if (capture) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new CommandError(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}.`, {
          code,
          stderr,
          stdout,
        }),
      );
    });
  });
}

function runWrangler(args, options) {
  return runCommand(getNpxCommand(), ["wrangler", ...args], options);
}

async function getBucketInfo(bucketName) {
  try {
    const { stdout } = await runWrangler(
      ["r2", "bucket", "info", bucketName, "--config", ROOT_WRANGLER_CONFIG, "--json"],
      {
        capture: true,
      },
    );
    return parseWranglerJsonOutput(stdout, "wrangler r2 bucket info output");
  } catch (error) {
    if (error instanceof CommandError && isMissingBucketError(error.stderr)) {
      return null;
    }
    throw error;
  }
}

async function cloudflareApi(apiToken, path, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ")
      || `Cloudflare API request failed: ${response.status}`;
    throw new Error(message);
  }

  return body.result;
}

async function listContainerApplications(apiToken, accountId) {
  return cloudflareApi(apiToken, `/accounts/${accountId}/containers/applications`, {
    method: "GET",
  });
}

function containerApplicationImage(application) {
  // The list endpoint can retain the previous image after the authoritative
  // application detail has advanced, so prefer detail configuration.
  const image = application?.configuration?.image ?? application?.image;
  return typeof image === "string" ? image : "";
}

function expectedContainerApplicationTargets(containers) {
  return (containers ?? []).map((container) => {
    const name =
      typeof container?.name === "string" ? container.name.trim() : "";
    const image =
      typeof container?.image === "string" ? container.image.trim() : "";
    if (!name || !image) {
      throw new Error(
        "Every deployed Container application must have an exact name and image.",
      );
    }
    return { name, image };
  });
}

export function assessContainerApplicationReadiness(applications, containers) {
  const targets = expectedContainerApplicationTargets(containers);
  const applicationsByName = new Map();
  for (const application of applications ?? []) {
    const name =
      typeof application?.name === "string" ? application.name.trim() : "";
    if (!name) continue;
    const matches = applicationsByName.get(name) ?? [];
    matches.push(application);
    applicationsByName.set(name, matches);
  }

  const pending = [];
  const failed = [];
  for (const target of targets) {
    const matches = applicationsByName.get(target.name) ?? [];
    if (matches.length === 0) {
      pending.push(`${target.name}: not visible yet`);
      continue;
    }
    if (matches.length !== 1) {
      failed.push(
        `${target.name}: Cloudflare returned ${matches.length} applications with this name`,
      );
      continue;
    }

    const application = matches[0];
    const state =
      typeof application?.state === "string"
        ? application.state.trim().toLowerCase()
        : "unknown";
    const image = containerApplicationImage(application);
    if (FAILED_CONTAINER_APPLICATION_STATES.has(state)) {
      failed.push(`${target.name}: deployment state is ${state}`);
      continue;
    }
    if (image !== target.image) {
      pending.push(
        `${target.name}: waiting for image ${target.image} (currently ${image || "unknown"})`,
      );
      continue;
    }
    if (!READY_CONTAINER_APPLICATION_STATES.has(state)) {
      pending.push(
        `${target.name}: image is current; deployment state is ${state}`,
      );
    }
  }

  return {
    ready:
      targets.length === 0 || (pending.length === 0 && failed.length === 0),
    pending,
    failed,
  };
}

async function listContainerApplicationsWithWrangler(containers) {
  const { stdout } = await runWrangler(["containers", "list", "--json"], {
    capture: true,
  });
  const applications = parseWranglerJsonOutput(
    stdout,
    "wrangler containers list output",
  );
  if (!Array.isArray(applications)) {
    throw new Error(
      "wrangler containers list did not return an application array.",
    );
  }

  const expectedNames = new Set(
    expectedContainerApplicationTargets(containers).map(({ name }) => name),
  );
  return Promise.all(
    applications.map(async (application) => {
      if (
        !expectedNames.has(application?.name) ||
        typeof application?.id !== "string"
      ) {
        return application;
      }
      const { stdout: detailStdout } = await runWrangler(
        ["containers", "info", application.id, "--json"],
        { capture: true },
      );
      const detail = parseWranglerJsonOutput(
        detailStdout,
        `wrangler containers info ${application.id} output`,
      );
      return {
        ...application,
        configuration: detail?.configuration ?? application.configuration,
      };
    }),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForContainerApplications(
  containers,
  {
    listApplications = listContainerApplicationsWithWrangler,
    sleep = delay,
    now = Date.now,
    timeoutMs = CONTAINER_ROLLOUT_TIMEOUT_MS,
    pollIntervalMs = CONTAINER_ROLLOUT_POLL_INTERVAL_MS,
    requiredReadyConfirmations = CONTAINER_ROLLOUT_READY_CONFIRMATIONS,
    log = console,
  } = {},
) {
  if (!Array.isArray(containers) || containers.length === 0) return;
  const deadline = now() + timeoutMs;
  let consecutiveReady = 0;
  let lastObservation = "Container rollout status has not been observed.";
  let lastLoggedObservation = "";

  log.log(
    `Waiting for ${containers.length} Container application rollout(s) to finish...`,
  );
  while (true) {
    try {
      const applications = await listApplications(containers);
      const assessment = assessContainerApplicationReadiness(
        applications,
        containers,
      );
      if (assessment.failed.length > 0) {
        throw new Error(
          `Container rollout failed: ${assessment.failed.join("; ")}`,
        );
      }

      if (assessment.ready) {
        consecutiveReady += 1;
        lastObservation = `all applications ready (${consecutiveReady}/${requiredReadyConfirmations} confirmations)`;
        if (consecutiveReady >= requiredReadyConfirmations) {
          log.log(
            "All Container applications are running their expected images.",
          );
          return;
        }
      } else {
        consecutiveReady = 0;
        lastObservation = assessment.pending.join("; ");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Container rollout failed:")
      ) {
        throw error;
      }
      consecutiveReady = 0;
      lastObservation = `status check failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (lastObservation !== lastLoggedObservation) {
      log.log(`Container rollout pending: ${lastObservation}`);
      lastLoggedObservation = lastObservation;
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for Container rollouts. Last observation: ${lastObservation}`,
      );
    }
    await sleep(pollIntervalMs);
  }
}

function getContainerImageOverride(className, { sandboxImageTag = "", githubJobImageTag = "" } = {}) {
  if (className === "SandboxDO" || className === "PlannerRunDO" || className === "CodexAuthDO") return sandboxImageTag;
  if (className === "GitHubJobDO") return githubJobImageTag;
  return "";
}

function isManagedContainerClass(className) {
  return className === "SandboxDO" || className === "GitHubJobDO" || className === "PlannerRunDO" || className === "CodexAuthDO";
}

export function deriveContainerApplicationName(workerName, className) {
  return `${workerName}-${String(className).toLowerCase()}`;
}

export function rewriteContainerApplicationNames(
  containers,
  {
    workerName,
    previousWorkerName = "",
  } = {},
) {
  if (!Array.isArray(containers) || typeof workerName !== "string" || workerName.length === 0) {
    return containers ?? [];
  }

  return containers.map((container) => {
    const className = typeof container?.class_name === "string" ? container.class_name : "";
    if (!className) return { ...container };

    const previousName = previousWorkerName
      ? deriveContainerApplicationName(previousWorkerName, className)
      : "";
    const hasDerivedName = typeof container?.name !== "string"
      || container.name.length === 0
      || (previousName && container.name === previousName);

    if (!hasDerivedName) return { ...container };

    return {
      ...container,
      name: deriveContainerApplicationName(workerName, className),
    };
  });
}

export function needsLiveContainerImageLookup(
  containers,
  { sandboxImageTag = "", githubJobImageTag = "" } = {},
) {
  if (!Array.isArray(containers) || containers.length === 0) return false;

  return containers.some((container) => {
    const override = getContainerImageOverride(container.class_name, {
      sandboxImageTag,
      githubJobImageTag,
    });
    return !override && typeof container?.name === "string" && container.name.length > 0
      && isManagedContainerClass(container.class_name);
  });
}

export function resolveContainerImages(
  containers,
  {
    sandboxImageTag = process.env[CONTAINER_IMAGE_TAG_ENV]?.trim() || "",
    githubJobImageTag = process.env[GITHUB_JOB_IMAGE_TAG_ENV]?.trim() || "",
    liveContainerImages = new Map(),
  } = {},
) {
  const liveImageMap = liveContainerImages instanceof Map ? liveContainerImages : new Map(liveContainerImages ?? []);

  return (containers ?? []).map((container) => {
    const override = getContainerImageOverride(container.class_name, {
      sandboxImageTag,
      githubJobImageTag,
    });
    if (override) {
      return {
        container: { ...container, image: override },
        source: "override",
      };
    }

    const liveImage = isManagedContainerClass(container.class_name) && typeof container?.name === "string"
      ? liveImageMap.get(container.name)
      : null;
    if (typeof liveImage === "string" && liveImage.length > 0) {
      return {
        container: { ...container, image: liveImage },
        source: "live",
      };
    }

    return {
      container: { ...container },
      source: "default",
    };
  });
}

async function resolveLiveContainerImages(apiToken, accountId, containers) {
  const names = new Set(
    (containers ?? [])
      .filter((container) => typeof container?.name === "string" && container.name.length > 0)
      .map((container) => container.name),
  );

  if (names.size === 0) return new Map();

  const applications = await listContainerApplications(apiToken, accountId);
  const liveContainerImages = new Map();

  for (const application of applications ?? []) {
    if (!names.has(application?.name)) continue;
    const image = application?.configuration?.image;
    if (typeof image === "string" && image.length > 0) {
      liveContainerImages.set(application.name, image);
    }
  }

  return liveContainerImages;
}

function logResolvedContainerImages(resolutions) {
  for (const resolution of resolutions ?? []) {
    const label = resolution.container?.name ?? resolution.container?.class_name ?? "container";
    if (resolution.source === "override") {
      console.log(`Container ${label}: using override image ${resolution.container.image}`);
      continue;
    }
    if (resolution.source === "live") {
      console.log(`Container ${label}: preserving live image ${resolution.container.image}`);
      continue;
    }
    console.log(`Container ${label}: using config default image ${resolution.container.image}`);
  }
}

async function resolveGeneratedDeployConfigPath(rootDir) {
  const redirectPath = path.join(rootDir, GENERATED_DEPLOY_CONFIG);
  const redirectConfig = await readJsoncFile(redirectPath);
  if (!redirectConfig || typeof redirectConfig.configPath !== "string") {
    throw new Error(`Missing configPath in ${GENERATED_DEPLOY_CONFIG}. Run the Vite build before deploy.`);
  }
  return path.resolve(path.dirname(redirectPath), redirectConfig.configPath);
}

export function buildDeployConfig(
  baseDeployConfig,
  {
    bucketName,
    workerName,
    sandboxImageTag,
    githubJobImageTag,
    liveContainerImages,
    resolvedContainers,
    runtimeVars,
    placementRegion,
    keepVars = false,
  } = {},
) {
  const nextConfig = structuredClone(baseDeployConfig);
  const vars = { ...(nextConfig.vars ?? {}) };

  if (workerName) {
    nextConfig.name = workerName;
  }

  delete vars[TILLER_WORKER_NAME_VAR];
  delete vars[HUB_PUBLIC_URL_VAR];
  delete vars[WORKER_SERVICE_NAME_VAR];
  delete vars[RETIRED_WORKERS_DEV_ALIAS_DISABLED_VAR];
  delete vars.TILLER_REGION;

  if (runtimeVars && typeof runtimeVars === "object") {
    Object.assign(vars, runtimeVars);
  }
  delete vars.DO_LOCATION_HINT;
  if (placementRegion) {
    vars.DO_LOCATION_HINT = placementRegion;
  }

  nextConfig.vars = vars;
  if (keepVars) {
    nextConfig.keep_vars = true;
  } else {
    delete nextConfig.keep_vars;
  }
  nextConfig.r2_buckets = [
    {
      binding: R2_BUCKET_BINDING,
      bucket_name: bucketName,
    },
  ];

  nextConfig.workers_dev = true;
  nextConfig.preview_urls = false;
  delete nextConfig.routes;

  if (nextConfig.containers?.length) {
    const deploymentContainers = workerName
      ? rewriteContainerApplicationNames(nextConfig.containers, {
        workerName: nextConfig.name,
        previousWorkerName: baseDeployConfig?.name,
      })
      : structuredClone(nextConfig.containers);
    const nextContainers = resolvedContainers
      ?? resolveContainerImages(deploymentContainers, {
        sandboxImageTag,
        githubJobImageTag,
        liveContainerImages,
      }).map((resolution) => resolution.container);
    const containerRegions = placementRegion
      ? placementRegionDefinition(placementRegion).containerRegions
      : null;
    nextConfig.containers = nextContainers.map((container) => ({
      ...structuredClone(container),
      ...(containerRegions
        ? {
            constraints: {
              ...(container.constraints ?? {}),
              regions: [...containerRegions],
            },
          }
        : {}),
    }));
  }

  return nextConfig;
}

async function writeTempConfig(basePath, config) {
  const tempConfigPath = path.join(path.dirname(basePath), TEMP_DEPLOY_CONFIG_NAME);
  await writeFile(tempConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return tempConfigPath;
}

async function deployWithConfig(tempConfigPath) {
  try {
    await runWrangler(["deploy", "--config", tempConfigPath]);
  } finally {
    await rm(tempConfigPath, { force: true });
  }
}

async function main() {
  const rootDir = process.cwd();
  await loadDotEnv(rootDir);

  const rootConfigPath = path.join(rootDir, ROOT_WRANGLER_CONFIG);
  const rootConfig = await readJsoncFile(rootConfigPath);
  const workerName = resolveWorkerName(rootConfig);
  const maintainerDevDeployment = resolveMaintainerDevDeployment({
    hubRoot: rootDir,
    workerName,
    env: process.env,
  });
  const bucketName = deriveBucketName(workerName);
  const apiToken = process.env[CLOUDFLARE_API_TOKEN_ENV]?.trim() || "";
  const accountId = process.env[CLOUDFLARE_ACCOUNT_ID_ENV]?.trim() || "";
  const sandboxImageTag = process.env[CONTAINER_IMAGE_TAG_ENV]?.trim() || "";
  const githubJobImageTag = process.env[GITHUB_JOB_IMAGE_TAG_ENV]?.trim() || "";

  console.log(`Using Worker name: ${workerName}`);
  console.log(`Resolved R2 bucket name: ${bucketName}`);

  const existingBucket = await getBucketInfo(bucketName);
  if (existingBucket) {
    console.log(`Reusing existing R2 bucket "${bucketName}".`);
  } else {
    console.log(`Creating R2 bucket "${bucketName}" with Cloudflare Automatic placement.`);
    await runWrangler([
      "r2",
      "bucket",
      "create",
      bucketName,
      "--config",
      ROOT_WRANGLER_CONFIG,
      "--update-config=false",
    ]);
  }

  const generatedDeployConfigPath = await resolveGeneratedDeployConfigPath(rootDir);
  const generatedDeployConfig = await readJsoncFile(generatedDeployConfigPath);
  const deploymentContainers = rewriteContainerApplicationNames(generatedDeployConfig.containers, {
    workerName,
    previousWorkerName: generatedDeployConfig.name,
  });
  const needsLiveLookup = needsLiveContainerImageLookup(deploymentContainers, {
    sandboxImageTag,
    githubJobImageTag,
  });
  let liveContainerImages = new Map();
  if (needsLiveLookup) {
    if (apiToken && accountId) {
      liveContainerImages = await resolveLiveContainerImages(
        apiToken,
        accountId,
        deploymentContainers,
      );
    } else {
      console.log("Container image preservation unavailable; using config defaults for unpinned containers.");
    }
  }
  const resolvedContainerImages = resolveContainerImages(deploymentContainers, {
    sandboxImageTag,
    githubJobImageTag,
    liveContainerImages,
  });
  logResolvedContainerImages(resolvedContainerImages);
  const resolvedContainers = resolvedContainerImages.map((resolution) => resolution.container);
  const deployConfig = buildDeployConfig(generatedDeployConfig, {
    bucketName,
    workerName,
    resolvedContainers,
    runtimeVars: maintainerDevDeployment?.runtimeVars,
    placementRegion: maintainerDevDeployment?.placementRegion,
    keepVars: maintainerDevDeployment?.kind === "ready",
  });

  const tempConfigPath = await writeTempConfig(generatedDeployConfigPath, deployConfig);
  await deployWithConfig(tempConfigPath);
  await waitForContainerApplications(deployConfig.containers);
  if (maintainerDevDeployment) {
    console.log("Verifying fixed maintainer dev ingress and Access...");
    await probeMaintainerDevDeployment(maintainerDevDeployment);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
