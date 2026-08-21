import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { ansi } from "./ansi.js";
import {
  HUB_URL,
  LOCAL_STATE_DIR,
  MACHINE_ID,
  hubControlHeaders,
  ensureHostAuth,
  isMachineUuid,
  isWorkersDevHubUrl,
  loadConfig,
  reloadConfig,
  writeConfig,
} from "./config.js";
import { runBrowserBootstrap } from "./browser-bootstrap.js";
import { fetchHubSetupStatus } from "./codex-subscription.js";
import { readSetupStatusWithValidatedCredential } from "./host-auth.js";
import { collectHubHostChecks } from "./host-diagnostics.js";
import {
  type SystemdServiceScope,
} from "./host-service.js";
import {
  selectHostSupervisor,
  type HostSupervisor,
} from "./host-supervisor.js";
import {
  dockerInstalled,
  dockerReady,
  getLocalStackStatus,
  localImageExists,
  prepareLocalRunnerImage,
  startHostRunner,
  stopHostRunner,
} from "./local-stack.js";
import { hasWarnings, printCheckReport } from "./readiness.js";
import { collectSetupChecks } from "./setup.js";
import {
  fetchHostUpdateCheck,
  resolveHostUpdateTargetImage,
} from "./host-runtime-metadata.js";

export interface HostPidRecord {
  pid: number;
  startedAt: string;
}

interface HostPrepResult {
  report: Awaited<ReturnType<typeof collectSetupChecks>>;
  ready: boolean;
  blockingMessage?: string;
}

const HOST_PID_PATH = resolve(LOCAL_STATE_DIR, "host.pid.json");
const HOST_SHUTDOWN_DEADLINE_MS = 10_000;

function hostLog(message: string): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${message}\n`);
}

function readHostPidRecord(): HostPidRecord | null {
  try {
    return JSON.parse(readFileSync(HOST_PID_PATH, "utf-8")) as HostPidRecord;
  } catch {
    return null;
  }
}

export function readActiveHostPidRecord(): HostPidRecord | null {
  const record = readHostPidRecord();
  if (!record?.pid || !processIsRunning(record.pid)) {
    return null;
  }
  return record;
}

function writeHostPidRecord(pid: number): void {
  mkdirSync(LOCAL_STATE_DIR, { recursive: true });
  writeFileSync(
    HOST_PID_PATH,
    JSON.stringify({ pid, startedAt: new Date().toISOString() } satisfies HostPidRecord, null, 2),
  );
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return !processIsRunning(pid);
}

function renderHealth(ok: boolean): string {
  return ok ? `${ansi.green}ok${ansi.reset}` : `${ansi.red}down${ansi.reset}`;
}

function renderCheckLevel(level: "ok" | "warn" | "fail"): string {
  if (level === "ok") return `${ansi.green}ok${ansi.reset}`;
  if (level === "warn") return `${ansi.yellow}degraded${ansi.reset}`;
  return `${ansi.red}down${ansi.reset}`;
}

function resolveInstallServiceScope(
  requested: SystemdServiceScope | "auto" | undefined,
): SystemdServiceScope {
  if (requested === "user" || requested === "system") {
    return requested;
  }

  return "system";
}

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export async function prepareLocalHostRuntime(): Promise<HostPrepResult> {
  const dockerAvailable = dockerInstalled();
  const dockerOk = dockerAvailable && dockerReady();

  const collect = async (blockingMessage?: string): Promise<HostPrepResult> => {
    const report = await collectSetupChecks({ local: true });
    return {
      report,
      ready: !blockingMessage && report.ready,
      ...(blockingMessage ? { blockingMessage } : {}),
    };
  };

  if (!dockerAvailable || !dockerOk) {
    return collect("Docker is not ready. Fix the items above, then rerun setup from the workers.dev URL.");
  }

  if (dockerOk && !localImageExists()) {
    try {
      await prepareLocalRunnerImage();
    } catch (error) {
      return collect(`the local sandbox image could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return collect();
}

