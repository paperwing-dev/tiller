import {
  HubClient,
  type HubMachine,
  type RunnerControlErrorCode,
  type RunnerControlRequestMessage,
} from "./hub-client.js";
import { redactEnvValues } from "./redaction.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

interface RunnerSessionState {
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

export interface RunnerSessionControllerOptions {
  hubUrl: string;
  cfAccessHeaders: Record<string, string>;
  machineId: string;
  runnerPort: number;
  buildState: () => RunnerSessionState | null;
  refreshState?: () => Promise<void>;
  getStateSignature: (state: RunnerSessionState) => string;
  getMachineSignature: (machine: HubMachine) => string | null;
  onRegistered?: (signature: string) => void;
  onLog?: (message: string) => void;
}

function readRunnerErrorPrefix(action: RunnerControlRequestMessage["action"]): string {
  switch (action) {
    case "create":
      return "Execution machine create failed";
    case "status":
      return "Execution machine status failed";
    case "start":
      return "Execution machine start failed";
    case "stop":
      return "Execution machine stop failed";
    case "destroy":
      return "Execution machine destroy failed";
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function extractErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error.trim();
    }
    if (typeof record.text === "string" && record.text.trim()) {
      return record.text.trim();
    }
  }

  return `HTTP ${status}`;
}

class LocalRunnerRequestError extends Error {
  readonly code?: RunnerControlErrorCode;
  readonly currentCommandGeneration?: number;

  constructor(
    message: string,
    code?: RunnerControlErrorCode,
    currentCommandGeneration?: number,
  ) {
    super(message);
    this.name = "LocalRunnerRequestError";
    this.code = code;
    this.currentCommandGeneration = currentCommandGeneration;
  }
}

export class RunnerSessionController {
  private hub: HubClient | null = null;
  private stateVersion: number | null = null;
  private awaitingSignature: string | null = null;
  private registeredSignature: string | null = null;
  private connectionAdvertisementPending = true;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private heartbeatRefreshPending = false;

  constructor(private readonly options: RunnerSessionControllerOptions) {}

  async ensureConnected(): Promise<void> {
    if (!this.options.hubUrl || this.hub) return;

    this.hub = new HubClient({
      hubUrl: this.options.hubUrl,
      cfAccessHeaders: this.options.cfAccessHeaders,
    });
    this.hub.setMachineId(this.options.machineId);

    this.hub.on("connected", () => {
      this.stateVersion = null;
      this.awaitingSignature = null;
      this.registeredSignature = null;
      this.connectionAdvertisementPending = true;
      this.startHeartbeat();
    });

    this.hub.on("machine-updated", (machine) => {
      if (machine.id !== this.options.machineId) return;

      this.stateVersion = machine.runner_state_version;
      const remoteSignature = this.options.getMachineSignature(machine);
      this.registeredSignature = remoteSignature;

      if (this.awaitingSignature === remoteSignature && remoteSignature) {
        this.awaitingSignature = null;
        this.connectionAdvertisementPending = false;
        this.options.onRegistered?.(remoteSignature);
      } else if (this.awaitingSignature && remoteSignature !== this.awaitingSignature) {
        this.awaitingSignature = null;
      }

      this.flush();
    });

    this.hub.on("runner-control-request", (request) => {
      void this.handleRunnerControlRequest(request);
    });

    this.hub.on("error", (err) => {
      const versionConflict = err.message.match(/Version conflict \(current: (\d+)\)/);
      if (versionConflict) {
        this.stateVersion = Number.parseInt(versionConflict[1], 10);
        this.awaitingSignature = null;
        this.flush();
        return;
      }

      this.options.onLog?.(`Runner session: ${err.message}`);
    });

    this.hub.connect();
  }

  flush(): void {
    const state = this.options.buildState();
    if (!state || !this.hub || this.stateVersion == null || this.awaitingSignature) {
      return;
    }

    if (this.hub.getSocket()?.readyState !== WebSocket.OPEN) {
      return;
    }

    const signature = this.options.getStateSignature(state);
    if (!this.connectionAdvertisementPending && signature === this.registeredSignature) {
      return;
    }

    this.awaitingSignature = signature;
    this.hub.sendMachineUpdateRunnerState(this.options.machineId, state, this.stateVersion);
  }

  async sync(timeoutMs: number): Promise<void> {
    await this.ensureConnected();
    this.registeredSignature = null;
    this.awaitingSignature = null;
    this.connectionAdvertisementPending = true;
    this.flush();
    await this.waitForRegistration(timeoutMs);
  }

  async waitForRegistration(timeoutMs: number): Promise<void> {
    const state = this.options.buildState();
    if (!state) {
      throw new Error("Host registration state is not available");
    }

    const signature = this.options.getStateSignature(state);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await this.ensureConnected();
      if (
        !this.connectionAdvertisementPending
        && this.registeredSignature === signature
        && !this.awaitingSignature
      ) {
        return;
      }
      this.flush();
      await sleep(200);
    }

