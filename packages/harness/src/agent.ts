import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import {
  bufferOrEmitExit,
  bufferOrEmitOutput,
  createEarlyAgentEventState,
  flushBufferedExit,
  flushBufferedOutput,
} from "./early-events.js";
import {
  DEFAULT_OUTPUT_FLUSH_POLICY,
  decideOutputFlush,
  type OutputFlushPolicy,
} from "./output-flush-policy.js";
import {
  TerminalOperationQueue,
  type TerminalDimensions,
  type TerminalInputFragment,
} from "./terminal-operations.js";
import { TerminalMetricRecorder } from "./terminal-metrics.js";
import { sanitizeClaudeChildEnvironment } from "./claude-environment.js";
import { sanitizeCodexChildEnvironment } from "./codex-app-server-client.js";

/** Strip env vars that prevent Claude from launching inside our PTY. */
export function cleanEnvForAgent(extraEnv?: Record<string, string>, inheritEnv = true): Record<string, string> {
  const env = { ...(inheritEnv ? process.env : {}), ...extraEnv } as Record<string, string>;
  if (env.TILLER_HARNESS === "claude-code" || env.TILLER_CLAUDE_AUTH_RESOLVED_MODE) {
    return sanitizeClaudeChildEnvironment(env);
  }
  if (
    env.TILLER_HARNESS === "codex"
    && !(env.TILLER_CODEX_RUNTIME_MODE === "app-server" && env.TILLER_CODEX_AUTH_MODE === "subscription")
  ) {
    return sanitizeCodexChildEnvironment(env, {
      authMode: "api-key",
      githubRepoAccess: true,
    });
  }
  return env;
}

function resolveCommand(command: string): string {
  try {
    return execSync(`which ${command}`, { encoding: 'utf-8' }).trim();
  } catch {
    return command;
  }
}

export interface AgentEvents {
  output: [data: string];
  exit: [code: number];
}

