import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { LOCAL_STATE_DIR } from "./config.js";
import { redactEnvValues } from "./redaction.js";
import {
  RunnerCommandFenceError,
  RunnerCommandFenceStore,
  type RunnerCommandDesiredState,
  type RunnerCommandEnvelope,
  type RunnerCommandFenceRecord,
  type RunnerWorkspaceSyncedStopProof,
  RUNNER_COMMAND_PROTOCOL,
} from "./runner-command-fence.js";
import { closeHttpServer } from "./shutdown.js";
import { CODEX_RUNTIME_AUTH_PROTOCOL } from "./codex-runtime-protocol.js";
import { parseManagedLocalRunnerImageSourceId } from "./managed-runner-image.js";
import { resolveHostReviewerIsolationProtocol } from "./reviewer-isolation-capability.js";

export interface RunnerServerConfig {
  port: number;
  image: string;
  localStateDir?: string;
}

export interface RunnerServer {
  server: http.Server;
  close: () => Promise<void>;
}

interface RunnerCapabilities {
  runnerCommandProtocol: 1;
  codexRuntimeAuthProtocol: 1;
  reviewerIsolationProtocol?: 1;
}

function containerName(slug: string): string {
  return `tiller-${slug.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse): void {
  json(res, 404, { error: "Not found" });
}

function methodNotAllowed(res: http.ServerResponse): void {
  json(res, 405, { error: "Method not allowed" });
}

function requestError(res: http.ServerResponse, error: unknown, fallbackStatus = 400): void {
  if (error instanceof RunnerCommandFenceError) {
    json(res, error.status, {
      error: error.message,
      code: error.code,
      ...(error.currentCommandGeneration !== undefined
        ? { currentCommandGeneration: error.currentCommandGeneration }
        : {}),
    });
    return;
  }
  json(res, fallbackStatus, { error: error instanceof Error ? error.message : String(error) });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const error = new Error(stderr.trim() || stdout.trim() || `docker ${args.join(" ")} failed`);
      (error as NodeJS.ErrnoException).code = String(code);
      reject(error);
    });
  });
}

interface ContainerInfo {
  State?: { Status?: string; ExitCode?: number };
  Config?: { Labels?: Record<string, string> };
}

async function inspectContainer(slug: string): Promise<ContainerInfo | null> {
  try {
    const output = await runDocker(["inspect", containerName(slug)]);
    const parsed = JSON.parse(output) as ContainerInfo[];
    return parsed[0] ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("No such object")) {
      return null;
    }
    throw err;
  }
}

function getStatus(info: ContainerInfo | null): string {
  const status = info?.State?.Status;
  if (!status) return "stopped";
  if (status === "exited") return "stopped";
  return status;
}

async function forceRemoveContainer(slug: string): Promise<boolean> {
  try {
    await runDocker(["rm", "-f", containerName(slug)]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("No such container")) {
      return false;
    }
    throw err;
  }
}

async function removeStoppedContainer(slug: string): Promise<boolean> {
  try {
    await runDocker(["rm", containerName(slug)]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("No such container")) return false;
    throw err;
  }
}

interface CreatePayload {
  slug: string;
  repoUrl: string;
  envVars: Record<string, string>;
  commandGeneration?: number;
  operationId?: string;
  desiredState?: RunnerCommandDesiredState;
}

export const HOST_OPENCODE_STATE_MOUNT_PATH = "/home/tiller/.local/share/opencode";
const START_OP_ID_ENV_VAR = "TILLER_LIFECYCLE_START_OP_ID";
const HOST_COMMAND_GENERATION_ENV_VAR = "TILLER_HOST_COMMAND_GENERATION";
const HOST_COMMAND_FENCE_REQUIRED_ENV_VAR = "TILLER_HOST_COMMAND_FENCE_REQUIRED";
const HOST_COMMAND_FENCE_CONTAINER_PATH = "/run/tiller-host-command";
const HOST_COMMAND_GENERATION_LABEL = "tiller.command-generation";
const HOST_OPERATION_ID_LABEL = "tiller.operation-id";
const ENTRYPOINT_FENCED_BEFORE_WORKSPACE_EXIT_CODE = 75;
const ENTRYPOINT_FAILED_BEFORE_HARNESS_EXIT_CODE = 76;
const STOP_CONTROL_PORT = 8790;
const STOP_CONTROL_PREPARE_PATH = "/prepare-stop";

function buildStopControlPrepareUrl(port = STOP_CONTROL_PORT): string {
  return `http://127.0.0.1:${port}${STOP_CONTROL_PREPARE_PATH}`;
}

