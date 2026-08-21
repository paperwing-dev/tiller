import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stdout as output } from "node:process";
import { ansi } from "./ansi.js";
import { checkHttpHealth } from "./health-check.js";
import type { HubMachine } from "./hub-client.js";
import { startRunnerServer, type RunnerServer } from "./runner-server.js";
import { RunnerSessionController } from "./runner-session.js";
import { RUNNER_COMMAND_PROTOCOL } from "./runner-command-fence.js";
import { CODEX_RUNTIME_AUTH_PROTOCOL } from "./codex-runtime-protocol.js";
import { parseManagedLocalRunnerImageSourceId } from "./managed-runner-image.js";
import { resolveHostReviewerIsolationProtocol } from "./reviewer-isolation-capability.js";
import {
  HUB_URL,
  LOCAL_RUNNER_IMAGE,
  LOCAL_RUNNER_PORT,
  LOCAL_STATE_DIR,
  MACHINE_ID,
  MACHINE_DISPLAY_NAME,
  hubControlHeaders,
} from "./config.js";

type ServiceName = "runner";
type ServiceMode = "managed" | "external" | "stopped";

interface ServiceStatus {
  name: ServiceName;
  label: string;
  mode: ServiceMode;
  running: boolean;
  healthy: boolean;
  detail?: string;
}

export interface LocalStackStatus {
  dockerReady: boolean;
  hubReachable: boolean;
  runner: ServiceStatus;
}

export interface HealthResult {
  ok: boolean;
  detail?: string;
}

interface BringUpResult {
  started: ServiceName[];
  status: LocalStackStatus;
}

interface StepResult<T> {
  value: T;
  detail?: string;
}

interface HostServiceRegistration {
  host?: {
    machineId: string;
    displayName?: string;
    connectedAt: string;
    dockerAvailable: boolean;
    runnerAvailable?: boolean;
    runnerCommandProtocol?: 1;
    codexRuntimeAuthProtocol?: 1;
    reviewerIsolationProtocol?: 1;
    claudeSubscription: boolean;
    localRunnerImage?: string;
    localRunnerImageSourceId?: string;
    transport: "session";
  };
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let inProcessRunner: RunnerServer | null = null;
let runnerRegistration: RunnerSessionController | null = null;
let announcedSignature: string | null = null;
let runnerSessionConnectedAt: string | null = null;
let runnerHealthAvailable = false;
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function localLog(message: string): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${message}\n`);
}

function localRunnerHealthUrl(): string {
  return `http://127.0.0.1:${LOCAL_RUNNER_PORT}/healthz`;
}

function serviceModeLabel(status: ServiceStatus): string {
  return status.mode === "stopped" ? "local" : status.mode;
}

function stackFullyHealthy(status: LocalStackStatus): boolean {
  return status.dockerReady && status.hubReachable && status.runner.healthy;
}