async function verifySavedMachineCredential(hubUrl: string): Promise<boolean> {
  const existing = loadConfig();
  if (!existing.clientId?.trim() || !existing.clientSecret?.trim() || !existing.controlSecret?.trim()) return false;
  try {
    await fetchHubSetupStatus(hubUrl, {
      "CF-Access-Client-Id": existing.clientId.trim(),
      "CF-Access-Client-Secret": existing.clientSecret.trim(),
      "X-Tiller-Capability": existing.controlSecret.trim(),
    });
    return true;
  } catch {
    return false;
  }
}

async function connectMachineCredential(hubUrl: string): Promise<{
  clientId: string;
  clientSecret: string;
  controlSecret: string;
}> {
  if (await verifySavedMachineCredential(hubUrl)) {
    const existing = loadConfig();
    return {
      clientId: existing.clientId!.trim(),
      clientSecret: existing.clientSecret!.trim(),
      controlSecret: existing.controlSecret!.trim(),
    };
  }

  const connected = await runBrowserBootstrap(hubUrl);
  if (
    connected.protectionMode !== "cf-access"
    || normalizeUrl(connected.hubUrl) !== hubUrl
  ) {
    throw new Error("The workers.dev Hub must be protected before this machine can connect.");
  }
  return {
    clientId: connected.clientId,
    clientSecret: connected.clientSecret,
    controlSecret: connected.controlSecret,
  };
}

export async function resolveCompatibleRuntimeImage(
  hubUrl: string,
  credential: { clientId: string; clientSecret: string; controlSecret: string },
): Promise<string> {
  const metadata = await fetchHostUpdateCheck(hubUrl, {
    "CF-Access-Client-Id": credential.clientId,
    "CF-Access-Client-Secret": credential.clientSecret,
    "X-Tiller-Capability": credential.controlSecret,
  });
  return resolveHostUpdateTargetImage(metadata.currentRelease);
}

export async function waitForHealthyMachineAdvertisement(
  hubUrl: string,
  machineId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `${hubUrl}/api/machines/${encodeURIComponent(machineId)}/execution-status`,
        {
        headers: { Accept: "application/json", ...hubControlHeaders },
        },
      );
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const status = await response.json() as {
          state?: string;
          machineId?: string;
          code?: string;
        };
        if (status.state === "ready" && status.machineId === machineId) {
          return;
        }
        if (status.state === "incompatible" && status.machineId === machineId) {
          throw new Error(
            `The execution-machine advertisement is incompatible (${status.code ?? "unknown"}).`,
          );
        }
        lastError = status.state === "not_connected"
          ? "the Hub has not accepted a live advertisement"
          : "the Hub returned an unexpected machine status";
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("advertisement is incompatible")) {
        throw error;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(
    `The execution-machine service did not advertise healthy state to the Hub${lastError ? ` (${lastError})` : ""}.`,
  );
}

export interface HostSetupDeps {
  loadConfig?: typeof loadConfig;
  writeConfig?: typeof writeConfig;
  reloadConfig?: typeof reloadConfig;
  connectMachineCredential?: typeof connectMachineCredential;
  resolveCompatibleRuntimeImage?: typeof resolveCompatibleRuntimeImage;
  prepareLocalHostRuntime?: typeof prepareLocalHostRuntime;
  createHostSupervisor?: () => HostSupervisor;
  waitForHealthyMachineAdvertisement?: typeof waitForHealthyMachineAdvertisement;
  machineId?: () => string;
  displayName?: () => string;
  printCheckReport?: typeof printCheckReport;
  log?: (message: string) => void;
  printSettingsLink?: (url: string) => void;
}

