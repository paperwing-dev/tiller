import { EventEmitter } from "node:events";

const HEARTBEAT_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const MAX_QUEUED_MESSAGES = 100;
const REPLAY_PAGE_SIZE = 1_000;
const MAX_PENDING_REPLAY_MESSAGES = 4_096;
const MAX_PENDING_REPLAY_BYTES = 8 * 1024 * 1024;
const PONG_TIMEOUT_MS = 90_000; // 90s absolute threshold — within CF's 100s idle timeout

interface HubClientConfig {
  hubUrl: string;
  namespace: string;
  cfAccessHeaders: Record<string, string>;
  wsScope?:
    | { kind: "environment"; envSlug: string; sessionId: string }
    | { kind: "planWriter"; repoId: string; planArtifactId: string; generation: number; sessionId: string };
}

interface WsServerMessage {
  type: string;
  [key: string]: unknown;
}

interface PendingReplayEvent {
  message: WsServerMessage;
  fingerprint: string;
  bytes: number;
}

interface PendingReplayRegistration {
  socket: WebSocket;
  sessionId: string;
  registrationId: string;
  cursor: number;
  bySeq: Map<number, PendingReplayEvent>;
  seqById: Map<string, number>;
  bytes: number;
}

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const child = normalize((candidate as Record<string, unknown>)[key]);
        if (child !== undefined) normalized[key] = child;
      }
      return normalized;
    }
    return candidate;
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

function replayFingerprint(message: WsServerMessage): string {
  return stableJson({
    id: message.id,
    sessionId: message.sessionId,
    seq: message.seq,
    content: message.content,
    localId: message.localId ?? null,
  });
}

export interface TerminalInputMessage {
  type: "terminal-input";
  sessionId: string;
  clientId: string;
  inputSeq: number;
  data: string;
  deliveryId?: string;
  cols?: number;
  rows?: number;
  /** Set only by Hub after controller authorization. */
  applyDimensions?: boolean;
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

export interface EnvReviewSnapshotRequestMessage {
  type: "env-review-snapshot-request";
  sessionId: string;
  opId: string;
  envSlug: string;
  uploadUrl: string;
  uploadToken: string;
  snapshotMode: "github-overlay" | "full";
  maxBytes: number;
  excludePrefixes: string[];
}

export interface HubClientEvents {
  connected: [];
  disconnected: [];
  "message-received": [msg: WsServerMessage];
  "terminal-input": [msg: TerminalInputMessage];
  "terminal-control": [msg: TerminalControlMessage];
  "env-review-snapshot-request": [msg: EnvReviewSnapshotRequestMessage];
  "permission-created": [permission: unknown];
  "permission-resolved": [permission: unknown];
  "session-updated": [session: unknown];
  "session-deleted": [sessionId: string];
  "env-status-changed": [slug: string, status: string, message?: string];
  error: [err: Error];
}

export class HubClient extends EventEmitter<HubClientEvents> {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private lastSeq = 0;
  private sessionId: string | null = null;
  private hasReplayBaseline = false;
  private baselineRegistrationCounter = 0;
  private replayRegistrationCounter = 0;
  private pendingBaselineRegistration: {
    socket: WebSocket;
    sessionId: string;
    registrationId: string;
  } | null = null;
  private pendingReplayRegistration: PendingReplayRegistration | null = null;
  private replayFaultedSocket: WebSocket | null = null;

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

  setSessionId(id: string): void {
    if (id === this.sessionId) return;
    this.lastSeq = 0;
    this.hasReplayBaseline = false;
    this.pendingBaselineRegistration = null;
    this.pendingReplayRegistration = null;
    this.replayFaultedSocket = null;
    this.sessionId = id;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendReconnectRegistration(this.ws);
    }
  }

  sendMessage(id: string, sessionId: string, content: unknown): void {
    this.wsSend({ type: "message", id, sessionId, content });
  }

