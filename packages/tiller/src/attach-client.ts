/**
 * `tiller` — connect to a remote Claude Code session via the hub
 * WebSocket and display terminal output in a real terminal.
 *
 * - Live terminal output via stdout (native scrolling, native selection)
 * - Inline permission prompts (a/s/d)
 * - stdin forwarded as user-input messages
 * - Ctrl+C → exit tiller
 * - Ctrl+B → detach back to the picker
 * - Ctrl+] → send abort to the remote session
 * - Does NOT send session-end on detach (session keeps running)
 */

import {
  HubClient,
  type TerminalControlAckMessage,
  type TerminalInputAckMessage,
} from "./hub-client.js";
import {
  HUB_URL,
  hubControlHeaders,
} from "./config.js";
import { ansi } from "./ansi.js";
import { authLabel, envDisplayLabel, pickAndConnect, type StoredSession, type EnvMeta } from "./picker.js";
import {
  CliTerminalRecovery,
  readJsonResponseWithinLimit,
  writeStdoutWithBackpressure,
  type CliDurableMessage,
  type CliRecoveryState,
} from "./terminal-recovery.js";

// ── Types ────────────────────────────────────────────────────────────

interface AttachOpts {
  history?: boolean;
}

interface StoredPermission {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: string;
  status: "pending" | "allowed" | "denied";
  created_at: string;
  resolved_at: string | null;
}

type AttachDisposition = "exit" | "picker";
type TerminalControlAction = "resize" | "abort";

const TERMINAL_ACK_TIMEOUT_MS = 1000;
const TERMINAL_WARNING_COOLDOWN_MS = 2000;