export async function runHostSetupCommand(
  options: { hubUrlOverride?: string } = {},
  deps: HostSetupDeps = {},
): Promise<void> {
  const readConfig = deps.loadConfig ?? loadConfig;
  const saveConfig = deps.writeConfig ?? writeConfig;
  const refreshConfig = deps.reloadConfig ?? reloadConfig;
  const log = deps.log ?? hostLog;
  const config = readConfig();
  const overrideHubUrl = normalizeUrl(options.hubUrlOverride);
  const configuredHubUrl = normalizeUrl(config.hubUrl || HUB_URL);
  const setupHubUrl = overrideHubUrl || configuredHubUrl;

  if (!isWorkersDevHubUrl(setupHubUrl)) {
    throw new Error(
      "An exact workers.dev Hub URL is required. Run `tiller host setup --hub-url https://<exact-host>.workers.dev`.",
    );
  }

  const credential = await (deps.connectMachineCredential ?? connectMachineCredential)(setupHubUrl);
  const runtimeImage = await (
    deps.resolveCompatibleRuntimeImage ?? resolveCompatibleRuntimeImage
  )(setupHubUrl, credential);
  const storedMachineId = config.machineId?.trim() ?? "";
  const machineId = isMachineUuid(storedMachineId)
    ? storedMachineId
    : (deps.machineId ?? randomUUID)();
  const displayName = config.displayName?.trim() || (deps.displayName ?? hostname)();
  const previousHubUrlEnv = process.env.HUB_URL;
  if (overrideHubUrl) process.env.HUB_URL = setupHubUrl;
  try {
    saveConfig({
      ...config,
      hubUrl: setupHubUrl,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      controlSecret: credential.controlSecret,
      machineId,
      displayName,
      localRunnerImage: runtimeImage,
    });
    refreshConfig();
    log(`Saved execution machine ${displayName} (${machineId}).`);

    const prep = await (deps.prepareLocalHostRuntime ?? prepareLocalHostRuntime)();
    (deps.printCheckReport ?? printCheckReport)("Execution machine setup", prep.report.checks);
    if (!prep.ready) {
      throw new Error(prep.blockingMessage ?? "Execution machine checks failed.");
    }

    const supervisor = (deps.createHostSupervisor ?? selectHostSupervisor)();
    const installed = supervisor.installOrUpdate();
    if (!installed.started && !installed.running) {
      throw new Error(`The ${installed.platform} service was installed but did not start.`);
    }
    if (
      installed.platform === "systemd"
      && installed.scope === "user"
      && installed.lingerEnabled === false
    ) {
      try {
        supervisor.stop();
      } catch {
        // The actionable persistence failure below is the setup outcome.
      }
      const user = process.env.USER?.trim() || "$USER";
      throw new Error(
        `The user systemd service is not persistent because login linger is disabled. Run \`sudo loginctl enable-linger ${user}\` and rerun \`tiller host setup\`, or install the system service with \`sudo tiller host install-service --system\`.`,
      );
    }
    log(`Installed and started ${installed.serviceName}.`);
    await (deps.waitForHealthyMachineAdvertisement ?? waitForHealthyMachineAdvertisement)(
      setupHubUrl,
      machineId,
    );
    log("Your machine is ready for selection in Settings.");
    const settingsUrl = `${setupHubUrl}/settings`;
    if (deps.printSettingsLink) {
      deps.printSettingsLink(settingsUrl);
    } else {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${settingsUrl}\n`);
    }
  } finally {
    if (overrideHubUrl) {
      if (previousHubUrlEnv === undefined) delete process.env.HUB_URL;
      else process.env.HUB_URL = previousHubUrlEnv;
    }
  }
}

export async function runHostInstallServiceCommand(
  options: {
    scope?: SystemdServiceScope | "auto";
  } = {},
): Promise<void> {
  if (process.platform === "darwin") {
    ensureHostAuth();
    const installed = selectHostSupervisor().installOrUpdate();
    hostLog(`Installed ${installed.serviceName} at ${installed.definitionPath}.`);
    if (!installed.started && !installed.running) {
      throw new Error("The launchd service was installed but did not start.");
    }
    return;
  }
  if (process.platform !== "linux") {
    throw new Error("Persistent execution-machine services are supported on Linux and macOS.");
  }

  const scope = resolveInstallServiceScope(options.scope);
  if (scope === "user") {
    ensureHostAuth();
  }
  const installed = selectHostSupervisor(process.platform, {
    preferredSystemdScope: scope,
  }).installOrUpdate();
  if (scope === "system") {
    hostLog(`Installed systemd unit at ${installed.definitionPath} for ${installed.serviceUser}.`);
    hostLog(`The service will read host config from ${installed.configPath}.`);
  } else {
    hostLog(`Installed user systemd unit at ${installed.definitionPath}.`);
  }

  if (installed.daemonReloaded && installed.enabled && installed.started) {
    hostLog(
      scope === "system"
        ? `Enabled and started ${installed.serviceName} in the system service manager.`
        : `Enabled and started ${installed.serviceName} in the user systemd manager.`,
    );
  } else {
    hostLog(
      `${ansi.yellow}The service file was written, but systemd could not fully enable/start it from this shell.${ansi.reset}`,
    );
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Run these commands on the Pi:\n`);
    if (scope === "system") {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset}   sudo systemctl daemon-reload\n`);
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset}   sudo systemctl enable --now ${installed.serviceName}\n`);
    } else {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset}   systemctl --user daemon-reload\n`);
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset}   systemctl --user enable --now ${installed.serviceName}\n`);
    }
  }

  if (scope === "user" && installed.lingerEnabled === false && process.env.USER) {
    hostLog(
      `To start your execution machine automatically after reboot without logging in first, run \`sudo loginctl enable-linger ${process.env.USER}\` once.`,
    );
    hostLog(
      `If you want unattended boot without linger, use \`sudo tiller host install-service --system\` instead.`,
    );
  }

  if (scope === "user") {
    const report = await collectSetupChecks({ local: true });
    if (!report.ready || hasWarnings(report.checks)) {
      hostLog("The service is installed, but this machine still has setup warnings.");
      process.stderr.write(
        `${ansi.bold}[tiller]${ansi.reset} Run \`tiller host setup\` and \`tiller doctor\` if the service does not stay healthy.\n`,
      );
    }
  } else {
    process.stderr.write(
      `${ansi.bold}[tiller]${ansi.reset} Run \`sudo -u ${installed.serviceUser} tiller doctor\` if the service does not stay healthy.\n`,
    );
  }

  process.stderr.write(
    `${ansi.bold}[tiller]${ansi.reset} View logs with \`${scope === "system" ? "journalctl" : "journalctl --user"} -u ${installed.serviceName} -f\`\n`,
  );
}