  sendSessionAlive(sessionId: string): void {
    this.wsSend({ type: "session-alive", sessionId });
  }

  sendSessionEnd(sessionId: string): void {
    this.wsSend({ type: "session-end", sessionId });
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

  /**
   * Send an agent state update for a session (phase/activity — Scion pattern).
   * Agent state has its own version counter separate from metadata.
   */
  sendUpdateAgentState(sessionId: string, agentState: Record<string, unknown>, expectedVersion: number): void {
    this.wsSend({ type: "update-agent-state", sessionId, agentState, expectedVersion });
  }

  /** Returns the underlying WebSocket for bufferedAmount checks. */
  getSocket(): WebSocket | null {
    return this.ws;
  }

  close(): void {
    this.closed = true;
    this.pendingBaselineRegistration = null;
    this.pendingReplayRegistration = null;
    this.replayFaultedSocket = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────

  private openWs(): void {
    const wsUrl = this.config.hubUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");
    const url = new URL(`${wsUrl}/parties/hub/${this.config.namespace}`);
    const scope = this.config.wsScope;
    if (scope) {
      url.searchParams.set("sessionId", scope.sessionId);
      if (scope.kind === "environment") {
        url.searchParams.set("envSlug", scope.envSlug);
      } else {
        url.searchParams.set("repoId", scope.repoId);
        url.searchParams.set("planArtifactId", scope.planArtifactId);
        url.searchParams.set("generation", String(scope.generation));
      }
    }

    // Node.js WebSocket supports headers option for the upgrade request
    const ws = new WebSocket(url, {
      headers: this.config.cfAccessHeaders,
    } as any);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (ws !== this.ws) {
        ws.close();
        return;
      }
      // No auth message needed — CF Access headers sent on upgrade
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.replayFaultedSocket = null;
      this.lastPongAt = Date.now();
      this.heartbeatCycle = 0;
      this.startHeartbeat();
      // Register the live terminal-operation capability before any queued
      // traffic can be delivered to this exact harness owner.
      this.sendReconnectRegistration(ws);
      this.drainQueue();
      this.emit("connected");
    });

    ws.addEventListener("message", (event) => {
      if (ws !== this.ws) return;
      this.handleMessage(event.data as string, ws);
    });

    ws.addEventListener("close", (event) => {
      if (ws !== this.ws) return;
      this.ws = null;
      if (this.pendingBaselineRegistration?.socket === ws) {
        this.pendingBaselineRegistration = null;
      }
      if (this.pendingReplayRegistration?.socket === ws) {
        this.pendingReplayRegistration = null;
      }
      if (this.replayFaultedSocket === ws) {
        this.replayFaultedSocket = null;
      }
      this.stopHeartbeat();
      const reason = (event as any).reason || "";
      console.error(`[tiller] Disconnected (code=${(event as any).code} clean=${(event as any).wasClean}${reason ? ` reason="${reason}"` : ""})`);
      this.emit("disconnected");
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      if (ws !== this.ws) return;
      const msg =
        (event as any).message ||
        (event as any).error?.message ||
        "see close event for details";
      this.emit("error", new Error(`WebSocket error: ${msg}`));
    });
  }

  private sendReconnectRegistration(ws: WebSocket): void {
    const sessionId = this.sessionId;
    if (ws !== this.ws || ws.readyState !== WebSocket.OPEN || !sessionId) return;

    if (this.hasReplayBaseline) {
      this.pendingBaselineRegistration = null;
      const pending: PendingReplayRegistration = {
        socket: ws,
        sessionId,
        registrationId: "",
        cursor: this.lastSeq,
        bySeq: new Map(),
        seqById: new Map(),
        bytes: 0,
      };
      this.pendingReplayRegistration = pending;
      this.sendReplayPageRegistration(pending);
      return;
    }

    this.pendingReplayRegistration = null;
    const registrationId = `baseline-${++this.baselineRegistrationCounter}`;
    this.pendingBaselineRegistration = { socket: ws, sessionId, registrationId };
    ws.send(JSON.stringify({
      type: "reconnect",
      lastSeq: this.lastSeq,
      sessionId,
      revive: true,
      replay: false,
      registrationId,
      terminalOperationProtocol: 1,
    }));
  }