function resolveRunnerCapabilities(image: string): RunnerCapabilities {
  const reviewerIsolationProtocol = resolveHostReviewerIsolationProtocol(
    image,
    parseManagedLocalRunnerImageSourceId(image),
  );
  return {
    runnerCommandProtocol: RUNNER_COMMAND_PROTOCOL,
    codexRuntimeAuthProtocol: CODEX_RUNTIME_AUTH_PROTOCOL,
    ...(reviewerIsolationProtocol ? { reviewerIsolationProtocol } : {}),
  };
}

function redactError(error: unknown, envVars: Record<string, string>): Error {
  return new Error(redactEnvValues(error instanceof Error ? error.message : String(error), envVars));
}

function resolveHostOpencodeStatePath(slug: string, localStateDir = LOCAL_STATE_DIR): string {
  return resolve(localStateDir, "opencode", slug);
}

export function resolveOpencodeMount(
  payload: CreatePayload,
  localStateDir = LOCAL_STATE_DIR,
): { sourcePath: string; targetPath: string } | null {
  if (payload.envVars.TILLER_HARNESS !== "opencode") {
    return null;
  }

  const sourcePath = resolveHostOpencodeStatePath(payload.slug, localStateDir);
  mkdirSync(sourcePath, { recursive: true, mode: 0o700 });

  return {
    sourcePath,
    targetPath: HOST_OPENCODE_STATE_MOUNT_PATH,
  };
}