function tillerLog(msg: string): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${msg}\n`);
}

function showAttachControls(): void {
  process.stderr.write(
    `${ansi.bold}[tiller]${ansi.reset} ${ansi.dim}Controls:${ansi.reset} ` +
    `${ansi.cyan}Ctrl+B${ansi.reset} back to picker  ` +
    `${ansi.cyan}Ctrl+]${ansi.reset} abort remote  ` +
    `${ansi.cyan}Ctrl+C${ansi.reset} exit tiller\n`,
  );
}

export class TerminalAckTracker {
  private pendingInputs = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingControls = new Map<number, {
    action: TerminalControlAction;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private warningActive = false;
  private failureWarnedAt: number | null = null;
  private dropWarnedAt: number | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly clientId: string,
  ) {}

  trackInput(inputSeq: number): void {
    const timer = setTimeout(() => {
      // Delete on timeout so a never-acked seq (e.g. across a dropped socket)
      // can't grow the map forever or suppress future warnings.
      this.pendingInputs.delete(inputSeq);
      this.warnOnce("Terminal input is delayed; waiting for the remote session.");
      this.resetWarningIfIdle();
    }, TERMINAL_ACK_TIMEOUT_MS);
    this.pendingInputs.set(inputSeq, timer);
  }

  trackControl(controlSeq: number, action: TerminalControlAction): void {
    const timer = setTimeout(() => {
      this.pendingControls.delete(controlSeq);
      this.warnOnce(action === "resize"
        ? "Terminal resize acknowledgement is delayed; terminal input may still work."
        : "Terminal abort is delayed; waiting for the remote session.");
      this.resetWarningIfIdle();
    }, TERMINAL_ACK_TIMEOUT_MS);
    this.pendingControls.set(controlSeq, { action, timer });
  }

  handleInputAck(ack: TerminalInputAckMessage): void {
    if (ack.sessionId !== this.sessionId || ack.clientId !== this.clientId) return;
    const timer = this.pendingInputs.get(ack.inputSeq);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingInputs.delete(ack.inputSeq);
    if (ack.ok) {
      this.failureWarnedAt = null;
    } else {
      this.warnFailure(`Terminal input failed: ${ack.error ?? "remote session rejected input"}`);
    }
    this.resetWarningIfIdle();
  }

  handleControlAck(ack: TerminalControlAckMessage): void {
    if (ack.sessionId !== this.sessionId || ack.clientId !== this.clientId) return;
    const pending = this.pendingControls.get(ack.controlSeq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingControls.delete(ack.controlSeq);
    if (ack.ok) {
      this.failureWarnedAt = null;
    } else {
      this.warnFailure(`Terminal ${pending.action} failed: ${ack.error ?? "remote session rejected control"}`);
    }
    this.resetWarningIfIdle();
  }

  warnSendFailed(what: string): void {
    const now = Date.now();
    if (this.dropWarnedAt != null && now - this.dropWarnedAt < TERMINAL_WARNING_COOLDOWN_MS) return;
    this.dropWarnedAt = now;
    tillerLog(`${ansi.yellow}Not connected — ${what} dropped.${ansi.reset}`);
  }

  clear(): void {
    for (const timer of this.pendingInputs.values()) {
      clearTimeout(timer);
    }
    for (const pending of this.pendingControls.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingInputs.clear();
    this.pendingControls.clear();
    this.warningActive = false;
    this.failureWarnedAt = null;
  }

  private warnOnce(message: string): void {
    if (this.warningActive) return;
    this.warningActive = true;
    tillerLog(`${ansi.yellow}${message}${ansi.reset}`);
  }

  private resetWarningIfIdle(): void {
    if (this.pendingInputs.size === 0 && this.pendingControls.size === 0) {
      this.warningActive = false;
    }
  }

  // Coalesce failed-ACK logs on a cooldown rather than on empty pending maps:
  // in a no-owner window each failed ACK drains the map immediately, so a
  // drain-based reset would still print one line per keypress.
  private warnFailure(message: string): void {
    const now = Date.now();
    if (this.failureWarnedAt != null && now - this.failureWarnedAt < TERMINAL_WARNING_COOLDOWN_MS) return;
    this.failureWarnedAt = now;
    tillerLog(`${ansi.red}${message}${ansi.reset}`);
  }
}

// ── REST helpers ─────────────────────────────────────────────────────

export function parseTerminalHistoryMessage(
  message: unknown,
  sessionId: string,
): CliDurableMessage {
  if (
    typeof message !== "object" ||
    message === null ||
    !("id" in message) ||
    typeof message.id !== "string" ||
    message.id.length === 0 ||
    !("session_id" in message) ||
    message.session_id !== sessionId ||
    !("content" in message) ||
    typeof message.content !== "string" ||
    !("seq" in message) ||
    !Number.isInteger(message.seq) ||
    (message.seq as number) < 1 ||
    !("local_id" in message) ||
    (message.local_id !== null && typeof message.local_id !== "string") ||
    !("created_at" in message) ||
    typeof message.created_at !== "string"
  ) {
    throw new Error("Invalid terminal history response");
  }

  let content: unknown;
  try {
    content = JSON.parse(message.content);
  } catch {
    throw new Error("Invalid terminal history response");
  }
  const localId = message.local_id;
  return {
    id: message.id,
    sessionId,
    seq: message.seq as number,
    content,
    ...(typeof localId === "string"
      ? { localId }
      : {}),
  };
}

async function fetchMessages(
  hubUrl: string,
  sessionId: string,
  headers: Record<string, string>,
  opts: {
    limit?: number;
    afterSeq?: number;
    maxBytes: number;
    signal: AbortSignal;
    onBytes(receivedBytes: number): void;
  },
): Promise<CliDurableMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.afterSeq != null) params.set("after_seq", String(opts.afterSeq));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages${qs}`, {
    headers,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  const payload = await readJsonResponseWithinLimit(res, opts.maxBytes, opts.onBytes);
  if (!Array.isArray(payload)) throw new Error("Invalid terminal history response");
  return payload.map((message) => parseTerminalHistoryMessage(message, sessionId));
}

