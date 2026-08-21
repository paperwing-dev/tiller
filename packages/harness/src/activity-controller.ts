import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
  parseCodexLifecycleDiagnostic,
  type CodexLifecycleDiagnostic,
  type HarnessActivityTransitionDiagnostic,
  type HarnessDiagnosticSink,
} from "./runtime-diagnostics.js";

export const DEFAULT_HARNESS_CONTROL_SOCKET_PATH = "/tmp/tiller-harness-control.sock";

export interface RuntimeActivityState {
  status: "working" | "idle";
  idleSince: number | null;
}

export type RuntimeActivitySignal = RuntimeActivityState["status"] | "completed";

export interface IdleStopClaimResult extends RuntimeActivityState {
  eligible: boolean;
  remainingIdleMs: number;
  reason:
    | "eligible"
    | "working"
    | "insufficient_idle"
    | "claim_superseded"
    | "released";
  claimId?: string;
  claimReleased?: boolean;
}

export class HarnessInputFencedError extends Error {
  constructor() {
    super("Environment is preparing to stop; input was not accepted.");
    this.name = "HarnessInputFencedError";
  }
}

interface ActivityControllerEvents {
  activity: [state: RuntimeActivityState];
  completion: [sequence: number];
}

interface ActivityControllerOptions {
  socketPath?: string;
  now?: () => number;
  diagnosticSink?: HarnessDiagnosticSink;
  diagnosticTimestamp?: () => string;
}

interface ActivityRequestBody {
  state?: unknown;
  generation?: unknown;
}

interface ActivityDiagnosticRequestBody {
  diagnostic?: unknown;
  generation?: unknown;
}

interface IdleStopRequestBody {
  action?: unknown;
  idleTimeoutMs?: unknown;
  claimId?: unknown;
}

interface ManualStopRequestBody {
  opId?: unknown;
  replaceOpId?: unknown;
}

type ManualQuiesceHandler = (opId: string) => void | Promise<void>;

class ManualStopConflictError extends Error {
  readonly ownerOpId: string;

  constructor(message: string, ownerOpId: string) {
    super(message);
    this.name = "ManualStopConflictError";
    this.ownerOpId = ownerOpId;
  }
}