export function removeLocalOpencodeState(slug: string, localStateDir = LOCAL_STATE_DIR): boolean {
  const sourcePath = resolveHostOpencodeStatePath(slug, localStateDir);
  if (!existsSync(sourcePath)) {
    return false;
  }

  rmSync(sourcePath, { recursive: true, force: true });
  return true;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

async function removeLocalOpencodeStateForRunner(slug: string, image: string): Promise<boolean> {
  const sourcePath = resolveHostOpencodeStatePath(slug);
  if (!existsSync(sourcePath)) {
    return false;
  }

  try {
    rmSync(sourcePath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (!isPermissionError(error)) {
      throw error;
    }
  }

  await runDocker([
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    "-v",
    `${dirname(sourcePath)}:/tiller-opencode-state`,
    image,
    "-lc",
    'rm -rf -- "$1"',
    "sh",
    `/tiller-opencode-state/${basename(sourcePath)}`,
  ]);
  return true;
}

export function buildContainerEnvVars(payload: CreatePayload): Record<string, string> {
  return {
    ...payload.envVars,
    ...(payload.operationId?.trim() ? { [START_OP_ID_ENV_VAR]: payload.operationId.trim() } : {}),
    ...(Number.isSafeInteger(payload.commandGeneration) && (payload.commandGeneration ?? 0) > 0
      ? {
          [HOST_COMMAND_GENERATION_ENV_VAR]: String(payload.commandGeneration),
          [HOST_COMMAND_FENCE_REQUIRED_ENV_VAR]: "1",
        }
      : {}),
  };
}

export function buildDockerEnvFileContent(envVars: Record<string, string>): string {
  return Object.entries(envVars).map(([key, value]) => {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new Error(`${key} cannot be written to a Docker env file.`);
    }
    return `${key}=${value}`;
  }).join("\n") + "\n";
}

export function createDockerEnvFile(envVars: Record<string, string>): { filePath: string; cleanup: () => void } {
  let dirPath: string | null = null;
  try {
    dirPath = mkdtempSync(join(tmpdir(), "tiller-env-"));
    chmodSync(dirPath, 0o700);
    const filePath = join(dirPath, "env");
    writeFileSync(filePath, buildDockerEnvFileContent(envVars), { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600);
    const cleanupPath = dirPath;
    return {
      filePath,
      cleanup: () => rmSync(cleanupPath, { recursive: true, force: true }),
    };
  } catch (error) {
    if (dirPath) {
      rmSync(dirPath, { recursive: true, force: true });
    }
    throw error;
  }
}

export function buildContainerRunArgs(
  payload: CreatePayload,
  image: string,
  envFilePath: string,
  options?: { fenceDirectory?: string },
): string[] {
  const name = containerName(payload.slug);
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `tiller.slug=${payload.slug}`,
    "--add-host",
    "host.docker.internal:host-gateway",
  ];

  if (payload.commandGeneration && options?.fenceDirectory) {
    args.push(
      "--label",
      `${HOST_COMMAND_GENERATION_LABEL}=${payload.commandGeneration}`,
      "--label",
      `${HOST_OPERATION_ID_LABEL}=${payload.operationId}`,
      "-v",
      `${options.fenceDirectory}:${HOST_COMMAND_FENCE_CONTAINER_PATH}:ro`,
    );
  }

  const opencodeMount = resolveOpencodeMount(payload);
  if (opencodeMount) {
    args.push("-v", `${opencodeMount.sourcePath}:${opencodeMount.targetPath}`);
  }

  args.push("--env-file", envFilePath, image);

  return args;
}

type RunnerCommandGuard = () => void;
interface FencedRunnerCommandContext {
  guard: RunnerCommandGuard;
  fenceDirectory: string;
  readWorkspaceSyncedStop: () => RunnerWorkspaceSyncedStopProof | null;
}

function commandEnvelopeFromPayload(payload: Record<string, unknown>): Partial<RunnerCommandEnvelope> {
  return {
    ...(payload.commandGeneration !== undefined
      ? { commandGeneration: payload.commandGeneration as number }
      : {}),
    ...(payload.operationId !== undefined ? { operationId: payload.operationId as string } : {}),
    ...(payload.desiredState !== undefined
      ? { desiredState: payload.desiredState as RunnerCommandDesiredState }
      : {}),
  };
}

function containerGeneration(info: ContainerInfo | null): number | null {
  const raw = info?.Config?.Labels?.[HOST_COMMAND_GENERATION_LABEL];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function containerOperationId(info: ContainerInfo | null): string | null {
  const operationId = info?.Config?.Labels?.[HOST_OPERATION_ID_LABEL]?.trim();
  return operationId || null;
}

function failedBeforeHarnessProof(info: ContainerInfo | null): {
  commandGeneration: number;
  operationId: string;
} | null {
  if (info?.State?.ExitCode !== ENTRYPOINT_FAILED_BEFORE_HARNESS_EXIT_CODE) return null;
  const commandGeneration = containerGeneration(info);
  const operationId = containerOperationId(info);
  return commandGeneration && operationId ? { commandGeneration, operationId } : null;
}

async function createContainer(
  payload: CreatePayload,
  image: string,
  options: FencedRunnerCommandContext,
): Promise<{ runnerId: string; status: string }> {
  if (!payload.slug || !payload.repoUrl || !payload.envVars || typeof payload.envVars !== "object") {
    throw new Error("slug, repoUrl, and envVars are required");
  }

  options.guard();
  const existing = await inspectContainer(payload.slug);
  options.guard();
  if (existing) {
    const expectedGeneration = payload.commandGeneration ?? null;
    const existingGeneration = containerGeneration(existing);
    if (getStatus(existing) === "running") {
      if (expectedGeneration !== null && existingGeneration === expectedGeneration) {
        return { runnerId: containerName(payload.slug), status: "running" };
      }
      throw new RunnerCommandFenceError(
        `A live runner already exists for ${payload.slug}; refusing to replace it.`,
        "runner_command_conflict",
      );
    }

    const persistenceProof = options.readWorkspaceSyncedStop();
    const preHarnessFailure = failedBeforeHarnessProof(existing);
    const acknowledgedPersistence = Boolean(
      expectedGeneration !== null
      && existingGeneration !== null
      && persistenceProof
      && persistenceProof.runnerCommandGeneration === existingGeneration
      && persistenceProof.stopCommandGeneration < expectedGeneration,
    );
    const safePreHarnessFailure = Boolean(
      expectedGeneration !== null
      && existingGeneration !== null
      && preHarnessFailure
      && preHarnessFailure.commandGeneration === existingGeneration
      && existingGeneration < expectedGeneration,
    );
    if (!acknowledgedPersistence && !safePreHarnessFailure) {
      throw new RunnerCommandFenceError(
        `The stopped runner for ${payload.slug} has no matching workspace persistence acknowledgement.`,
        "runner_command_conflict",
      );
    }
    await removeStoppedContainer(payload.slug);
    options.guard();
  }

  const containerEnvVars = buildContainerEnvVars(payload);
  const envFile = createDockerEnvFile(containerEnvVars);
  try {
    options.guard();
    const args = buildContainerRunArgs(payload, image, envFile.filePath, {
      fenceDirectory: options.fenceDirectory,
    });
    await runDocker(args);
  } catch (error) {
    if (error instanceof RunnerCommandFenceError) throw error;
    throw redactError(error, containerEnvVars);
  } finally {
    envFile.cleanup();
  }
  // If a newer Stop won while Docker was starting, leave the live container
  // in place. The per-slug command queue will run that fenced Stop next so it
  // can complete the normal durable workspace-save flow before stopping it.
  options.guard();
  const info = await inspectContainer(payload.slug);
  return {
    runnerId: containerName(payload.slug),
    status: getStatus(info),
  };
}

async function inspectAppliedRunningCommand(
  record: RunnerCommandFenceRecord,
  fenceStore: RunnerCommandFenceStore,
): Promise<{ runnerId: string; status: string }> {
  fenceStore.assertCurrent(record);
  const info = await inspectContainer(record.slug);
  fenceStore.assertCurrent(record);
  if (!info || containerGeneration(info) !== record.commandGeneration) {
    throw new RunnerCommandFenceError(
      `Runner command generation ${record.commandGeneration} was applied, but its exact runner is unavailable.`,
      "runner_command_conflict",
    );
  }
  return {
    runnerId: containerName(record.slug),
    status: getStatus(info),
  };
}

async function ensureStarted(
  slug: string,
  payload: Partial<CreatePayload> | undefined,
  image: string,
  options: FencedRunnerCommandContext,
): Promise<{ runnerId: string; status: string }> {
  if (payload?.repoUrl && payload?.envVars && typeof payload.envVars === "object") {
    return createContainer({
      slug,
      repoUrl: payload.repoUrl,
      envVars: payload.envVars,
      ...(payload.commandGeneration ? { commandGeneration: payload.commandGeneration } : {}),
      ...(payload.operationId ? { operationId: payload.operationId } : {}),
      ...(payload.desiredState ? { desiredState: payload.desiredState } : {}),
    }, image, options);
  }

  options.guard();
  const existing = await inspectContainer(slug);
  options.guard();
  if (!existing) {
    throw new Error(`Container ${containerName(slug)} does not exist`);
  }

  options.guard();
  return {
    runnerId: containerName(slug),
    status: getStatus(existing),
  };
}

function quoteShellString(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildPrepareDurableStopScript(stopOpId?: string): string {
  const trimmedStopOpId = stopOpId?.trim();
  const headerArg = trimmedStopOpId
    ? ` -H ${quoteShellString(`X-Tiller-Lifecycle-Op-Id: ${trimmedStopOpId}`)}`
    : "";
  return (
    `set -eu; ` +
    `curl -fsS --max-time 120 -X POST${headerArg} ${quoteShellString(buildStopControlPrepareUrl())} >/dev/null`
  );
}

export async function prepareDurableStop(slug: string, stopOpId?: string): Promise<void> {
  const script = buildPrepareDurableStopScript(stopOpId);
  await runDocker(["exec", containerName(slug), "sh", "-lc", script]);
}

export function startRunnerServer(config: RunnerServerConfig): Promise<RunnerServer> {
  const { port, image } = config;
  const runnerCapabilities = resolveRunnerCapabilities(image);
  const fenceStore = new RunnerCommandFenceStore(config.localStateDir);
  const commandTails = new Map<string, Promise<void>>();
  const commandExecutions = new Map<string, Promise<unknown>>();
  const stopAcknowledgements = new Map<string, {
    acknowledgement: Promise<{ callbackExpected: boolean }>;
    completion: Promise<void>;
  }>();

  function commandKey(record: RunnerCommandFenceRecord): string {
    return `${record.slug}:${record.commandGeneration}:${record.operationId}:${record.desiredState}`;
  }

  function commandResponse(record: RunnerCommandFenceRecord): RunnerCommandEnvelope {
    return {
      commandGeneration: record.commandGeneration,
      operationId: record.operationId,
      desiredState: record.desiredState,
    };
  }

  function scheduleCommand<T>(record: RunnerCommandFenceRecord, effect: () => Promise<T>): Promise<T> {
    const key = commandKey(record);
    const existing = commandExecutions.get(key);
    if (existing) return existing as Promise<T>;

    const previous = commandTails.get(record.slug) ?? Promise.resolve();
    const execution = previous.catch(() => {}).then(effect);
    const tail = execution.then(() => undefined, () => undefined);
    commandTails.set(record.slug, tail);
    commandExecutions.set(key, execution);
    void execution.then(
      () => {
        if (commandExecutions.get(key) === execution) commandExecutions.delete(key);
      },
      () => {
        if (commandExecutions.get(key) === execution) commandExecutions.delete(key);
      },
    );
    void tail.then(() => {
      if (commandTails.get(record.slug) === tail) commandTails.delete(record.slug);
    });
    return execution;
  }

  function acceptCommand(
    slug: string,
    payload: Record<string, unknown>,
    desiredState: RunnerCommandDesiredState,
  ): RunnerCommandFenceRecord {
    return fenceStore.accept(slug, commandEnvelopeFromPayload(payload), desiredState);
  }

  async function executeFencedStart(
    record: RunnerCommandFenceRecord,
    payload: CreatePayload,
    action: "create" | "start",
  ): Promise<{ runnerId: string; status: string }> {
    const guard = () => fenceStore.assertCurrent(record);
    const fencedPayload: CreatePayload = {
      ...payload,
      commandGeneration: record.commandGeneration,
      operationId: record.operationId,
      desiredState: record.desiredState,
    };
    const result = action === "create"
        ? await createContainer(fencedPayload, image, {
          guard,
          fenceDirectory: fenceStore.directoryFor(record.slug),
          readWorkspaceSyncedStop: () => fenceStore.readWorkspaceSyncedStop(record.slug),
        })
        : await ensureStarted(record.slug, fencedPayload, image, {
          guard,
          fenceDirectory: fenceStore.directoryFor(record.slug),
          readWorkspaceSyncedStop: () => fenceStore.readWorkspaceSyncedStop(record.slug),
        });
    guard();
    fenceStore.markApplied(record);
    return result;
  }

  async function executeFencedStop(
    record: RunnerCommandFenceRecord,
    onInspected: (result: {
      callbackExpected: boolean;
      startRejectedBeforeWorkspace?: boolean;
    }) => void,
  ): Promise<void> {
    fenceStore.assertCurrent(record);
    const info = await inspectContainer(record.slug);
    fenceStore.assertCurrent(record);
    if (!info || getStatus(info) !== "running") {
      const startRejectedBeforeWorkspace = Boolean(
        info
        && info.State?.ExitCode === ENTRYPOINT_FENCED_BEFORE_WORKSPACE_EXIT_CODE
        && containerGeneration(info) === record.commandGeneration - 1,
      );
      onInspected({
        callbackExpected: false,
        ...(startRejectedBeforeWorkspace ? { startRejectedBeforeWorkspace: true } : {}),
      });
      fenceStore.markApplied(record);
      return;
    }
    onInspected({ callbackExpected: true });
    await prepareDurableStop(record.slug, record.operationId);
    fenceStore.assertCurrent(record);
    const runningGeneration = containerGeneration(info);
    if (runningGeneration !== null) {
      fenceStore.recordWorkspaceSyncedStop(record, runningGeneration);
    }
    await runDocker(["stop", containerName(record.slug)]);
    fenceStore.assertCurrent(record);
    fenceStore.markApplied(record);
  }

  function scheduleFencedStop(record: RunnerCommandFenceRecord): {
    acknowledgement: Promise<{
      callbackExpected: boolean;
      startRejectedBeforeWorkspace?: boolean;
    }>;
    completion: Promise<void>;
  } {
    const key = commandKey(record);
    const existing = stopAcknowledgements.get(key);
    if (existing) return existing;

    let acknowledgementSettled = false;
    let resolveAcknowledgement!: (result: {
      callbackExpected: boolean;
      startRejectedBeforeWorkspace?: boolean;
    }) => void;
    let rejectAcknowledgement!: (error: unknown) => void;
    const acknowledgement = new Promise<{
      callbackExpected: boolean;
      startRejectedBeforeWorkspace?: boolean;
    }>((resolvePromise, rejectPromise) => {
      resolveAcknowledgement = resolvePromise;
      rejectAcknowledgement = rejectPromise;
    });
    // Recovery schedules Stop without an HTTP waiter; keep a rejected early
    // inspection from becoming an unhandled promise while preserving it for
    // request callers that do await the acknowledgement.
    void acknowledgement.catch(() => {});
    const completion = scheduleCommand(record, () => executeFencedStop(record, (result) => {
      if (acknowledgementSettled) return;
      acknowledgementSettled = true;
      resolveAcknowledgement(result);
    }));
    const scheduled = { acknowledgement, completion };
    stopAcknowledgements.set(key, scheduled);
    void completion.then(
      () => {
        if (!acknowledgementSettled) {
          acknowledgementSettled = true;
          resolveAcknowledgement({ callbackExpected: false });
        }
        if (stopAcknowledgements.get(key) === scheduled) stopAcknowledgements.delete(key);
      },
      (error) => {
        if (!acknowledgementSettled) {
          acknowledgementSettled = true;
          rejectAcknowledgement(error);
        }
        if (stopAcknowledgements.get(key) === scheduled) stopAcknowledgements.delete(key);
      },
    );
    return scheduled;
  }

  async function executeFencedDestroy(record: RunnerCommandFenceRecord): Promise<{ removed: boolean }> {
    fenceStore.assertCurrent(record);
    const removed = await forceRemoveContainer(record.slug);
    fenceStore.assertCurrent(record);
    const removedOpencodeState = await removeLocalOpencodeStateForRunner(record.slug, image);
    fenceStore.assertCurrent(record);
    fenceStore.markApplied(record);
    return { removed: removed || removedOpencodeState };
  }

  function recoverAcceptedTerminalCommands(): void {
    for (const record of fenceStore.listAcceptedTerminalCommands()) {
      const execution = record.desiredState === "stopped"
        ? scheduleFencedStop(record).completion
        : scheduleCommand(record, () => executeFencedDestroy(record));
      void execution.catch((error) => {
        console.error(
          `[runner] Failed to recover ${record.desiredState} command for ${record.slug}:`,
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  }

  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://127.0.0.1:${port}`);

    if (url.pathname === "/healthz") {
      json(res, 200, {
        ok: true,
        capabilities: runnerCapabilities,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/envs") {
      try {
        const payload = await readJson(req);
        const createPayload = payload as unknown as CreatePayload;
        const record = acceptCommand(createPayload.slug, payload, "running");
        const created = record.phase === "applied"
          ? await inspectAppliedRunningCommand(record, fenceStore)
          : await scheduleCommand(record, () => executeFencedStart(record, createPayload, "create"));
        json(res, 201, { ...created, ...commandResponse(record) });
      } catch (err) {
        requestError(res, err);
      }
      return;
    }

    const envMatch = url.pathname.match(/^\/envs\/([^/]+)$/);
    if (req.method === "GET" && envMatch) {
      const slug = decodeURIComponent(envMatch[1]);
      const info = await inspectContainer(slug);
      if (!info) {
        notFound(res);
        return;
      }
      const preHarnessFailure = failedBeforeHarnessProof(info);
      json(res, 200, {
        runnerId: containerName(slug),
        status: getStatus(info),
        ...(preHarnessFailure ? { failedStartBeforeHarness: true, ...preHarnessFailure } : {}),
      });
      return;
    }

    if (req.method === "DELETE" && envMatch) {
      const slug = decodeURIComponent(envMatch[1]);
      try {
        const payload = await readJson(req).catch(() => ({} as Record<string, unknown>));
        const record = acceptCommand(slug, payload, "absent");
        const result = await scheduleCommand(record, () => executeFencedDestroy(record));
        json(res, 200, {
          ok: true,
          runnerId: containerName(slug),
          removed: result.removed,
          ...commandResponse(record),
        });
      } catch (error) {
        requestError(res, error);
      }
      return;
    }

    const actionMatch = url.pathname.match(/^\/envs\/([^/]+)\/(start|stop)$/);
    if (actionMatch) {
      const slug = decodeURIComponent(actionMatch[1]);
      const action = actionMatch[2];

      if (req.method !== "POST") {
        methodNotAllowed(res);
        return;
      }

      if (action === "start") {
        try {
          const payload = await readJson(req);
          const startPayload = { ...payload, slug } as unknown as CreatePayload;
          const record = acceptCommand(slug, payload, "running");
          const started = record.phase === "applied"
            ? await inspectAppliedRunningCommand(record, fenceStore)
            : await scheduleCommand(record, () => executeFencedStart(record, startPayload, "start"));
          json(res, 200, { ...started, ...commandResponse(record) });
        } catch (err) {
          requestError(res, err);
        }
        return;
      }

      if (action === "stop") {
        try {
          const payload = await readJson(req).catch(() => ({} as Record<string, unknown>));
          const record = acceptCommand(slug, payload, "stopped");
          const scheduledStop = scheduleFencedStop(record);
          void scheduledStop.completion.catch((error) => {
            console.error(`[runner] background fenced stop for ${slug} failed:`, error);
          });
          const acknowledgement = await scheduledStop.acknowledgement;
          fenceStore.assertCurrent(record);
          json(res, 200, {
            ok: true,
            runnerId: containerName(slug),
            callbackExpected: acknowledgement.callbackExpected,
            ...(acknowledgement.startRejectedBeforeWorkspace
              ? { startRejectedBeforeWorkspace: true }
              : {}),
            ...commandResponse(record),
          });
        } catch (error) {
          requestError(res, error);
        }
        return;
      }
    }

    notFound(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handleApi(req, res);
    } catch (err) {
      console.error("[runner] request failed:", err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Runner port ${port} is already in use — is another runner or tiller process running?`));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      console.log(`[runner] listening on http://127.0.0.1:${port}`);
      console.log(`[runner] image=${image}`);
      console.log("[runner] relying on localhost binding and Cloudflare Access");

      recoverAcceptedTerminalCommands();

      resolve({
        server,
        close: () => closeHttpServer(server),
      });
    });
  });
}