export async function runHostCommand(): Promise<void> {
  await readSetupStatusWithValidatedCredential();
  const existing = readHostPidRecord();
  if (existing?.pid && existing.pid !== process.pid && processIsRunning(existing.pid)) {
    hostLog(`Your execution machine is already running ${ansi.dim}[pid ${existing.pid}]${ansi.reset}`);
    return;
  }

  writeHostPidRecord(process.pid);

  let cleanedUp = false;
  let shutdownSignal: NodeJS.Signals | null = null;

  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await stopHostRunner().catch(() => false);
    rmSync(HOST_PID_PATH, { force: true });
  };

  const cleanupAfterSignal = async () => {
    const forceExit = setTimeout(() => {
      hostLog(`Shutdown cleanup exceeded ${HOST_SHUTDOWN_DEADLINE_MS}ms after ${shutdownSignal ?? "signal"}; forcing exit.`);
      process.exit(0);
    }, HOST_SHUTDOWN_DEADLINE_MS);
    try {
      await cleanup();
    } finally {
      clearTimeout(forceExit);
    }
    process.exit(0);
  };

  try {
    await startHostRunner();
    hostLog("Your execution machine is running.");

    await new Promise<void>((resolvePromise) => {
      const onSignal = (signal: NodeJS.Signals) => {
        shutdownSignal = signal;
        resolvePromise();
      };
      process.once("SIGTERM", () => onSignal("SIGTERM"));
      process.once("SIGINT", () => onSignal("SIGINT"));
    });
  } finally {
    if (shutdownSignal) {
      await cleanupAfterSignal();
    } else {
      await cleanup();
    }
  }
}

export async function runHostStatusCommand(): Promise<void> {
  const [stack, setupStatus] = await Promise.all([
    getLocalStackStatus(),
    readSetupStatusWithValidatedCredential(),
  ]);
  const hostPid = readHostPidRecord();
  const hostRunning = Boolean(hostPid?.pid && processIsRunning(hostPid.pid));

  hostLog(`host process ${hostRunning ? renderHealth(true) : renderHealth(false)}${hostPid?.pid ? ` ${ansi.dim}[pid ${hostPid.pid}]${ansi.reset}` : ""}`);
  hostLog(`docker ${renderHealth(stack.dockerReady)}`);
  hostLog(`hub reachable ${renderHealth(stack.hubReachable)}`);
  if (setupStatus) {
    for (const check of collectHubHostChecks(setupStatus)) {
      hostLog(`${check.label.toLowerCase()} ${renderCheckLevel(check.level)} ${ansi.dim}${check.detail ?? ""}${ansi.reset}`);
      if (check.fixHint && check.level !== "ok") {
        hostLog(`${ansi.dim}${check.fixHint}${ansi.reset}`);
      }
    }
  }
  hostLog(`runner ${renderHealth(stack.runner.healthy)} ${ansi.dim}${stack.runner.detail ?? ""}${ansi.reset}`);
}