const MAX_REQUEST_BYTES = 16 * 1024;

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString();
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error("Harness control request is too large");
    }
  }
  if (!body.trim()) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Harness control request must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class InteractiveActivityController extends EventEmitter<ActivityControllerEvents> {
  readonly socketPath: string;
  private readonly now: () => number;
  private readonly diagnosticSink: HarnessDiagnosticSink | null;
  private readonly diagnosticTimestamp: () => string;
  private state: RuntimeActivityState = { status: "working", idleSince: null };
  private generation: string | null = null;
  private providerCompletionArmed = false;
  private completionSequence = 0;
  private inputFenceClaimId: string | null = null;
  private manualStopOpId: string | null = null;
  private manualQuiesceHandler: ManualQuiesceHandler | null = null;
  private manualQuiesceInFlight: Promise<void> | null = null;
  private queueTail: Promise<void> = Promise.resolve();
  private server: http.Server | null = null;

  constructor(options: ActivityControllerOptions = {}) {
    super();
    this.socketPath = options.socketPath ?? DEFAULT_HARNESS_CONTROL_SOCKET_PATH;
    this.now = options.now ?? Date.now;
    this.diagnosticSink = options.diagnosticSink ?? null;
    this.diagnosticTimestamp = options.diagnosticTimestamp ?? (() => new Date().toISOString());
  }

  snapshot(): RuntimeActivityState {
    return { ...this.state };
  }

  setManualQuiesceHandler(handler: ManualQuiesceHandler): void {
    this.manualQuiesceHandler = handler;
  }

  waitForIdle(timeoutMs: number): Promise<void> {
    if (this.state.status === "idle") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onActivity = (state: RuntimeActivityState) => {
        if (state.status !== "idle") return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for the active agent turn to become idle."));
      }, Math.max(1, timeoutMs));
      const cleanup = () => {
        clearTimeout(timer);
        this.off("activity", onActivity);
      };
      this.on("activity", onActivity);
    });
  }

  async quiesceForManualStop(options: {
    gracefulTimeoutMs: number;
    terminationTimeoutMs: number;
    terminate: () => void | Promise<void>;
  }): Promise<void> {
    try {
      await this.waitForIdle(options.gracefulTimeoutMs);
      return;
    } catch {
      await options.terminate();
      try {
        await this.waitForIdle(options.terminationTimeoutMs);
      } catch {
        throw new Error("Timed out waiting for the agent process to exit after forced termination.");
      }
    }
  }

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(dirname(this.socketPath), { recursive: true });
    rmSync(this.socketPath, { force: true });
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    chmodSync(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(this.socketPath, { force: true });
  }

  beginGeneration(generation: string): Promise<void> {
    return this.enqueue(async () => {
      this.generation = generation;
      this.providerCompletionArmed = false;
      this.setWorking("generation_started");
    });
  }

  reportActivity(
    status: RuntimeActivitySignal,
    generation: string | null,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      if (!generation || generation !== this.generation) return false;
      if (status === "working") {
        this.providerCompletionArmed = true;
        this.setWorking("provider_working");
      } else {
        if (!this.providerCompletionArmed) {
          // Duplicate completion is harmless, but a completion that arrives
          // after newer accepted input must not make that new turn look idle.
          return true;
        }
        this.providerCompletionArmed = false;
        this.setIdle(status === "completed" ? "provider_completed" : "provider_idle");
        if (status === "completed") {
          this.completionSequence += 1;
          this.emit("completion", this.completionSequence);
        }
      }
      return true;
    });
  }

  reportProcessExit(generation: string | null): Promise<boolean> {
    return this.enqueue(async () => {
      if (!generation || generation !== this.generation) return false;
      this.providerCompletionArmed = false;
      this.setIdle("provider_exit");
      return true;
    });
  }

  reportDiagnostic(
    diagnostic: CodexLifecycleDiagnostic,
    generation: string | null,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      if (!generation || generation !== this.generation) return false;
      try {
        this.diagnosticSink?.(diagnostic);
      } catch {
        // Diagnostics must never influence lifecycle behavior.
      }
      return true;
    });
  }

  async deliverInput(operation: () => void | Promise<void>): Promise<void> {
    let delivery: void | Promise<void>;
    await this.enqueue(() => {
      if (this.inputFenceClaimId || this.manualStopOpId) throw new HarnessInputFencedError();
      this.providerCompletionArmed = false;
      this.setWorking("input_accepted");
      delivery = operation();
    });
    await delivery!;
  }

  claimIdleStop(idleTimeoutMs: number): Promise<IdleStopClaimResult> {
    return this.enqueue(async () => {
      const timeout = Math.max(1, Math.floor(idleTimeoutMs));
      if (this.manualStopOpId) {
        return this.claimResult(false, timeout, "claim_superseded");
      }
      if (this.inputFenceClaimId) {
        // A lost response must not orphan the fence forever. Repeating a claim
        // while the same idle fence is intact returns the same token, allowing
        // stop-control to safely resume or replay its strict-sync preflight.
        return this.claimResult(true, 0, "eligible", this.inputFenceClaimId);
      }
      if (this.state.status !== "idle" || this.state.idleSince == null) {
        return this.claimResult(false, timeout, "working");
      }
      const elapsed = Math.max(0, this.now() - this.state.idleSince);
      const remaining = Math.max(0, timeout - elapsed);
      if (remaining > 0) {
        return this.claimResult(false, remaining, "insufficient_idle");
      }
      const claimId = crypto.randomUUID();
      this.inputFenceClaimId = claimId;
      return this.claimResult(true, 0, "eligible", claimId);
    });
  }

  confirmIdleStop(claimId: string): Promise<IdleStopClaimResult> {
    return this.enqueue(async () => {
      const eligible = Boolean(
        claimId
        && claimId === this.inputFenceClaimId
        && this.state.status === "idle"
        && this.state.idleSince != null,
      );
      return this.claimResult(
        eligible,
        0,
        eligible ? "eligible" : "claim_superseded",
        eligible ? claimId : undefined,
      );
    });
  }

  releaseIdleStop(claimId: string): Promise<IdleStopClaimResult> {
    return this.enqueue(async () => {
      const claimReleased = Boolean(claimId && claimId === this.inputFenceClaimId);
      if (claimReleased) {
        this.inputFenceClaimId = null;
      }
      return {
        ...this.claimResult(false, 0, "released"),
        claimReleased,
      };
    });
  }

  async prepareManualStop(
    opId: string,
    replaceOpId?: string,
  ): Promise<RuntimeActivityState & { opId: string }> {
    const normalizedOpId = opId.trim();
    const normalizedReplaceOpId = replaceOpId?.trim() ?? "";
    if (!normalizedOpId) throw new TypeError("opId is required");
    let quiescence!: Promise<void>;
    await this.enqueue(() => {
      if (this.manualStopOpId && this.manualStopOpId !== normalizedOpId) {
        if (normalizedReplaceOpId !== this.manualStopOpId) {
          throw new ManualStopConflictError(
            "A different Stop operation already owns the input fence.",
            this.manualStopOpId,
          );
        }
      }
      this.manualStopOpId = normalizedOpId;
      this.inputFenceClaimId = null;
      if (this.manualQuiesceInFlight) {
        quiescence = this.manualQuiesceInFlight;
        return;
      }
      const handler = this.manualQuiesceHandler;
      const run = Promise.resolve().then(async () => {
        if (!handler) throw new Error("Manual Stop quiescence is unavailable.");
        await handler(normalizedOpId);
      });
      let tracked: Promise<void>;
      tracked = run.finally(() => {
        void this.enqueue(() => {
          if (this.manualQuiesceInFlight === tracked) this.manualQuiesceInFlight = null;
        });
      });
      this.manualQuiesceInFlight = tracked;
      quiescence = tracked;
    });
    await quiescence;
    return { ...this.snapshot(), opId: normalizedOpId };
  }

  private setWorking(source: HarnessActivityTransitionDiagnostic["source"]): void {
    const previous = this.snapshot();
    this.inputFenceClaimId = null;
    this.state = { status: "working", idleSince: null };
    this.emitActivityDiagnostic(source, previous);
    this.emit("activity", this.snapshot());
  }

  private setIdle(source: HarnessActivityTransitionDiagnostic["source"]): void {
    if (this.state.status === "idle" && this.state.idleSince != null) return;
    const previous = this.snapshot();
    this.state = { status: "idle", idleSince: this.now() };
    this.emitActivityDiagnostic(source, previous);
    this.emit("activity", this.snapshot());
  }

  private emitActivityDiagnostic(
    source: HarnessActivityTransitionDiagnostic["source"],
    previous: RuntimeActivityState,
  ): void {
    if (!this.diagnosticSink) return;
    try {
      this.diagnosticSink({
        component: "harness_activity",
        event: "activity_transition",
        generation: this.generation,
        source,
        accepted: true,
        previous,
        current: this.snapshot(),
        timestamp: this.diagnosticTimestamp(),
      });
    } catch {
      // Diagnostics must never influence lifecycle behavior.
    }
  }

  private claimResult(
    eligible: boolean,
    remainingIdleMs: number,
    reason: IdleStopClaimResult["reason"],
    claimId?: string,
  ): IdleStopClaimResult {
    return {
      ...this.snapshot(),
      eligible,
      remainingIdleMs: Math.max(0, Math.ceil(remainingIdleMs)),
      reason,
      ...(claimId ? { claimId } : {}),
    };
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queueTail.then(operation, operation);
    this.queueTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      jsonResponse(res, 404, { ok: false, error: "Not found" });
      return;
    }
    try {
      if (req.url === "/activity") {
        const body = await readJsonBody(req) as ActivityRequestBody;
        if (body.state !== "working" && body.state !== "idle" && body.state !== "completed") {
          jsonResponse(res, 400, { ok: false, error: "Invalid activity state" });
          return;
        }
        const accepted = await this.reportActivity(
          body.state,
          typeof body.generation === "string" ? body.generation : null,
        );
        jsonResponse(res, 200, { ok: true, accepted, ...this.snapshot() });
        return;
      }
      if (req.url === "/diagnostic") {
        const body = await readJsonBody(req) as ActivityDiagnosticRequestBody;
        const diagnostic = parseCodexLifecycleDiagnostic(body.diagnostic);
        if (!diagnostic) {
          jsonResponse(res, 400, { ok: false, error: "Invalid runtime diagnostic" });
          return;
        }
        const accepted = await this.reportDiagnostic(
          diagnostic,
          typeof body.generation === "string" ? body.generation : null,
        );
        jsonResponse(res, 200, { ok: true, accepted });
        return;
      }
      if (req.url === "/prepare-idle-stop") {
        const body = await readJsonBody(req) as IdleStopRequestBody;
        const action = body.action ?? "claim";
        if (action === "claim") {
          if (typeof body.idleTimeoutMs !== "number" || !Number.isFinite(body.idleTimeoutMs) || body.idleTimeoutMs <= 0) {
            jsonResponse(res, 400, { ok: false, error: "idleTimeoutMs must be positive" });
            return;
          }
          jsonResponse(res, 200, { ok: true, ...(await this.claimIdleStop(body.idleTimeoutMs)) });
          return;
        }
        const claimId = typeof body.claimId === "string" ? body.claimId : "";
        if (!claimId) {
          jsonResponse(res, 400, { ok: false, error: "claimId is required" });
          return;
        }
        if (action === "confirm") {
          jsonResponse(res, 200, { ok: true, ...(await this.confirmIdleStop(claimId)) });
          return;
        }
        if (action === "release") {
          jsonResponse(res, 200, { ok: true, ...(await this.releaseIdleStop(claimId)) });
          return;
        }
        jsonResponse(res, 400, { ok: false, error: "Invalid idle-stop action" });
        return;
      }
      if (req.url === "/prepare-stop") {
        const body = await readJsonBody(req) as ManualStopRequestBody;
        const opId = typeof body.opId === "string" ? body.opId : "";
        const replaceOpId = typeof body.replaceOpId === "string" ? body.replaceOpId : undefined;
        if (!opId.trim()) {
          jsonResponse(res, 400, { ok: false, error: "opId is required" });
          return;
        }
        const result = await this.prepareManualStop(opId, replaceOpId);
        jsonResponse(res, 200, { ok: true, ...result });
        return;
      }
      jsonResponse(res, 404, { ok: false, error: "Not found" });
    } catch (error) {
      const stopConflict = error instanceof ManualStopConflictError ? error : null;
      jsonResponse(res, stopConflict ? 409 : 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(stopConflict
          ? { code: "manual_stop_conflict", ownerOpId: stopConflict.ownerOpId }
          : {}),
      });
    }
  }
}