    throw new Error("Timed out waiting for host registration");
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.hub?.close();
    this.hub = null;
    this.stateVersion = null;
    this.awaitingSignature = null;
    this.registeredSignature = null;
    this.connectionAdvertisementPending = true;
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      void this.refreshHeartbeatState();
    }, 30_000);
    if (typeof this.heartbeat === "object" && "unref" in this.heartbeat) {
      this.heartbeat.unref();
    }
  }

  private async refreshHeartbeatState(): Promise<void> {
    if (this.heartbeatRefreshPending) return;
    this.heartbeatRefreshPending = true;
    try {
      await this.options.refreshState?.();
    } catch (error) {
      this.options.onLog?.(
        `Runner health refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.connectionAdvertisementPending = true;
      this.flush();
      this.heartbeatRefreshPending = false;
    }
  }

  private async handleRunnerControlRequest(
    request: RunnerControlRequestMessage,
  ): Promise<void> {
    if (!this.hub) return;

    try {
      const result = await this.executeLocalRunnerRequest(request);
      this.hub.sendRunnerControlResponse(request.requestId, true, result);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      this.hub.sendRunnerControlResponse(
        request.requestId,
        false,
        undefined,
        redactEnvValues(rawMessage, request.envVars ?? {}),
        error instanceof LocalRunnerRequestError ? error.code : undefined,
        error instanceof LocalRunnerRequestError ? error.currentCommandGeneration : undefined,
      );
    }
  }

  private async executeLocalRunnerRequest(
    request: RunnerControlRequestMessage,
  ): Promise<unknown> {
    const baseUrl = `http://127.0.0.1:${this.options.runnerPort}`;
    let response: Response;

    switch (request.action) {
      case "create":
        response = await fetch(`${baseUrl}/envs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: request.slug,
            repoUrl: request.repoUrl,
            envVars: request.envVars ?? {},
            ...(request.commandGeneration !== undefined ? { commandGeneration: request.commandGeneration } : {}),
            ...(request.operationId ? { operationId: request.operationId } : {}),
            ...(request.desiredState ? { desiredState: request.desiredState } : {}),
          }),
        });
        break;
      case "status":
        response = await fetch(`${baseUrl}/envs/${encodeURIComponent(request.slug)}`);
        break;
      case "start":
        response = await fetch(`${baseUrl}/envs/${encodeURIComponent(request.slug)}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: request.repoUrl,
            envVars: request.envVars ?? {},
            ...(request.commandGeneration !== undefined ? { commandGeneration: request.commandGeneration } : {}),
            ...(request.operationId ? { operationId: request.operationId } : {}),
            ...(request.desiredState ? { desiredState: request.desiredState } : {}),
          }),
        });
        break;
      case "stop":
        response = await fetch(`${baseUrl}/envs/${encodeURIComponent(request.slug)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(request.commandGeneration !== undefined ? { commandGeneration: request.commandGeneration } : {}),
            ...(request.operationId ? { operationId: request.operationId } : {}),
            ...(request.desiredState ? { desiredState: request.desiredState } : {}),
          }),
        });
        break;
      case "destroy":
        response = await fetch(`${baseUrl}/envs/${encodeURIComponent(request.slug)}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(request.commandGeneration !== undefined ? { commandGeneration: request.commandGeneration } : {}),
            ...(request.operationId ? { operationId: request.operationId } : {}),
            ...(request.desiredState ? { desiredState: request.desiredState } : {}),
          }),
        });
        break;
    }

    const body = await readResponseBody(response);
    if (!response.ok) {
      const responseCode = body && typeof body === "object" && typeof (body as Record<string, unknown>).code === "string"
        ? (body as Record<string, unknown>).code as RunnerControlErrorCode
        : undefined;
      const recognizedCode = responseCode === "runner_command_superseded_before_mutation"
        || responseCode === "runner_command_superseded"
        || responseCode === "runner_command_conflict"
        || responseCode === "runner_not_found"
        ? responseCode
        : undefined;
      const currentCommandGeneration = body
        && typeof body === "object"
        && Number.isSafeInteger((body as Record<string, unknown>).currentCommandGeneration)
        && ((body as Record<string, unknown>).currentCommandGeneration as number) > 0
        ? (body as Record<string, unknown>).currentCommandGeneration as number
        : undefined;
      throw new LocalRunnerRequestError(
        `${readRunnerErrorPrefix(request.action)}: ${extractErrorMessage(response.status, body)}`,
        recognizedCode
          ?? (response.status === 404 && (request.action === "status" || request.action === "destroy")
            ? "runner_not_found"
            : undefined),
        currentCommandGeneration,
      );
    }

    return body;
  }
}