async function runAnimatedStep<T>(label: string, work: () => Promise<StepResult<T>>): Promise<T> {
  const prefix = `${ansi.bold}[tiller]${ansi.reset} `;
  const render = (icon: string, text: string) => {
    process.stderr.write(`\r${ansi.eraseLine}${prefix}${icon} ${text}`);
  };

  if (!process.stderr.isTTY) {
    localLog(`${label}...`);
    try {
      const result = await work();
      localLog(`${ansi.green}✓${ansi.reset} ${label}${result.detail ? ` ${ansi.dim}${result.detail}${ansi.reset}` : ""}`);
      return result.value;
    } catch (error) {
      localLog(`${ansi.red}✕${ansi.reset} ${label} ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  let frame = 0;
  render(`${ansi.cyan}${SPINNER_FRAMES[0]}${ansi.reset}`, label);
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    render(`${ansi.cyan}${SPINNER_FRAMES[frame]}${ansi.reset}`, label);
  }, 80);

  try {
    const result = await work();
    clearInterval(timer);
    render(`${ansi.green}✓${ansi.reset}`, `${label}${result.detail ? ` ${ansi.dim}${result.detail}${ansi.reset}` : ""}`);
    process.stderr.write("\n");
    return result.value;
  } catch (error) {
    clearInterval(timer);
    render(`${ansi.red}✕${ansi.reset}`, `${label} ${ansi.dim}${error instanceof Error ? error.message : String(error)}${ansi.reset}`);
    process.stderr.write("\n");
    throw error;
  }
}

function commandReady(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: 5000,
  });
  return result.status === 0;
}

async function checkHealth(url: string, headers?: HeadersInit): Promise<HealthResult> {
  return checkHttpHealth(url, headers);
}

async function runDocker(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `docker ${args.join(" ")} failed`));
    });
  });
}

async function runDockerInherited(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`docker ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
  });
}

export function dockerInstalled(): boolean {
  return commandReady("docker", ["--version"]);
}

export function dockerReady(): boolean {
  return commandReady("docker", ["info"]);
}

async function ensureDocker(): Promise<boolean> {
  if (dockerReady()) return false;

  if (process.platform !== "darwin") {
    throw new Error("Docker is not running");
  }

  const resolveApp = spawnSync("open", ["-Ra", "Docker"], {
    stdio: "ignore",
    timeout: 5000,
  });
  if (resolveApp.status !== 0) {
    throw new Error("Docker Desktop is not installed");
  }

  const openApp = spawnSync("open", ["-ga", "Docker"], {
    stdio: "ignore",
    timeout: 5000,
  });
  if (openApp.status !== 0) {
    throw new Error("Failed to launch Docker Desktop");
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (dockerReady()) return true;
    await sleep(1_000);
  }

  throw new Error("Docker Desktop did not become ready");
}

export function localImageExists(image = LOCAL_RUNNER_IMAGE): boolean {
  return commandReady("docker", ["image", "inspect", image]);
}

async function ensureLocalRunnerImage(): Promise<void> {
  if (localImageExists()) {
    return;
  }

  localLog(
    `Pulling sandbox image ${ansi.cyan}${LOCAL_RUNNER_IMAGE}${ansi.reset}...`,
  );

  if (output.isTTY) {
    await runDockerInherited(["pull", LOCAL_RUNNER_IMAGE]);
  } else {
    await runDocker(["pull", LOCAL_RUNNER_IMAGE]);
  }

  localLog(`${ansi.green}Sandbox image is ready.${ansi.reset}`);
}

export async function prepareLocalRunnerImage(): Promise<void> {
  await ensureLocalRunnerImage();
}

export async function pullLocalRunnerImage(image: string): Promise<void> {
  localLog(
    `Pulling sandbox image ${ansi.cyan}${image}${ansi.reset}...`,
  );

  if (output.isTTY) {
    await runDockerInherited(["pull", image]);
  } else {
    await runDocker(["pull", image]);
  }

  localLog(`${ansi.green}Sandbox image is ready.${ansi.reset}`);
}

async function listManagedEnvContainers(): Promise<string[]> {
  const outputText = await runDocker(["ps", "-aq", "--filter", "label=tiller.slug"]);
  return outputText.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export async function removeManagedEnvContainers(containerIds?: string[]): Promise<number> {
  const ids = containerIds ?? await listManagedEnvContainers();
  if (ids.length === 0) {
    return 0;
  }

  await runDocker(["rm", "-f", ...ids]);
  return ids.length;
}

export function runnerSessionSignature(
  machineId: string,
  localRunnerImage: string,
  localRunnerImageSourceId: string | null,
  runnerCommandProtocol: 1 | null,
  codexRuntimeAuthProtocol: 1 | null,
  reviewerIsolationProtocol: 1 | null,
  displayName = machineId,
  dockerAvailable = true,
  runnerAvailable = true,
): string {
  return JSON.stringify({
    machineId,
    displayName,
    dockerAvailable,
    runnerAvailable,
    ...(runnerCommandProtocol === RUNNER_COMMAND_PROTOCOL
      ? { runnerCommandProtocol: RUNNER_COMMAND_PROTOCOL }
      : {}),
    ...(codexRuntimeAuthProtocol === CODEX_RUNTIME_AUTH_PROTOCOL
      ? { codexRuntimeAuthProtocol: CODEX_RUNTIME_AUTH_PROTOCOL }
      : {}),
    ...(reviewerIsolationProtocol === 1 ? { reviewerIsolationProtocol: 1 } : {}),
    claudeSubscription: false,
    localRunnerImage,
    ...(localRunnerImageSourceId ? { localRunnerImageSourceId } : {}),
    transport: "session",
  });
}

export function parseRunnerSessionSignature(machine: HubMachine): string | null {
  try {
    const state = JSON.parse(machine.runner_state) as HostServiceRegistration;
    if (!state.host?.machineId) return null;
    return runnerSessionSignature(
      state.host.machineId,
      state.host.localRunnerImage ?? "",
      state.host.localRunnerImageSourceId ?? null,
      state.host.runnerCommandProtocol === RUNNER_COMMAND_PROTOCOL
        ? RUNNER_COMMAND_PROTOCOL
        : null,
      state.host.codexRuntimeAuthProtocol === CODEX_RUNTIME_AUTH_PROTOCOL
        ? CODEX_RUNTIME_AUTH_PROTOCOL
        : null,
      state.host.reviewerIsolationProtocol === 1 ? 1 : null,
      state.host.displayName ?? state.host.machineId,
      state.host.dockerAvailable === true,
      state.host.runnerAvailable === true,
    );
  } catch {
    return null;
  }
}

function buildRunnerRegistration(): HostServiceRegistration | null {
  if (!runnerSessionConnectedAt) {
    runnerSessionConnectedAt = new Date().toISOString();
  }
  const localRunnerImage = LOCAL_RUNNER_IMAGE.trim();
  const localRunnerImageSourceId = parseManagedLocalRunnerImageSourceId(localRunnerImage);
  const reviewerIsolationProtocol = resolveHostReviewerIsolationProtocol(localRunnerImage, localRunnerImageSourceId);
  const dockerAvailable = dockerReady();
  const runnerAvailable = dockerAvailable && inProcessRunner !== null && runnerHealthAvailable;
  return {
    host: {
      machineId: MACHINE_ID,
      displayName: MACHINE_DISPLAY_NAME,
      connectedAt: runnerSessionConnectedAt,
      dockerAvailable,
      runnerAvailable,
      runnerCommandProtocol: RUNNER_COMMAND_PROTOCOL,
      codexRuntimeAuthProtocol: CODEX_RUNTIME_AUTH_PROTOCOL,
      ...(reviewerIsolationProtocol ? { reviewerIsolationProtocol } : {}),
      claudeSubscription: false,
      localRunnerImage,
      ...(localRunnerImageSourceId ? { localRunnerImageSourceId } : {}),
      transport: "session",
    },
  };
}

async function ensureRegistrationClient(): Promise<void> {
  if (!HUB_URL) return;

  runnerRegistration ??= new RunnerSessionController({
    hubUrl: HUB_URL,
    cfAccessHeaders: hubControlHeaders,
    machineId: MACHINE_ID,
    runnerPort: LOCAL_RUNNER_PORT,
    buildState: buildRunnerRegistration,
    refreshState: async () => {
      const health = await checkLocalRunnerHealth();
      runnerHealthAvailable = inProcessRunner !== null && dockerReady() && health.ok;
    },
    getStateSignature: (state) => runnerSessionSignature(
      state.host!.machineId,
      state.host!.localRunnerImage ?? "",
      state.host!.localRunnerImageSourceId ?? null,
      state.host!.runnerCommandProtocol === RUNNER_COMMAND_PROTOCOL
        ? RUNNER_COMMAND_PROTOCOL
        : null,
      state.host!.codexRuntimeAuthProtocol === CODEX_RUNTIME_AUTH_PROTOCOL
        ? CODEX_RUNTIME_AUTH_PROTOCOL
        : null,
      state.host!.reviewerIsolationProtocol === 1 ? 1 : null,
      state.host!.displayName,
      state.host!.dockerAvailable,
      state.host!.runnerAvailable,
    ),
    getMachineSignature: parseRunnerSessionSignature,
    onRegistered: (signature) => {
      if (announcedSignature !== signature) {
        announcedSignature = signature;
        localLog("Execution machine registered with hub");
      }
    },
    onLog: (message) => localLog(`${ansi.yellow}${message}${ansi.reset}`),
  });

  await runnerRegistration.ensureConnected();
}

function clearRunnerRegistration(): void {
  runnerRegistration?.close();
  runnerRegistration = null;
  announcedSignature = null;
  runnerSessionConnectedAt = null;
}

async function syncRunnerRegistration(timeoutMs = 15_000): Promise<void> {
  if (!HUB_URL) {
    return;
  }

  await ensureRegistrationClient();
  await runnerRegistration?.sync(timeoutMs);
}

async function trySyncRunnerRegistration(timeoutMs = 1_500): Promise<boolean> {
  try {
    await syncRunnerRegistration(timeoutMs);
    return true;
  } catch (error) {
    localLog(`${ansi.yellow}Runner registration unavailable: ${error instanceof Error ? error.message : String(error)}${ansi.reset}`);
    return false;
  }
}

function ensureStateDir(): void {
  mkdirSync(LOCAL_STATE_DIR, { recursive: true });
}

async function stopManagedService(): Promise<boolean> {
  if (inProcessRunner) {
    runnerHealthAvailable = false;
    clearRunnerRegistration();
    await inProcessRunner.close();
    inProcessRunner = null;
    return true;
  }
  runnerHealthAvailable = false;
  clearRunnerRegistration();
  return false;
}

export async function checkLocalRunnerHealth(): Promise<HealthResult> {
  return checkHealth(localRunnerHealthUrl());
}

export async function checkHubHealth(): Promise<HealthResult> {
  if (!HUB_URL) {
    return { ok: false, detail: "Hub URL not configured" };
  }
  return checkHealth(`${HUB_URL}/api/setup/status`, hubControlHeaders);
}

async function getRunnerStatus(): Promise<ServiceStatus> {
  const health = await checkLocalRunnerHealth();
  if (inProcessRunner) {
    return {
      name: "runner",
      label: "runner",
      mode: "managed",
      running: true,
      healthy: health.ok,
      detail: health.detail ?? (health.ok ? undefined : "unhealthy"),
    };
  }
  if (health.ok) {
    return {
      name: "runner",
      label: "runner",
      mode: "external",
      running: true,
      healthy: true,
      detail: health.detail,
    };
  }
  return {
    name: "runner",
    label: "runner",
    mode: "stopped",
    running: false,
    healthy: false,
    detail: health.detail,
  };
}

export async function getLocalStackStatus(): Promise<LocalStackStatus> {
  const [runner, hubReachable] = await Promise.all([
    getRunnerStatus(),
    checkHubHealth().then((result) => result.ok).catch(() => false),
  ]);

  return {
    dockerReady: dockerReady(),
    hubReachable,
    runner,
  };
}

function serviceIcon(status: ServiceStatus): string {
  if (status.healthy) return `${ansi.green}ok${ansi.reset}`;
  if (status.running) return `${ansi.yellow}degraded${ansi.reset}`;
  return `${ansi.dim}down${ansi.reset}`;
}

function formatServiceStatus(status: ServiceStatus): string {
  const mode = status.mode === "stopped" ? "managed:none" : status.mode;
  const detail = status.detail ? ` ${ansi.dim}${status.detail}${ansi.reset}` : "";
  return `  ${serviceIcon(status)} ${status.label} ${ansi.dim}[${mode}]${ansi.reset}${detail}`;
}

function printStatus(status: LocalStackStatus, options: { compact?: boolean } = {}): void {
  const dockerLabel = status.dockerReady ? `${ansi.green}ok${ansi.reset}` : `${ansi.red}down${ansi.reset}`;
  const hubLabel = status.hubReachable ? `${ansi.green}ok${ansi.reset}` : `${ansi.red}down${ansi.reset}`;

  if (options.compact && stackFullyHealthy(status)) {
    localLog(
      `stack ready ${ansi.dim}[hub ok, docker ok, runner ${serviceModeLabel(status.runner)}, direct session]${ansi.reset}`,
    );
    return;
  }

  localLog(`hub ${hubLabel} ${ansi.dim}${HUB_URL}${ansi.reset}`);
  localLog(`docker ${dockerLabel}`);
  process.stderr.write(`${formatServiceStatus(status.runner)}\n`);
  process.stderr.write(`${ansi.dim}state dir: ${LOCAL_STATE_DIR}${ansi.reset}\n`);
  process.stderr.write(
    `${ansi.dim}host transport: outbound hub session${ansi.reset}\n`,
  );
}

async function ensureRunner(status: ServiceStatus, dockerOk: boolean): Promise<boolean> {
  if (inProcessRunner) return false;
  if (status.mode === "external") {
    if (!status.healthy) {
      throw new Error(`Runner is externally managed but unhealthy: ${status.detail ?? "unknown error"}`);
    }
    return false;
  }
  if (status.healthy && status.mode === "managed") return false;
  if (!dockerOk) {
    throw new Error("Docker is not running");
  }

  await ensureLocalRunnerImage();

  inProcessRunner = await startRunnerServer({
    port: LOCAL_RUNNER_PORT,
    image: LOCAL_RUNNER_IMAGE,
  });
  return true;
}

async function bringUpLocalStack(options: { announce?: boolean; printSummary?: boolean } = {}): Promise<BringUpResult> {
  ensureStateDir();
  const before = await getLocalStackStatus();
  if (before.runner.mode === "external") {
    throw new Error(
      `A runner is already listening on port ${LOCAL_RUNNER_PORT}. Stop the other execution-machine process before starting this one; its runtime protocols and image cannot be verified by this supervisor.`,
    );
  }
  if (options.announce) {
    localLog(`${ansi.bold}Checking Your machine${ansi.reset}`);
  }

  const started: ServiceName[] = [];
  const failures: string[] = [];
  let dockerOk = before.dockerReady;

  if (!dockerOk) {
    try {
      dockerOk = options.announce
        ? await runAnimatedStep("docker", async () => {
          const startedDocker = await ensureDocker();
          return {
            value: true,
            detail: startedDocker ? "Docker Desktop ready" : "ok",
          };
        })
        : await (async () => {
          await ensureDocker();
          return true;
        })();
    } catch (error) {
      failures.push(`docker: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (dockerOk || before.runner.healthy) {
    try {
      if (!before.runner.healthy && dockerOk && !localImageExists()) {
        await ensureLocalRunnerImage();
      }
      const runnerStarted = options.announce
        ? await runAnimatedStep("runner", async () => {
          if (before.runner.healthy) {
            return { value: false, detail: `ok (${serviceModeLabel(before.runner)})` };
          }
          const startedRunner = await ensureRunner(before.runner, dockerOk);
          const current = await getRunnerStatus();
          return { value: startedRunner, detail: `ready (${serviceModeLabel(current)})` };
        })
        : await ensureRunner(before.runner, dockerOk);
      if (runnerStarted) {
        started.push("runner");
      }
    } catch (error) {
      failures.push(`runner: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const finalStatus = await getLocalStackStatus();
  runnerHealthAvailable = (
    inProcessRunner !== null
    && finalStatus.dockerReady
    && finalStatus.runner.healthy
  );
  if (finalStatus.runner.healthy) {
    await trySyncRunnerRegistration();
  }
  if (options.printSummary) {
    printStatus(finalStatus, { compact: options.announce });
  }

  if (failures.length > 0) {
    throw new Error(failures.join(" | "));
  }

  return {
    started,
    status: finalStatus,
  };
}

export async function startHostRunner(): Promise<LocalStackStatus> {
  const result = await bringUpLocalStack({
    announce: true,
    printSummary: true,
  });
  return result.status;
}

export async function stopHostRunner(): Promise<boolean> {
  return stopManagedService();
}
