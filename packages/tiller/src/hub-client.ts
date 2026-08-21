import { EventEmitter } from "node:events";

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_QUEUED_MESSAGES = 100;
const PONG_TIMEOUT_MS = 90_000; // 90s absolute threshold — within CF's 100s idle timeout
const CONNECT_TIMEOUT_MS = 30_000; // abort and retry if WS doesn't open within 30s

interface HubClientConfig {
  hubUrl: string;
  cfAccessHeaders: Record<string, string>;
}

interface WsServerMessage {
  type: string;
  [key: string]: unknown;
}

type SessionLifecycle = "owner" | "viewer";

interface SetSessionOptions {
  lifecycle?: SessionLifecycle;
}

export interface HubMachine {
  id: string;
  runner_state: string;
  runner_state_version: number;
  [key: string]: unknown;
}

export type RunnerControlErrorCode =
  | "runner_not_found"
  | "runner_command_superseded_before_mutation"
  | "runner_command_superseded"
  | "runner_command_conflict";

export type RunnerCommandDesiredState = "running" | "stopped" | "absent";

export interface RunnerControlRequestMessage {
  type: "runner-control-request";
  requestId: string;
  action: "create" | "status" | "start" | "stop" | "destroy";
  slug: string;
  repoUrl?: string;
  envVars?: Record<string, string>;
  commandGeneration?: number;
  operationId?: string;
  desiredState?: RunnerCommandDesiredState;
}

export interface TerminalCapabilities {
  terminalFastLane: boolean;
}

export interface TerminalInputMessage {
  type: "terminal-input";
  sessionId: string;
  clientId: string;
  inputSeq: number;
  data: string;
  cols?: number;
  rows?: number;
}

export interface TerminalControlMessage {
  type: "terminal-control";
  sessionId: string;
  clientId: string;
  controlSeq: number;
  action: "resize" | "abort";
  cols?: number;
  rows?: number;
  claim?: boolean;
}

export interface TerminalInputAckMessage {
  type: "terminal-input-ack";
  sessionId: string;
  clientId: string;
  inputSeq: number;
  ok: boolean;
  error?: string;
}

export interface TerminalControlAckMessage {
  type: "terminal-control-ack";
  sessionId: string;
  clientId: string;
  controlSeq: number;
  ok: boolean;
  error?: string;
}

export interface HubClientEvents {
  connected: [];
  disconnected: [];
  capabilities: [capabilities: TerminalCapabilities];
  "message-received": [msg: WsServerMessage];
  "terminal-input": [msg: TerminalInputMessage];
  "terminal-control": [msg: TerminalControlMessage];
  "terminal-input-ack": [msg: TerminalInputAckMessage];
  "terminal-control-ack": [msg: TerminalControlAckMessage];
  "permission-created": [permission: unknown];
  "permission-resolved": [permission: unknown];
  "session-updated": [session: unknown];
  "session-deleted": [sessionId: string];
  "machine-updated": [machine: HubMachine];
  "env-status-changed": [slug: string, status: string, message?: string];
  "runner-control-request": [msg: RunnerControlRequestMessage];
  error: [err: Error];
}

export class HubClient extends EventEmitter<HubClientEvents> {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSeq = 0;
  private sessionId: string | null = null;
  private sessionLifecycle: SessionLifecycle = "owner";
  private machineId: string | null = null;
  private terminalFastLane = false;

  // Message queue — ring buffer for messages during disconnect
  private pendingMessages: string[] = [];

  // Pong-based liveness detection
  private lastPongAt = 0;
  private heartbeatCycle = 0;

  constructor(private config: HubClientConfig) {
    super();
  }

  connect(): void {
    this.openWs();
  }

  setSessionId(id: string, options: SetSessionOptions = {}): void {
    this.sessionId = id;
    this.sessionLifecycle = options.lifecycle ?? "owner";
  }

  setMachineId(id: string): void {
    this.machineId = id;
  }

  sendMessage(id: string, sessionId: string, content: unknown): void {
    this.wsSend({ type: "message", id, sessionId, content });
  }

  sendSessionAlive(sessionId: string): void {
    if (this.sessionLifecycle === "viewer") {
      return;
    }
    this.wsSend({ type: "session-alive", sessionId });
  }

  sendSessionEnd(sessionId: string): void {
    this.wsSend({ type: "session-end", sessionId });
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    const id = crypto.randomUUID();
    this.sendMessage(id, sessionId, {
      role: "user",
      type: "resize",
      data: JSON.stringify({ cols, rows }),
    });
  }

  supportsTerminalFastLane(): boolean {
    return this.terminalFastLane;
  }

