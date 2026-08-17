import { describe, expect, it, vi } from "vitest";
import {
  CLI_COLD_PAGE_SIZE,
  CLI_RECOVERY_PAGE_SIZE,
  CliTerminalRecoveryOverflowError,
  CliTerminalRecovery,
  readJsonResponseWithinLimit,
  type CliDurableMessage,
} from "./terminal-recovery.js";

function event(seq: number, overrides: Partial<CliDurableMessage> = {}): CliDurableMessage {
  return {
    id: `event-${seq}`,
    sessionId: "session-1",
    seq,
    content: { type: "terminal-output", data: `${seq}` },
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("CliTerminalRecovery", () => {
  it("uses one 200-message cold tail and callback-completed stdout sequencing", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const completed: number[] = [];
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: vi.fn(async (options) => {
        expect(options).toEqual(expect.objectContaining({ limit: CLI_COLD_PAGE_SIZE }));
        return [event(8), event(7)];
      }),
      write: async (message) => {
        if (message.seq === 7) await blocked;
      },
      onSequenceComplete: (seq) => completed.push(seq),
      onStateChange: vi.fn(),
    });

    const start = controller.startCold();
    await flushAsync();
    expect(controller.lastSeq).toBe(6);
    expect(completed).toEqual([]);
    expect(controller.pendingCount).toBe(2);

    release();
    await start;
    expect(completed).toEqual([7, 8]);
    expect(controller.recoveryState).toBe("ready");
    controller.dispose();
  });

  it("pages forward until a short page and merges identical live events", async () => {
    const fetchPage = vi.fn(async (options: { limit: number; afterSeq?: number }) => {
      if (options.afterSeq === undefined) return [];
      if (options.afterSeq === 0) {
        return Array.from({ length: CLI_RECOVERY_PAGE_SIZE }, (_, index) => event(index + 1));
      }
      if (options.afterSeq === CLI_RECOVERY_PAGE_SIZE) return [event(1001)];
      return [];
    });
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });
    await controller.startCold();
    controller.acceptLive(event(1001));
    controller.recover();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      limit: CLI_RECOVERY_PAGE_SIZE,
      afterSeq: 0,
    }));
    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({
      limit: CLI_RECOVERY_PAGE_SIZE,
      afterSeq: 1000,
    }));
    expect(controller.lastSeq).toBe(1001);
    expect(controller.recoveryState).toBe("ready");
    controller.dispose();
  });

  it("fails closed on pending HTTP/WebSocket collisions", async () => {
    let resolveForward!: (events: CliDurableMessage[]) => void;
    const forward = new Promise<CliDurableMessage[]>((resolve) => { resolveForward = resolve; });
    let cold = true;
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: async (options) => {
        if (options.afterSeq === undefined && cold) {
          cold = false;
          return [];
        }
        return forward;
      },
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });
    await controller.startCold();
    controller.recover();
    controller.acceptLive(event(1));
    resolveForward([event(1, { content: { data: "different" } })]);
    await flushAsync();

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("collision");
    expect(controller.lastSeq).toBe(0);
    controller.dispose();
  });

  it("fails closed when one pending id appears at two sequences", async () => {
    let resolveForward!: (events: CliDurableMessage[]) => void;
    const forward = new Promise<CliDurableMessage[]>((resolve) => { resolveForward = resolve; });
    let cold = true;
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: async (options) => {
        if (options.afterSeq === undefined && cold) {
          cold = false;
          return [];
        }
        return forward;
      },
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });
    await controller.startCold();
    controller.recover();
    controller.acceptLive(event(1, { id: "shared-id" }));
    controller.acceptLive(event(2, { id: "shared-id" }));

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("collision");
    resolveForward([]);
    controller.dispose();
  });

  it("enforces the raw HTTP byte boundary before JSON parsing", async () => {
    const body = JSON.stringify([{ seq: 1, data: "界" }]);
    const bodyBytes = Buffer.byteLength(body);

    await expect(readJsonResponseWithinLimit(
      new Response(body),
      bodyBytes,
      vi.fn(),
    )).resolves.toEqual([{ seq: 1, data: "界" }]);
    await expect(readJsonResponseWithinLimit(
      new Response(body),
      bodyBytes - 1,
      vi.fn(),
    )).rejects.toBeInstanceOf(CliTerminalRecoveryOverflowError);
  });

  it("retries invalid recovery JSON and ultimately faults", async () => {
    const fetchPage = vi.fn(async (options) => {
      await readJsonResponseWithinLimit(new Response("{"), options.maxBytes, options.onBytes);
      return [];
    });
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      now: () => 0,
      sleep: async () => undefined,
    });

    await controller.startCold();

    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("fetch_failed");
    controller.dispose();
  });

  it("does not retry a bounded HTTP response overflow", async () => {
    const fetchPage = vi.fn(async () => { throw new CliTerminalRecoveryOverflowError(); });
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });

    await controller.startCold();

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("overflow");
    controller.dispose();
  });

  it("rejects a cold response larger than its requested page", async () => {
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: async (options) => Array.from(
        { length: options.limit + 1 },
        (_, index) => event(index + 1),
      ),
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });

    await controller.startCold();

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("overflow");
    controller.dispose();
  });

  it("faults after exhausting transient fetch retries", async () => {
    const sleeps: number[] = [];
    const fetchPage = vi.fn(async () => { throw new Error("transient"); });
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      now: () => 0,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await controller.startCold();

    expect(sleeps).toEqual([250, 500, 1000, 2000, 4000]);
    expect(fetchPage).toHaveBeenCalledTimes(6);
    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("fetch_failed");
    controller.dispose();
  });

  it("faults on a non-advancing full forward page", async () => {
    let cold = true;
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: async (options) => {
        if (options.afterSeq === undefined && cold) {
          cold = false;
          return [event(CLI_RECOVERY_PAGE_SIZE)];
        }
        return Array.from(
          { length: CLI_RECOVERY_PAGE_SIZE },
          (_, index) => event(index + 1),
        );
      },
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });

    await controller.startCold();
    controller.recover();
    await flushAsync();

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("non_progress");
    controller.dispose();
  });

  it("bounds steady-state messages queued behind stdout backpressure", async () => {
    const releases: Array<() => void> = [];
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: async () => [],
      write: () => new Promise<void>((resolve) => releases.push(resolve)),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      maxMessages: 2,
    });
    await controller.startCold();
    controller.acceptLive(event(1));
    controller.acceptLive(event(2));
    controller.acceptLive(event(3));

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("overflow");
    expect(controller.pendingCount).toBe(2);
    releases.forEach((resolve) => resolve());
    controller.dispose();
  });

  it("reserves HTTP page slots against the combined message limit", async () => {
    let resolveForward!: (events: CliDurableMessage[]) => void;
    const forward = new Promise<CliDurableMessage[]>((resolve) => { resolveForward = resolve; });
    const fetchPage = vi.fn(async (options) => (
      options.afterSeq === undefined ? [] : forward
    ));
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      maxMessages: 4,
    });

    await controller.startCold();
    controller.acceptLive(event(2));
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 3 }));
    controller.acceptLive(event(3));

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("overflow");
    expect(controller.pendingCount).toBe(1);
    resolveForward([]);
    controller.dispose();
  });

  it("aborts an HTTP response when live messages consume its byte budget", async () => {
    let fetchSignal!: AbortSignal;
    const fetchPage = vi.fn((options) => {
      if (options.afterSeq === undefined) return Promise.resolve([]);
      fetchSignal = options.signal;
      options.onBytes(599);
      return new Promise<CliDurableMessage[]>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: async () => undefined,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      maxBytes: 600,
    });

    await controller.startCold();
    controller.recover();
    controller.acceptLive(event(1));
    await flushAsync();

    expect(controller.recoveryState).toBe("fault");
    expect(controller.recoveryFault).toBe("overflow");
    expect(fetchSignal.aborted).toBe(true);
    controller.dispose();
  });

  it("runs reconnect recovery after an in-flight stdout write drains", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const fetchPage = vi.fn(async () => [] as CliDurableMessage[]);
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage,
      write: () => blocked,
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
    });
    await controller.startCold();
    controller.acceptLive(event(1));
    controller.recover();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(controller.recoveryState).toBe("recovering");

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({
      limit: CLI_RECOVERY_PAGE_SIZE,
      afterSeq: 1,
    }));
    expect(controller.lastSeq).toBe(1);
    expect(controller.recoveryState).toBe("ready");
    controller.dispose();
  });

  it("includes stdout backpressure in the reconnect deadline", async () => {
    vi.useFakeTimers();
    const controller = new CliTerminalRecovery({
      sessionId: "session-1",
      fetchPage: vi.fn(async () => []),
      write: () => new Promise<void>(() => undefined),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      deadlineMs: 100,
    });

    try {
      await controller.startCold();
      controller.acceptLive(event(1));
      controller.recover();

      await vi.advanceTimersByTimeAsync(100);

      expect(controller.recoveryState).toBe("fault");
      expect(controller.recoveryFault).toBe("deadline");
      expect(controller.lastSeq).toBe(0);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
});
