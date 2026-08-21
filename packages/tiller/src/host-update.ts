import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ansi } from "./ansi.js";
import {
  CONFIG_PATH,
  DEFAULT_LOCAL_RUNNER_IMAGE,
  HUB_URL,
  isLocalHubUrl,
  isWorkersDevHubUrl,
  loadConfig,
  loadedDotEnvValues,
  reloadConfig,
  writeConfig,
  type LoadedDotEnvValue,
  type TillerConfig,
} from "./config.js";
import {
  getActiveSystemdServices,
  restartSystemdService,
  type ActiveSystemdService,
  type SystemdRestartResult,
} from "./host-service.js";
import { readActiveHostPidRecord, type HostPidRecord } from "./host-stack.js";
import {
  checkLocalRunnerHealth,
  pullLocalRunnerImage,
  type HealthResult,
} from "./local-stack.js";
import {
  HostSupervisorRestartError,
  selectHostSupervisor,
  type HostSupervisor,
  type HostSupervisorInspection,
} from "./host-supervisor.js";
import {
  isManagedLocalRunnerImageRef,
} from "./managed-runner-image.js";
import {
  fetchHostUpdateCheck,
  resolveHostUpdateTargetImage,
  type HostUpdateCheckResult,
} from "./host-runtime-metadata.js";
export {
  isManagedLocalRunnerImageRef,
  parseManagedLocalRunnerImageSourceId,
} from "./managed-runner-image.js";

export interface HostUpdateOptions {
  dryRun?: boolean;
  yes?: boolean;
  hubUrlOverride?: string;
}

export interface HostUpdateDeps {
  env?: NodeJS.ProcessEnv;
  loadedDotEnvValues?: Record<string, LoadedDotEnvValue>;
  configPath?: string;
  loadConfig?: () => TillerConfig;
  writeConfig?: (config: TillerConfig) => void;
  reloadConfig?: () => void;
  fetchUpdateCheck?: (hubUrl: string) => Promise<HostUpdateCheckResult>;
  pullImage?: (image: string) => Promise<void>;
  platform?: NodeJS.Platform;
  hostSupervisor?: HostSupervisor;
  getActiveSystemdServices?: () => ActiveSystemdService[];
  readActiveHostPidRecord?: () => HostPidRecord | null;
  restartSystemdService?: (scope: ActiveSystemdService["scope"]) => SystemdRestartResult;
  checkLocalRunnerHealth?: () => Promise<HealthResult>;
  confirm?: (message: string) => Promise<boolean>;
  log?: (message: string) => void;
}

export interface HostUpdateResult {
  ok: boolean;
  changed: boolean;
  targetImage: string;
  blockers: string[];
}