async function fetchPendingPermissions(
  hubUrl: string,
  sessionId: string,
  headers: Record<string, string>,
): Promise<StoredPermission[]> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch permissions: ${res.status}`);
  return res.json() as Promise<StoredPermission[]>;
}

async function resolvePermission(
  hubUrl: string,
  sessionId: string,
  permId: string,
  status: string,
  allowForSession: boolean,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions/${permId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ status, allow_for_session: allowForSession }),
  });
  if (!res.ok) throw new Error(`Failed to resolve permission: ${res.status}`);
}

// ── Attach logic ─────────────────────────────────────────────────────

async function attachToSession(
  session: StoredSession,
  env: EnvMeta,
  hubUrl: string,
  headers: Record<string, string>,
  opts: AttachOpts,
): Promise<AttachDisposition> {
  const resolvedAuthLabel = authLabel(env);
  const authSuffix = resolvedAuthLabel ? ` ${ansi.dim}(${resolvedAuthLabel})${ansi.reset}` : "";
  tillerLog(`Attaching to ${ansi.cyan}${session.tag}${ansi.reset} on ${ansi.cyan}${envDisplayLabel(env, true)}${ansi.reset}${authSuffix}`);

  let replayedTerminalOutput = false;
  let detached = false;
  let recoveryState: CliRecoveryState = "recovering";
  let recoveryFaultReported = false;
  let recoveryFallbackAttempted = false;
  let recoveryFallbackPending = false;
  let hubForRecovery: HubClient | null = null;
  let terminalWriteBarrier: Promise<void> = Promise.resolve();
  let inputBuffer = "";
  let inputTimer: ReturnType<typeof setTimeout> | null = null;
  void opts.history; // Cold reconstruction is intentionally bounded to one 200-message tail.

  function discardInputBuffer(): void {
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = null;
    inputBuffer = "";
  }

  const writeTerminal = async (data: string): Promise<void> => {
    const write = writeStdoutWithBackpressure(data);
    terminalWriteBarrier = write.then(() => undefined, () => undefined);
    await write;
  };

  let recovery!: CliTerminalRecovery;

  function createRecovery(): CliTerminalRecovery {
    let controller!: CliTerminalRecovery;
    controller = new CliTerminalRecovery({
      sessionId: session.id,
      fetchPage: async (request) => fetchMessages(
        hubUrl,
        session.id,
        headers,
        request,
      ),
      write: async (message) => {
        const content = message.content as { type?: string; data?: string } | null;
        if (content?.type === "terminal-output" && typeof content.data === "string" && content.data) {
          replayedTerminalOutput = true;
          await writeTerminal(content.data);
        }
      },
      onSequenceComplete: (seq) => hubForRecovery?.markMessageComplete(seq),
      onStateChange: (state, fault) => {
        recoveryState = state;
        if (state !== "ready") discardInputBuffer();
        if (
          state === "fault" &&
          (fault === "overflow" || fault === "deadline") &&
          !recoveryFallbackAttempted &&
          !detached
        ) {
          recoveryFallbackAttempted = true;
          recoveryFallbackPending = true;
          recoveryState = "recovering";
          controller.dispose();
          void restartFromRecentOutput(controller);
          return;
        }
        if (state === "ready" && recoveryFallbackPending) {
          recoveryFallbackPending = false;
          tillerLog(`${ansi.yellow}Showing recent output; older missed output was skipped.${ansi.reset}`);
        }
        if (state === "fault" && !recoveryFaultReported) {
          recoveryFaultReported = true;
          tillerLog(`${ansi.red}Terminal recovery stopped (${fault ?? "unknown"}); reattach to retry.${ansi.reset}`);
        }
      },
    });
    return controller;
  }

  async function restartFromRecentOutput(failed: CliTerminalRecovery): Promise<void> {
    try {
      await terminalWriteBarrier;
      if (detached || recovery !== failed) return;
      await writeTerminal("\x1b[2J\x1b[H");
      if (detached || recovery !== failed) return;
      recovery = createRecovery();
      await recovery.startCold();
    } catch {
      if (detached) return;
      recoveryFallbackPending = false;
      recoveryState = "fault";
      if (!recoveryFaultReported) {
        recoveryFaultReported = true;
        tillerLog(`${ansi.red}Terminal recovery stopped (recent output fallback failed); reattach to retry.${ansi.reset}`);
      }
    }
  }

  recovery = createRecovery();

  tillerLog("Replaying recent output...");
  void recovery.startCold();

  // 3. Check for pending permissions
  let pendingPermission: StoredPermission | null = null;

  void fetchPendingPermissions(hubUrl, session.id, headers)
    .then((perms) => {
      if (detached) return;
      const pending = perms.filter((permission) => permission.status === "pending");
      if (pending.length > 0) {
        pendingPermission = pending[0];
        showPermissionPrompt(pendingPermission);
      }
    })
    .catch(() => undefined);

  // 4. Connect WebSocket
  const hub = new HubClient({ hubUrl, cfAccessHeaders: headers });
  hubForRecovery = hub;
  hub.markMessageComplete?.(recovery.lastSeq);
  hub.setSessionId(session.id, { lifecycle: "viewer" });
  const clientId = crypto.randomUUID();
  const ackTracker = new TerminalAckTracker(session.id, clientId);
  let inputSeq = 0;
  let controlSeq = 0;

  hub.on("connected", () => {
    sendTerminalResize(process.stdout.columns, process.stdout.rows);
    recovery.recover();
  });

  hub.on("error", (err) => {
    tillerLog(`${ansi.red}Hub error: ${err.message}${ansi.reset}`);
  });

  hub.on("capabilities", () => {
    sendTerminalResize(process.stdout.columns, process.stdout.rows);
  });

  hub.on("disconnected", () => {
    // ACKs are live-only; anything in flight when the socket drops will never
    // be acked, so clear pending state instead of leaking timers and warnings.
    ackTracker.clear();
  });

  hub.on("terminal-input-ack", (ack) => {
    ackTracker.handleInputAck(ack);
  });

  hub.on("terminal-control-ack", (ack) => {
    ackTracker.handleControlAck(ack);
  });

  // 5. Handle incoming messages
  hub.on("message-received", (msg) => {
    if (
      typeof msg.id !== "string" ||
      typeof msg.sessionId !== "string" ||
      typeof msg.seq !== "number"
    ) return;
    recovery.acceptLive({
      id: msg.id,
      sessionId: msg.sessionId,
      seq: msg.seq,
      content: msg.content,
      ...(typeof msg.localId === "string" ? { localId: msg.localId } : {}),
    });
  });

  hub.on("permission-created", (perm) => {
    const p = perm as StoredPermission;
    if (p.session_id === session.id && p.status === "pending") {
      pendingPermission = p;
      showPermissionPrompt(p);
    }
  });

  hub.on("permission-resolved", (perm) => {
    const p = perm as StoredPermission;
    if (p.session_id === session.id) {
      if (pendingPermission && pendingPermission.id === p.id) {
        pendingPermission = null;
        tillerLog(`${ansi.dim}Permission ${p.status}.${ansi.reset}`);
      }
    }
  });

  hub.on("session-deleted", (deletedId) => {
    if (deletedId === session.id) {
      tillerLog(`${ansi.red}Session ended by remote.${ansi.reset}`);
      detach("picker");
    }
  });

  hub.connect();

  // 6. Setup stdin handling with input batching
  const INPUT_BATCH_MS = 2; // Minimal batch window — coalesces pastes without delaying keystrokes
  let detachDisposition: AttachDisposition = "exit";
  let onDetach: (value: AttachDisposition) => void;
  const done = new Promise<AttachDisposition>((r) => { onDetach = r; });
  const attachStartedAt = Date.now();
  let userInputPrimed = false;

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Forward terminal resize events to remote PTY
  const onResize = () => {
    if (!detached) {
      sendTerminalResize(process.stdout.columns, process.stdout.rows);
    }
  };
  process.stdout.on("resize", onResize);

  if (!replayedTerminalOutput) {
    tillerLog(`${ansi.green}Connected.${ansi.reset}`);
    showAttachControls();
  }

  function shouldIgnoreInitialTerminalResponse(str: string): boolean {
    if (userInputPrimed) return false;
    if (Date.now() - attachStartedAt > 1500) return false;
    return /^\x1b\[(\?|>)[0-9;]+c$/.test(str);
  }

  // Terminal input/control is fast-lane-only: live sends never queue, and
  // there is deliberately no durable fallback — durable raw input would be
  // queued during a disconnect and replayed stale into the PTY on reconnect.
  function sendTerminalInput(data: string): boolean {
    if (!hub.supportsTerminalFastLane()) {
      ackTracker.warnSendFailed("terminal input");
      return false;
    }
    inputSeq += 1;
    const sent = hub.sendTerminalInput(
      session.id,
      clientId,
      inputSeq,
      data,
      { cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 },
    );
    if (sent) ackTracker.trackInput(inputSeq);
    else ackTracker.warnSendFailed("terminal input");
    return sent;
  }

  function sendTerminalResize(cols: number, rows: number): boolean {
    // Dropped resizes self-heal: the latest size is re-sent when
    // capabilities arrive on (re)connect.
    if (!hub.supportsTerminalFastLane()) return false;
    controlSeq += 1;
    const sent = hub.sendTerminalControl(
      session.id,
      clientId,
      controlSeq,
      "resize",
      { cols, rows },
      { claim: true },
    );
    if (sent) ackTracker.trackControl(controlSeq, "resize");
    return sent;
  }

  function sendTerminalAbort(): boolean {
    if (!hub.supportsTerminalFastLane()) {
      ackTracker.warnSendFailed("abort");
      return false;
    }
    controlSeq += 1;
    const sent = hub.sendTerminalControl(session.id, clientId, controlSeq, "abort");
    if (sent) ackTracker.trackControl(controlSeq, "abort");
    else ackTracker.warnSendFailed("abort");
    return sent;
  }

  function flushInputBuffer(): void {
    if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    if (inputBuffer.length === 0) return;
    if (detached || recoveryState !== "ready") {
      inputBuffer = "";
      return;
    }
    const data = inputBuffer;
    inputBuffer = "";
    const normalized = data.replace(/\n/g, "\r");
    sendTerminalInput(normalized);
  }

  const onData = (data: Buffer) => {
    if (detached) return;
    const str = data.toString();

    if (shouldIgnoreInitialTerminalResponse(str)) {
      return;
    }

    // Single Ctrl+C → detach and exit tiller
    if (str === "\x03") {
      tillerLog("Ctrl+C — exiting");
      detach("exit");
      return;
    }

    // Ctrl+B → detach back to picker
    if (str === "\x02") {
      tillerLog(`${ansi.dim}Ctrl+B — back to picker.${ansi.reset}`);
      detach("picker");
      return;
    }

    // Ctrl+] → send abort to remote session
    if (str === "\x1d") {
      discardInputBuffer();
      if (sendTerminalAbort()) {
        tillerLog(`${ansi.dim}Sent abort to remote session.${ansi.reset}`);
      }
      return;
    }

    // Permission pending — handle a/s/d keys
    if (pendingPermission) {
      const key = str.toLowerCase();
      if (key === "a" || key === "s" || key === "d") {
        const perm = pendingPermission;
        pendingPermission = null;

        const statusMap: Record<string, string> = { a: "allowed", s: "allowed", d: "denied" };
        const allowForSession = key === "s";

        resolvePermission(hubUrl, session.id, perm.id, statusMap[key], allowForSession, headers).catch(
          (err) => tillerLog(`${ansi.red}Failed to resolve permission: ${err instanceof Error ? err.message : String(err)}${ansi.reset}`),
        );
        return;
      }
    }

    if (recoveryState !== "ready") {
      if (recoveryState === "fault" && !recoveryFaultReported) {
        recoveryFaultReported = true;
        tillerLog(`${ansi.red}Terminal recovery is incomplete; reattach before sending input.${ansi.reset}`);
      }
      return;
    }

    userInputPrimed = true;

    // Batch input: collect keystrokes for INPUT_BATCH_MS before sending
    inputBuffer += str;
    if (!inputTimer) {
      inputTimer = setTimeout(flushInputBuffer, INPUT_BATCH_MS);
    }
  };

  // Discard any startup-buffered bytes, then attach the listener
  setImmediate(() => {
    process.stdin.on("data", onData);
  });

  // Wait until detach
  return await done;

  function detach(nextDisposition: AttachDisposition = "exit"): void {
    if (detached) return;
    detached = true;
    detachDisposition = nextDisposition;

    // Detach is a hard boundary: pending ordinary input must not leak through.
    discardInputBuffer();

    // Remove listeners
    process.stdin.removeListener("data", onData);
    process.stdout.removeListener("resize", onResize);

    // Restore terminal
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    // Do NOT send session-end — session keeps running
    // Just close the WebSocket connection
    ackTracker.clear();
    hub.sendTerminalDetach?.(session.id, clientId);
    hub.close();
    recovery.dispose();

    onDetach(detachDisposition);
  }
}

function showPermissionPrompt(perm: StoredPermission): void {
  let toolInput = "";
  try {
    const input = JSON.parse(perm.tool_input);
    if (input.command) {
      toolInput = `$ ${input.command}`;
    } else {
      toolInput = JSON.stringify(input).slice(0, 120);
    }
  } catch {
    toolInput = perm.tool_input.slice(0, 120);
  }

  process.stderr.write(
    `\n${ansi.bold}[tiller]${ansi.reset} ${ansi.yellow}Permission: ${perm.tool_name}${ansi.reset}` +
    (toolInput ? ` wants to run: ${ansi.cyan}${toolInput}${ansi.reset}` : "") +
    `\n${ansi.bold}[tiller]${ansi.reset} ${ansi.dim}[a]llow / [s]ession-allow / [d]eny?${ansi.reset}\n`,
  );
}

// ── CLI entry point ──────────────────────────────────────────────────

export async function runAttach(args: string[]): Promise<void> {
  // Auth is already validated by the entry point in index.ts

  // Parse attach-specific args
  const opts: AttachOpts = {};
  for (const arg of args) {
    if (arg === "--history") opts.history = true;
  }

  tillerLog(`Connecting to ${ansi.cyan}${HUB_URL}${ansi.reset}`);

  while (true) {
    const result = await pickAndConnect(HUB_URL, hubControlHeaders);
    if (!result) {
      tillerLog("No session selected.");
      return;
    }

    const disposition = await attachToSession(result.session, result.env, HUB_URL, hubControlHeaders, opts);
    if (disposition === "exit") {
      return;
    }
  }
}