  sendTerminalInput(
    sessionId: string,
    clientId: string,
    inputSeq: number,
    data: string,
    size?: { cols: number; rows: number },
  ): boolean {
    return this.wsSendLive({
      type: "terminal-input",
      sessionId,
      clientId,
      inputSeq,
      data,
      ...(size ? { cols: size.cols, rows: size.rows } : {}),
    });
  }

  sendTerminalDetach(sessionId: string, clientId: string): boolean {
    return this.wsSendLive({ type: "terminal-detach", sessionId, clientId });
  }

  sendTerminalControl(
    sessionId: string,
    clientId: string,
    controlSeq: number,
    action: "resize" | "abort",
    size?: { cols: number; rows: number },
    options?: { claim?: boolean },
  ): boolean {
    return this.wsSendLive({
      type: "terminal-control",
      sessionId,
      clientId,
      controlSeq,
      action,
      ...(size ? { cols: size.cols, rows: size.rows } : {}),
      ...(options?.claim !== undefined ? { claim: options.claim } : {}),
    });
  }

  sendTerminalInputAck(
    sessionId: string,
    clientId: string,
    inputSeq: number,
    ok: boolean,
    error?: string,
  ): boolean {
    return this.wsSendLive({
      type: "terminal-input-ack",
      sessionId,
      clientId,
      inputSeq,
      ok,
      ...(error ? { error } : {}),
    });
  }

  sendTerminalControlAck(
    sessionId: string,
    clientId: string,
    controlSeq: number,
    ok: boolean,
    error?: string,
  ): boolean {
    return this.wsSendLive({
      type: "terminal-control-ack",
      sessionId,
      clientId,
      controlSeq,
      ok,
      ...(error ? { error } : {}),
    });
  }

  sendMachineAlive(machineId: string): void {
    this.wsSend({ type: "machine-alive", machineId });
  }

  sendMachineUpdateRunnerState(machineId: string, runnerState: unknown, expectedVersion: number): void {
    this.wsSend({ type: "machine-update-runner-state", machineId, runnerState, expectedVersion });
  }

  sendRunnerControlResponse(
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: string,
    errorCode?: RunnerControlErrorCode,
    currentCommandGeneration?: number,
  ): void {
    this.wsSend({
      type: "runner-control-response",
      requestId,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(currentCommandGeneration !== undefined ? { currentCommandGeneration } : {}),
    });
  }

  /** Returns the highest message seq seen so far. */
  getLastSeq(): number {
    return this.lastSeq;
  }

  /** Advance only after the terminal consumer has completed its stdout write. */
  markMessageComplete(seq: number): void {
    if (Number.isInteger(seq) && seq > this.lastSeq) this.lastSeq = seq;
  }

  /** Returns the underlying WebSocket for bufferedAmount checks. */
  getSocket(): WebSocket | null {
    return this.ws;
  }

  close(): void {
    this.closed = true;
    this.terminalFastLane = false;
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.clearConnectTimer();
    this.closeSocket();
  }

  // ── Internal ─────────────────────────────────────────────────────

  private clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(target: WebSocket | null = this.ws): void {
    if (!target) return;
    if (this.ws === target) {
      this.ws = null;
    }
    try {
      target.close();
    } catch {
      // Ignore close failures while tearing down a dead socket.
    }
  }

  private forceReconnect(target: WebSocket | null = this.ws): void {
    this.clearConnectTimer();
    this.stopHeartbeat();
    this.terminalFastLane = false;
    this.closeSocket(target);
    this.emit("disconnected");
    if (!this.closed) {
      this.scheduleReconnect();
    }
  }