function hostLog(message: string): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${message}\n`);
}

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function normalizeImageRef(value: string | undefined): string {
  return (value ?? "").trim() || DEFAULT_LOCAL_RUNNER_IMAGE;
}

function pathsEqual(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

export function parseHostUpdateArgs(argv: string[]): HostUpdateOptions {
  const options: HostUpdateOptions = {};
  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    throw new Error(`Unknown host update option: ${arg}`);
  }
  return options;
}

export function describeLocalRunnerImageOverride(
  env: NodeJS.ProcessEnv,
  dotenvValues: Record<string, LoadedDotEnvValue>,
): string | null {
  const value = env.TILLER_LOCAL_RUNNER_IMAGE?.trim();
  if (!value) return null;
  const dotenv = dotenvValues.TILLER_LOCAL_RUNNER_IMAGE;
  if (dotenv) {
    return `TILLER_LOCAL_RUNNER_IMAGE is set by ${dotenv.path}. Remove that .env override before running \`tiller host update\`.`;
  }
  return "TILLER_LOCAL_RUNNER_IMAGE is set in the shell environment. Unset it before running `tiller host update`.";
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) {
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function buildServiceBlockers(activeServices: ActiveSystemdService[], configPath: string): string[] {
  if (activeServices.length > 1) {
    return ["Both the user and system tiller-host systemd services are active. Stop one service before running `tiller host update`."];
  }

  return activeServices.flatMap((service) => {
    if (!service.configPath) {
      return [`Could not determine which config path the active ${service.scope} systemd service reads. Reinstall the service or stop it before running \`tiller host update\`.`];
    }
    if (!pathsEqual(service.configPath, configPath)) {
      return [
        `The active ${service.scope} systemd service reads ${service.configPath}, but this command would update ${configPath}. Run \`tiller host update\` as the service user so it updates the service config.`,
      ];
    }
    return [];
  });
}

function describeServiceState(activeServices: ActiveSystemdService[]): string {
  if (activeServices.length === 0) return "none active";
  return activeServices
    .map((service) => `${service.scope} active${service.configPath ? ` [config ${service.configPath}]` : " [config unknown]"}`)
    .join(", ");
}

function describeManualProcess(manualHost: HostPidRecord | null): string {
  return manualHost ? `active [pid ${manualHost.pid}]` : "not detected";
}

function describeRestartAction(activeServices: ActiveSystemdService[], manualHost: HostPidRecord | null): string {
  if (activeServices.length === 1) {
    const service = activeServices[0]!;
    return service.scope === "user"
      ? "restart active user systemd service"
      : "restart active system systemd service when root or passwordless sudo is available; otherwise print manual restart instructions";
  }
  if (manualHost) {
    return "manual restart required for the active `tiller host` process";
  }
  return "no active host process; start `tiller host` when ready";
}

function printDryRun(options: {
  log: (message: string) => void;
  configPath: string;
  currentImage: string;
  targetImage: string;
  activeServices: ActiveSystemdService[];
  supervisor: HostSupervisorInspection | null;
  manualHost: HostPidRecord | null;
  blockers: string[];
}): void {
  options.log("Host runtime update dry run");
  options.log(`config path: ${options.configPath}`);
  options.log(`current image: ${options.currentImage}`);
  options.log(`target image: ${options.targetImage}`);
  options.log("workload containers: unchanged");
  options.log(`systemd services: ${describeServiceState(options.activeServices)}`);
  if (options.supervisor) {
    options.log(
      `${options.supervisor.platform} service: ${options.supervisor.installed ? "installed" : "not installed"}, ${options.supervisor.running ? "running" : "not running"}`,
    );
  }
  options.log(`manual host process: ${describeManualProcess(options.manualHost)}`);
  options.log(`restart action: ${describeRestartAction(options.activeServices, options.manualHost)}`);
  if (options.blockers.length > 0) {
    options.log("blockers:");
    for (const blocker of options.blockers) {
      options.log(`- ${blocker}`);
    }
  }
}

async function waitForRequiredHealth(
  label: string,
  check: () => Promise<HealthResult>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = "not ready";

  while (Date.now() < deadline) {
    const result = await check();
    if (result.ok) return;
    lastDetail = result.detail ?? lastDetail;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }

  throw new Error(`${label} health check failed after restart: ${lastDetail}`);
}

function printManualRestartInstructions(
  log: (message: string) => void,
  activeService: ActiveSystemdService | null,
  manualHost: HostPidRecord | null,
): void {
  if (activeService?.scope === "system") {
    log("Runtime refreshed. Restart the system service manually:");
    log(`  sudo systemctl restart ${activeService.serviceName}`);
    log(`  journalctl -u ${activeService.serviceName} -f`);
    return;
  }
  if (manualHost) {
    log(`Runtime refreshed. Restart the active \`tiller host\` process [pid ${manualHost.pid}] manually.`);
    return;
  }
  log("Runtime refreshed. Start `tiller host` when you want this machine to serve workloads.");
}

async function runPostRestartHealthChecks(deps: Required<Pick<HostUpdateDeps,
  "checkLocalRunnerHealth"
>> & { log: (message: string) => void }): Promise<void> {
  await waitForRequiredHealth("Local runner", deps.checkLocalRunnerHealth);
  deps.log("local runner health ok");
}

export async function runHostUpdate(
  options: HostUpdateOptions = {},
  deps: HostUpdateDeps = {},
): Promise<HostUpdateResult> {
  const log = deps.log ?? hostLog;
  const env = deps.env ?? process.env;
  const configPath = deps.configPath ?? CONFIG_PATH;
  const dotenvValues = deps.loadedDotEnvValues ?? loadedDotEnvValues;
  const readConfig = deps.loadConfig ?? loadConfig;
  const saveConfig = deps.writeConfig ?? writeConfig;
  const refreshConfig = deps.reloadConfig ?? reloadConfig;
  const fetchUpdateCheck = deps.fetchUpdateCheck ?? fetchHostUpdateCheck;
  const platform = deps.platform ?? process.platform;
  const activeServices = platform === "linux"
    ? (deps.getActiveSystemdServices ?? getActiveSystemdServices)()
    : [];
  const supervisor = platform === "linux" || platform === "darwin"
    ? (
        deps.hostSupervisor
        ?? (activeServices.length > 1
          ? null
          : selectHostSupervisor(platform, {
            ...(activeServices[0]?.scope
              ? { preferredSystemdScope: activeServices[0].scope }
              : {}),
            getActiveSystemdServices: () => activeServices,
            restartSystemdService:
              deps.restartSystemdService ?? restartSystemdService,
          }))
      )
    : null;
  const supervisorInspection = supervisor?.inspect() ?? null;
  const manualHost = activeServices.length === 0 && !supervisorInspection?.running
    ? (deps.readActiveHostPidRecord ?? readActiveHostPidRecord)()
    : null;
  const config = readConfig();
  const hubUrl = normalizeUrl(options.hubUrlOverride || env.HUB_URL || config.hubUrl || HUB_URL);
  const overrideBlocker = describeLocalRunnerImageOverride(env, dotenvValues);
  const blockers: string[] = [];

  if (overrideBlocker) {
    blockers.push(overrideBlocker);
  }
  if (!hubUrl) {
    blockers.push(`Hub URL required. Run \`tiller host setup\` first, or add hubUrl to ${configPath}.`);
  } else if (!isWorkersDevHubUrl(hubUrl) && !isLocalHubUrl(hubUrl)) {
    blockers.push(
      "The saved Hub URL is not the canonical workers.dev origin. Run "
      + "`tiller host setup --hub-url https://<exact-host>.workers.dev`.",
    );
  }

  const updateCheck = hubUrl && blockers.length === 0
    ? await fetchUpdateCheck(hubUrl)
    : null;
  const targetImage = hubUrl && updateCheck
    ? resolveHostUpdateTargetImage(updateCheck.currentRelease)
    : "(unavailable until hub URL is configured)";
  const currentImage = normalizeImageRef(config.localRunnerImage);
  const imageChanged = currentImage !== targetImage;

  if (!isManagedLocalRunnerImageRef(currentImage)) {
    blockers.push(
      `tiller host update cannot safely manage custom images. The configured localRunnerImage is ${currentImage}. Remove the custom image or update it manually.`,
    );
  }

  if (platform === "linux") {
    blockers.push(...buildServiceBlockers(activeServices, configPath));
  } else if (platform !== "darwin") {
    blockers.push("Persistent execution-machine services are supported on Linux and macOS.");
  }

  if (options.dryRun) {
    printDryRun({
      log,
      configPath,
      currentImage,
      targetImage,
      activeServices,
      supervisor: supervisorInspection,
      manualHost,
      blockers,
    });
    return {
      ok: blockers.length === 0,
      changed: false,
      targetImage,
      blockers,
    };
  }

  if (blockers.length > 0) {
    return {
      ok: false,
      changed: false,
      targetImage,
      blockers,
    };
  }

  if (!options.yes) {
    const confirmed = await (deps.confirm ?? defaultConfirm)(
      imageChanged
        ? `Update the execution-machine runtime image from ${currentImage} to ${targetImage}? Existing workloads keep their current containers.`
        : `Refresh the execution-machine service at ${targetImage}? Existing workloads keep their current containers.`,
    );
    if (!confirmed) {
      throw new Error("Update cancelled. Re-run with `--yes` to confirm non-interactively.");
    }
  }

  await (deps.pullImage ?? pullLocalRunnerImage)(targetImage);

  if (imageChanged) {
    saveConfig({
      ...config,
      localRunnerImage: targetImage,
    });
    refreshConfig();
    log(`pinned localRunnerImage to ${targetImage}`);
  } else {
    log(`localRunnerImage already pinned to ${targetImage}`);
  }

  log("existing workload containers were left unchanged");

  if (supervisor && supervisorInspection?.installed) {
    try {
      supervisor.restart();
    } catch (error) {
      if (
        supervisorInspection.platform === "systemd"
        && supervisorInspection.scope === "system"
        && error instanceof HostSupervisorRestartError
      ) {
        if (error.result.stderr) {
          log(`${ansi.yellow}Could not restart system service automatically: ${error.result.stderr}${ansi.reset}`);
        } else {
          log(`${ansi.yellow}Could not restart system service automatically.${ansi.reset}`);
        }
        printManualRestartInstructions(log, activeServices[0] ?? null, null);
        return {
          ok: true,
          changed: true,
          targetImage,
          blockers: [],
        };
      }
      throw error;
    }
    log(`restarted ${supervisorInspection.platform} service`);
    await runPostRestartHealthChecks({
      log,
      checkLocalRunnerHealth: deps.checkLocalRunnerHealth ?? checkLocalRunnerHealth,
    });
    return {
      ok: true,
      changed: true,
      targetImage,
      blockers: [],
    };
  }

  const activeService = activeServices[0] ?? null;
  if (!activeService) {
    printManualRestartInstructions(log, null, manualHost);
    return {
      ok: true,
      changed: true,
      targetImage,
      blockers: [],
    };
  }

  throw new Error(
    `The active ${activeService.scope} systemd service could not be inspected through the host supervisor.`,
  );
}

export async function runHostUpdateCommand(options: HostUpdateOptions = {}): Promise<void> {
  const result = await runHostUpdate(options);
  if (!result.ok) {
    if (!options.dryRun) {
      for (const blocker of result.blockers) {
        hostLog(`${ansi.red}${blocker}${ansi.reset}`);
      }
    }
    process.exitCode = 1;
  }
}