  private handleMessage(raw: string, source: WebSocket): void {
    let msg: WsServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case "capabilities":
        break;

      case "message-received":
        if (this.replayFaultedSocket === source) break;
        if (!this.isMessageForCurrentSession(msg)) {
          break;
        }
        if (this.pendingReplayRegistration?.socket === source) {
          this.queuePendingReplayEvent(this.pendingReplayRegistration, msg, source);
          break;
        }
        this.dispatchDurableMessage(msg);
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

      case "env-review-snapshot-request":
        if (this.isEnvReviewSnapshotRequestForCurrentSession(msg)) {
          this.emit("env-review-snapshot-request", msg as unknown as EnvReviewSnapshotRequestMessage);
        }
        break;

      case "replay":
        if (this.replayFaultedSocket === source) break;
        if (!this.hasReplayBaseline) {
          const pending = this.pendingBaselineRegistration;
          const validBaseline = pending !== null &&
            pending.socket === source &&
            pending.sessionId === this.sessionId &&
            msg.sessionId === pending.sessionId &&
            msg.registrationId === pending.registrationId &&
            typeof msg.baselineSeq === "number" &&
            Number.isInteger(msg.baselineSeq) &&
            msg.baselineSeq >= 0 &&
            Array.isArray(msg.events) &&
            msg.events.length === 0;
          if (!validBaseline) break;
          if ((msg.baselineSeq as number) > this.lastSeq) {
            this.lastSeq = msg.baselineSeq as number;
          }
          this.hasReplayBaseline = true;
          this.pendingBaselineRegistration = null;
          break;
        }
        this.handleReplayPage(msg, source);
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

      case "env-status-changed":
        this.emit("env-status-changed", msg.slug as string, msg.status as string, msg.message as string | undefined);
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

  private isValidDurableMessage(msg: WsServerMessage): boolean {
    return this.isMessageForCurrentSession(msg) &&
      typeof msg.id === "string" &&
      msg.id.length > 0 &&
      typeof msg.seq === "number" &&
      Number.isInteger(msg.seq) &&
      msg.seq > 0;
  }

  private dispatchDurableMessage(msg: WsServerMessage): void {
    if (!this.isValidDurableMessage(msg)) return;
    const seq = msg.seq as number;
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.emit("message-received", msg);
  }

  private sendReplayPageRegistration(pending: PendingReplayRegistration): void {
    if (
      pending !== this.pendingReplayRegistration ||
      pending.socket !== this.ws ||
      pending.socket.readyState !== WebSocket.OPEN ||
      pending.sessionId !== this.sessionId
    ) return;

    const registrationId = `replay-${++this.replayRegistrationCounter}`;
    pending.registrationId = registrationId;
    pending.cursor = this.lastSeq;
    try {
      pending.socket.send(JSON.stringify({
        type: "reconnect",
        lastSeq: pending.cursor,
        sessionId: pending.sessionId,
        revive: true,
        replay: true,
        registrationId,
        terminalOperationProtocol: 1,
      }));
    } catch {
      this.failReplay(pending.socket);
    }
  }

  private queuePendingReplayEvent(
    pending: PendingReplayRegistration,
    message: WsServerMessage,
    source: WebSocket,
  ): boolean {
    if (!this.isValidDurableMessage(message)) {
      this.failReplay(source);
      return false;
    }
    const seq = message.seq as number;
    const id = message.id as string;
    if (seq <= pending.cursor) return true;

    const fingerprint = replayFingerprint(message);
    const sameSeq = pending.bySeq.get(seq);
    if (sameSeq) {
      if (sameSeq.fingerprint !== fingerprint) {
        this.failReplay(source);
        return false;
      }
      return true;
    }
    const existingSeq = pending.seqById.get(id);
    if (existingSeq !== undefined) {
      const existing = pending.bySeq.get(existingSeq);
      if (!existing || existing.fingerprint !== fingerprint) {
        this.failReplay(source);
        return false;
      }
      return true;
    }

    const bytes = new TextEncoder().encode(fingerprint).byteLength;
    if (
      pending.bySeq.size + 1 > MAX_PENDING_REPLAY_MESSAGES ||
      pending.bytes + bytes > MAX_PENDING_REPLAY_BYTES
    ) {
      this.failReplay(source);
      return false;
    }
    pending.bySeq.set(seq, { message, fingerprint, bytes });
    pending.seqById.set(id, seq);
    pending.bytes += bytes;
    return true;
  }

  private handleReplayPage(msg: WsServerMessage, source: WebSocket): void {
    const pending = this.pendingReplayRegistration;
    if (
      !pending ||
      pending.socket !== source ||
      pending.sessionId !== this.sessionId ||
      msg.sessionId !== pending.sessionId ||
      msg.registrationId !== pending.registrationId
    ) return;
    if (!Array.isArray(msg.events) || msg.events.length > REPLAY_PAGE_SIZE) {
      this.failReplay(source);
      return;
    }

    let expectedSeq = pending.cursor + 1;
    for (const event of msg.events as WsServerMessage[]) {
      if (!this.isValidDurableMessage(event) || event.seq !== expectedSeq) {
        this.failReplay(source);
        return;
      }
      if (!this.queuePendingReplayEvent(pending, event, source)) return;
      expectedSeq += 1;
    }

    for (const event of msg.events as WsServerMessage[]) {
      const seq = event.seq as number;
      const queued = pending.bySeq.get(seq);
      if (!queued) {
        this.failReplay(source);
        return;
      }
      pending.bySeq.delete(seq);
      pending.seqById.delete(queued.message.id as string);
      pending.bytes -= queued.bytes;
      pending.cursor = seq;
      this.lastSeq = seq;
      this.emit("message-received", queued.message);
    }

    if (msg.events.length === REPLAY_PAGE_SIZE) {
      this.sendReplayPageRegistration(pending);
      return;
    }
    if (pending.bySeq.size > 0) {
      this.failReplay(source);
      return;
    }
    this.pendingReplayRegistration = null;
  }

  private failReplay(source: WebSocket): void {
    if (this.pendingReplayRegistration?.socket === source) {
      this.pendingReplayRegistration = null;
    }
    this.replayFaultedSocket = source;
    console.error("[tiller] Invalid reconnect replay response; reconnecting");
    if (source === this.ws) source.close();
  }

  private isTerminalMessageForCurrentSession(msg: WsServerMessage): boolean {
    if (msg.type !== "terminal-input" && msg.type !== "terminal-control") {
      return false;
    }
    // Unlike durable messages, live terminal input must never reach a PTY
    // before this client knows which session it owns.
    if (!this.sessionId) {
      return false;
    }
    return typeof msg.sessionId === "string" && msg.sessionId === this.sessionId;
  }

  private isEnvReviewSnapshotRequestForCurrentSession(msg: WsServerMessage): boolean {
    if (msg.type !== "env-review-snapshot-request") {
      return false;
    }
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
          this.ws?.close();
          return;
        }
      }

      this.heartbeatCycle++;
      if (this.sessionId && this.heartbeatCycle % 5 === 0) {
        this.sendSessionAlive(this.sessionId);
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
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    const jitter = this.reconnectDelay * 0.3 * Math.random();
    const delay = Math.round(this.reconnectDelay + jitter);

    console.error(`[tiller] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.openWs();
    }, delay);
  }
}