export async function waitForMachineAdvertisementWithdrawal(
  hubUrl: string,
  machineId: string,
  timeoutMs = 10_000,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = hubControlHeaders,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "the machine is still advertised";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(
        `${normalizeUrl(hubUrl)}/api/machines/${encodeURIComponent(machineId)}/execution-status`,
        {
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            ...headers,
          },
        },
      );
      if (!response.ok) {
        lastError = `Hub returned HTTP ${response.status}`;
      } else {
        const status = await response.json() as { state?: string };
        if (status.state === "not_connected") return;
        lastError = `Hub still reports ${status.state ?? "an unknown state"}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `The execution machine stopped locally, but its Hub advertisement did not withdraw (${lastError}).`,
  );
}

export interface HostDownDeps {
  platform?: NodeJS.Platform;
  hostSupervisor?: HostSupervisor | null;
  readHostPidRecord?: () => HostPidRecord | null;
  processIsRunning?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  waitForProcessExit?: (pid: number) => Promise<boolean>;
  removePidRecord?: () => void;
  stopHostRunner?: () => Promise<boolean>;
  waitForMachineAdvertisementWithdrawal?: (
    hubUrl: string,
    machineId: string,
  ) => Promise<void>;
  hubUrl?: string;
  machineId?: string;
  log?: (message: string) => void;
}

export async function runHostDownCommand(deps: HostDownDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const log = deps.log ?? hostLog;
  const readPid = deps.readHostPidRecord ?? readHostPidRecord;
  const isRunning = deps.processIsRunning ?? processIsRunning;
  const removePid = deps.removePidRecord ?? (() => rmSync(HOST_PID_PATH, { force: true }));
  const waitForExit = deps.waitForProcessExit ?? waitForProcessExit;
  const hubUrl = deps.hubUrl ?? HUB_URL;
  const machineId = deps.machineId ?? MACHINE_ID;
  const waitForWithdrawal = deps.waitForMachineAdvertisementWithdrawal
    ?? ((url, id) => waitForMachineAdvertisementWithdrawal(url, id));
  const supervisor = deps.hostSupervisor === undefined
    ? (
        platform === "linux" || platform === "darwin"
          ? selectHostSupervisor(platform)
          : null
      )
    : deps.hostSupervisor;
  const supervisorState = supervisor?.inspect() ?? null;
  const hostPid = readPid();

  if (supervisorState?.running) {
    supervisor!.stop();
    if (hostPid?.pid && isRunning(hostPid.pid)) {
      const stopped = await waitForExit(hostPid.pid);
      if (!stopped) {
        throw new Error(`Timed out waiting for the execution machine [pid ${hostPid.pid}] to stop`);
      }
    }
    removePid();
    if (!hubUrl || !isMachineUuid(machineId)) {
      throw new Error(
        "The service stopped, but Hub withdrawal could not be verified because the saved machine configuration is invalid. Run `tiller host setup`.",
      );
    }
    await waitForWithdrawal(hubUrl, machineId);
    log("Stopped the execution-machine service and verified its Hub advertisement was withdrawn.");
    return;
  }

  if (hostPid?.pid && isRunning(hostPid.pid)) {
    try {
      (deps.signalProcess ?? process.kill)(hostPid.pid, "SIGTERM");
    } catch {
      // The process may have exited between the liveness check and signal.
    }

    const stopped = await waitForExit(hostPid.pid);
    if (!stopped) {
      throw new Error(`Timed out waiting for the execution machine [pid ${hostPid.pid}] to stop`);
    }
    removePid();
    if (hubUrl && isMachineUuid(machineId)) {
      await waitForWithdrawal(hubUrl, machineId);
    }
    log("Stopped the execution machine.");
    return;
  }

  removePid();
  await (deps.stopHostRunner ?? stopHostRunner)().catch(() => false);
  log("The execution machine is not running.");
}