  private openWs(): void {
    this.clearReconnectTimer();
    const wsUrl = this.config.hubUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const url = `${wsUrl}/parties/hub/hub`;

    // Node.js WebSocket supports headers option for the upgrade request
    const ws = new WebSocket(url, {
      headers: this.config.cfAccessHeaders,
    } as any);
    this.ws = ws;

    // Abort and retry if the connection doesn't open within the timeout.
    // Without this, a hanging TCP/TLS handshake stalls reconnection forever.
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.CONNECTING) {
        console.error("[tiller] Connect timeout — aborting and retrying");
        this.forceReconnect(ws);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      // No auth message needed — CF Access headers sent on upgrade
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.lastPongAt = Date.now();
      this.heartbeatCycle = 0;
      this.terminalFastLane = false;
      this.startHeartbeat();
      this.drainQueue();
      if (this.machineId) {
        this.sendMachineAlive(this.machineId);
      }
      // Gap-fill is handled via HTTP in attach-client (not WS reconnect)
      this.emit("connected");
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.handleMessage(event.data as string);
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearConnectTimer();
      this.stopHeartbeat();
      this.terminalFastLane = false;
      const reason = (event as any).reason || "";
      console.error(`[tiller] Disconnected (code=${(event as any).code} clean=${(event as any).wasClean}${reason ? ` reason="${reason}"` : ""})`);
      this.emit("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      if (this.ws !== ws) return;
      const msg =
        (event as any).message ||
        (event as any).error?.message ||
        "see close event for details";
      this.emit("error", new Error(`WebSocket error: ${msg}`));
    });
  }

  private handleMessage(raw: string): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "capabilities":
        this.terminalFastLane = msg.terminalFastLane === true;
        this.emit("capabilities", { terminalFastLane: this.terminalFastLane });
        break;

      case "message-received":
        if (!this.isMessageForCurrentSession(msg)) {
          break;
        }
        this.emit("message-received", msg);
        break;

      case "terminal-input":
        if (this.isTerminalMessageForCurrentSession(msg)) {
          this.emit("terminal-input", msg as unknown as TerminalInputMessage);
        }
        break;

      case "terminal-control":
        if (this.isTerminalMessageForCurrentSession(msg)) {
          this.emit("terminal-control", msg as unknown as TerminalControlMessage);
        }
        break;

      case "terminal-input-ack":
        this.emit("terminal-input-ack", msg as unknown as TerminalInputAckMessage);
        break;

      case "terminal-control-ack":
        this.emit("terminal-control-ack", msg as unknown as TerminalControlAckMessage);
        break;

      case "pong":
        this.lastPongAt = Date.now();
        break;

      case "permission-created":
        this.emit("permission-created", msg.permission);
        break;

      case "permission-resolved":
        this.emit("permission-resolved", msg.permission);
        break;

      case "session-updated":
        this.emit("session-updated", msg.session);
        break;

      case "session-deleted":
        this.emit("session-deleted", msg.sessionId as string);
        break;

      case "machine-updated":
        this.emit("machine-updated", msg.machine as HubMachine);
        break;

      case "env-status-changed":
        this.emit("env-status-changed", msg.slug as string, msg.status as string, msg.message as string | undefined);
        break;

      case "runner-control-request":
        this.emit("runner-control-request", msg as unknown as RunnerControlRequestMessage);
        break;

      case "error":
        this.emit("error", new Error(`Hub error: ${msg.message}`));
        break;
    }
  }

  private isMessageForCurrentSession(msg: WsServerMessage): boolean {
    if (msg.type !== "message-received") {
      return false;
    }
    if (!this.sessionId) {
      return true;
    }
    return typeof msg.sessionId === "string" && msg.sessionId === this.sessionId;
  }

  private isTerminalMessageForCurrentSession(msg: WsServerMessage): boolean {
    if (msg.type !== "terminal-input" && msg.type !== "terminal-control") {
      return false;
    }
    // Unlike durable messages, live terminal input must never be handled
    // before this client knows which session it owns.
    if (!this.sessionId) {
      return false;
    }
    return typeof msg.sessionId === "string" && msg.sessionId === this.sessionId;
  }

  private wsSend(data: unknown): void {
    const payload = JSON.stringify(data);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Queue the message for delivery after reconnect
      this.enqueue(payload);
    }
  }

  private wsSendLive(data: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(data));
    return true;
  }

  private enqueue(payload: string): void {
    this.pendingMessages.push(payload);
    // Drop oldest if over capacity
    while (this.pendingMessages.length > MAX_QUEUED_MESSAGES) {
      this.pendingMessages.shift();
    }
  }

  private drainQueue(): void {
    if (this.pendingMessages.length === 0) return;
    while (this.pendingMessages.length > 0) {
      if (this.ws?.readyState !== WebSocket.OPEN) break;
      const payload = this.pendingMessages.shift();
      if (!payload) break;
      this.ws.send(payload);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Pong liveness check — 90s absolute threshold
      if (this.lastPongAt > 0) {
        const sincePong = Date.now() - this.lastPongAt;
        if (sincePong > PONG_TIMEOUT_MS) {
          console.error("[tiller] No pong received — connection dead, reconnecting");
          this.forceReconnect();
          return;
        }
      }

      this.heartbeatCycle++;
      if (this.sessionId && this.sessionLifecycle === "owner" && this.heartbeatCycle % 5 === 0) {
        this.sendSessionAlive(this.sessionId);
      }
      if (this.machineId) {
        this.sendMachineAlive(this.machineId);
      }
      this.wsSend({ type: "ping" });
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    const jitter = this.reconnectDelay * 0.3 * Math.random();
    const delay = Math.round(this.reconnectDelay + jitter);

    console.error(`[tiller] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openWs();
    }, delay);
  }
}