export class Agent extends EventEmitter<AgentEvents> {
  private ptyProcess: pty.IPty;
  private terminalOperations: TerminalOperationQueue;
  private outputBuffer = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimerDueAtMs: number | null = null;
  private outputBufferStartedAtMs: number | null = null;
  private lastOutputAtMs: number | null = null;
  private inputEchoUntilMs = 0;
  private earlyEvents = createEarlyAgentEventState();
  private readonly stdoutResizeHandler: () => void;
  private readonly terminalMetrics = new TerminalMetricRecorder();
  private readonly outputFlushPolicy: OutputFlushPolicy;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
    options: {
      inheritEnv?: boolean;
      uid?: number;
      gid?: number;
      outputFlushPolicy?: OutputFlushPolicy;
    } = {},
  ) {
    super();
    this.outputFlushPolicy = options.outputFlushPolicy ?? DEFAULT_OUTPUT_FLUSH_POLICY;

    // Match PTY size to actual terminal so cursor positions align
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;

    this.ptyProcess = pty.spawn(resolveCommand(command), args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: cleanEnvForAgent(extraEnv, options.inheritEnv !== false),
      ...(options.uid !== undefined ? { uid: options.uid } : {}),
      ...(options.gid !== undefined ? { gid: options.gid } : {}),
    });

    this.terminalOperations = new TerminalOperationQueue(
      {
        write: (data) => this.ptyProcess.write(data),
        resize: (nextCols, nextRows) => this.ptyProcess.resize(nextCols, nextRows),
        pauseOutput: () => this.ptyProcess.pause(),
        resumeOutput: () => this.ptyProcess.resume(),
      },
      { cols, rows },
      {
        onFilteredOutput: (data) => this.handleFilteredOutput(data),
        onHeadlessParse: (durationMs, bytes) => this.terminalMetrics.record(
          "headless_parse",
          durationMs,
          bytes,
        ),
        onInputWrite: (durationMs, bytes) => this.terminalMetrics.record(
          "input_enqueue_to_pty_write",
          durationMs,
          bytes,
        ),
        onQueueDepth: (depth) => this.terminalMetrics.observeQueueDepth(depth),
        onParserBacklog: (bytes) => this.terminalMetrics.observeParserBacklog(bytes),
      },
    );

    (this as EventEmitter).on("newListener", (event: string | symbol) => {
      if (event === "output") {
        queueMicrotask(() => {
          flushBufferedOutput(
            this.earlyEvents,
            this.listenerCount("output") > 0,
            (data) => this.emit("output", data),
          );
        });
      }
      if (event === "exit") {
        queueMicrotask(() => {
          flushBufferedExit(
            this.earlyEvents,
            this.listenerCount("exit") > 0,
            (code) => this.emit("exit", code),
          );
        });
      }
    });

    // node-pty output is a JavaScript string. Feed the original string to the
    // ordered headless parser; only its VT-filtered counterpart reaches local
    // stdout, durable history, and observers.
    this.ptyProcess.onData((data) => {
      this.terminalOperations.enqueueOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      process.stdout.removeListener("resize", this.stdoutResizeHandler);
      void this.terminalOperations.close().finally(() => {
        this.flush();
        this.terminalMetrics.flush();
        bufferOrEmitExit(
          this.earlyEvents,
          exitCode,
          this.listenerCount("exit") > 0,
          (code) => this.emit("exit", code),
        );
      });
    });

    // Local and remote resize paths share the same headless/PTY serializer.
    this.stdoutResizeHandler = () => {
      void this.resize(
        process.stdout.columns || 120,
        process.stdout.rows || 40,
      ).catch(() => undefined);
    };
    process.stdout.on('resize', this.stdoutResizeHandler);
  }

  writeStdin(data: string): Promise<void> {
    return this.terminalOperations.enqueueInput([{ data, delayMs: 0 }]);
  }

  writeInput(fragments: TerminalInputFragment[], dimensions?: TerminalDimensions): Promise<void> {
    const operation = this.terminalOperations.enqueueInput(fragments, dimensions);
    if (fragments.some((fragment) => fragment.data.length > 0)) {
      this.armInputEchoWindow();
      void operation.then(() => this.armInputEchoWindow(), () => undefined);
    }
    return operation;
  }

  abortInput(): void {
    this.terminalOperations.abort();
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.terminalOperations.enqueueResize(cols, rows);
  }

  kill(signal?: string): void {
    this.ptyProcess.kill(signal);
  }

  private handleFilteredOutput(data: string): void {
    process.stdout.write(data);
    const now = Date.now();
    const previousOutputAtMs = this.lastOutputAtMs;
    if (this.outputBuffer.length === 0) {
      this.outputBufferStartedAtMs = now;
    }
    this.outputBuffer += data;
    this.lastOutputAtMs = now;
    this.scheduleFlush(data, now, previousOutputAtMs);
  }

  private scheduleFlush(data: string, nowMs: number, previousOutputAtMs: number | null): void {
    const bufferStartedAtMs = this.outputBufferStartedAtMs ?? nowMs;
    const decision = decideOutputFlush({
      bufferBytes: Buffer.byteLength(this.outputBuffer),
      chunkBytes: Buffer.byteLength(data),
      nowMs,
      bufferStartedAtMs,
      previousOutputAtMs,
      inputEchoActive: nowMs < this.inputEchoUntilMs,
    }, this.outputFlushPolicy);

    if (decision.flushNow) {
      this.flush();
      return;
    }

    // The first isolated chunk gets the interactive path. If another chunk
    // arrives before it fires, the stream is continuous: move once to the bulk
    // window, still anchored to the original first byte.
    const requestedDueAtMs = bufferStartedAtMs + decision.flushDelayMs;
    if (!this.debounceTimer || this.flushTimerDueAtMs !== requestedDueAtMs) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.flushTimerDueAtMs = requestedDueAtMs;
      this.debounceTimer = setTimeout(
        () => this.flush(),
        Math.max(0, requestedDueAtMs - nowMs),
      );
    }
  }

  private flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.flushTimerDueAtMs = null;
    if (this.outputBuffer.length > 0) {
      const data = this.outputBuffer;
      const flushStartedAt = this.outputBufferStartedAtMs;
      this.outputBuffer = '';
      this.outputBufferStartedAtMs = null;
      bufferOrEmitOutput(
        this.earlyEvents,
        data,
        this.listenerCount("output") > 0,
        (chunk) => this.emit("output", chunk),
      );
      if (flushStartedAt != null) {
        this.terminalMetrics.record(
          "output_flush_span",
          Date.now() - flushStartedAt,
          Buffer.byteLength(data),
        );
      }
    }
  }

  private armInputEchoWindow(): void {
    const windowMs = this.outputFlushPolicy.inputEchoWindowMs;
    if (windowMs > 0) this.inputEchoUntilMs = Date.now() + windowMs;
  }

}
