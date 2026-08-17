import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeHubClient {
    readonly listeners = new Map<string, Listener[]>();
    readonly setSessionIdCalls: Array<{ id: string; options?: unknown }> = [];
    readonly sendSessionAliveCalls: string[] = [];
    readonly sendResizeCalls: Array<{ id: string; cols?: number; rows?: number }> = [];
    readonly sendTerminalInputCalls: unknown[] = [];
    readonly sendTerminalControlCalls: unknown[] = [];
    closeCalls = 0;

    constructor(readonly config: unknown) {
      fakeHubClients.push(this);
    }

    setSessionId(id: string, options?: unknown): void {
      this.setSessionIdCalls.push({ id, options });
    }

    sendSessionAlive(sessionId: string): void {
      this.sendSessionAliveCalls.push(sessionId);
    }

    sendResize(id: string, cols?: number, rows?: number): void {
      this.sendResizeCalls.push({ id, cols, rows });
    }

    sendMessage(): void {
      // Not needed by this test.
    }

    supportsTerminalFastLane(): boolean {
      return behavior.fastLane;
    }

    sendTerminalInput(...args: unknown[]): boolean {
      this.sendTerminalInputCalls.push(args);
      return true;
    }

    sendTerminalControl(...args: unknown[]): boolean {
      this.sendTerminalControlCalls.push(args);
      return true;
    }

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    connect(): void {
      setImmediate(() => {
        this.emit("connected");
        if (behavior.autoDelete) {
          setTimeout(() => this.emit("session-deleted", "session-1"), 0);
        }
      });
    }

    close(): void {
      this.closeCalls += 1;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  const fakeHubClients: FakeHubClient[] = [];
  const behavior = { autoDelete: true, fastLane: false };

  return {
    behavior,
    fakeHubClients,
    pickAndConnect: vi.fn(),
    FakeHubClient,
  };
});

vi.mock("./config.js", () => ({
  HUB_URL: "https://hub.example.com",
  cfAccessHeaders: {},
  hubControlHeaders: {},
}));

vi.mock("./hub-client.js", () => ({
  HubClient: mocks.FakeHubClient,
}));

vi.mock("./picker.js", () => ({
  authLabel: vi.fn(() => null),
  envDisplayLabel: vi.fn((env: { slug: string }) => env.slug),
  pickAndConnect: mocks.pickAndConnect,
}));

import {
  parseTerminalHistoryMessage,
  runAttach,
  TerminalAckTracker,
} from "./attach-client.js";

describe("parseTerminalHistoryMessage", () => {
  const message = {
    id: "message-1",
    session_id: "session-1",
    content: JSON.stringify({ type: "terminal-output", data: "hello" }),
    seq: 1,
    local_id: null,
    created_at: "2026-07-11T00:00:00.000Z",
  };

  it("parses a complete durable message once at the HTTP boundary", () => {
    expect(parseTerminalHistoryMessage(message, "session-1")).toEqual({
      id: "message-1",
      sessionId: "session-1",
      content: { type: "terminal-output", data: "hello" },
      seq: 1,
    });
  });

  it("rejects malformed durable content instead of advancing a blank event", () => {
    expect(() => parseTerminalHistoryMessage({ ...message, content: "{" }, "session-1"))
      .toThrow("Invalid terminal history response");
  });

  it("rejects incomplete durable records", () => {
    const { local_id: _localId, ...incomplete } = message;
    expect(() => parseTerminalHistoryMessage(incomplete, "session-1"))
      .toThrow("Invalid terminal history response");
  });
});

describe("runAttach", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    mocks.fakeHubClients.length = 0;
    mocks.pickAndConnect.mockReset();
    mocks.behavior.autoDelete = true;
    mocks.behavior.fastLane = false;
  });

  it("attaches as a viewer without sending session-alive on connect", async () => {
    mocks.pickAndConnect
      .mockResolvedValueOnce({
        session: {
          id: "session-1",
          tag: "demo-env",
        },
        env: {
          slug: "demo-env",
          harness: "claude-code",
          resolvedAuthMode: "api",
        },
      })
      .mockResolvedValueOnce(null);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

    await runAttach([]);

    expect(mocks.fakeHubClients).toHaveLength(1);
    const hub = mocks.fakeHubClients[0];
    expect(hub.setSessionIdCalls).toEqual([
      { id: "session-1", options: { lifecycle: "viewer" } },
    ]);
    expect(hub.sendSessionAliveCalls).toEqual([]);
    // Terminal control is fast-lane-only: with no capability advertised the
    // resize is dropped, never sent as a durable message.
    expect(hub.sendResizeCalls).toHaveLength(0);
    expect(hub.sendTerminalControlCalls).toHaveLength(0);
    expect(hub.closeCalls).toBe(1);
  });

  it("discards coalesced input across recovery, abort, and detach boundaries", async () => {
    mocks.behavior.autoDelete = false;
    mocks.behavior.fastLane = true;
    mocks.pickAndConnect
      .mockResolvedValueOnce({
        session: { id: "session-1", tag: "demo-env" },
        env: {
          slug: "demo-env",
          harness: "claude-code",
          resolvedAuthMode: "api",
        },
      })
      .mockResolvedValueOnce(null);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);

    const attaching = runAttach([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const hub = mocks.fakeHubClients[0];

    process.stdin.emit("data", Buffer.from("recovery"));
    hub.emit("connected");
    await new Promise((resolve) => setTimeout(resolve, 5));

    process.stdin.emit("data", Buffer.from("abort"));
    process.stdin.emit("data", Buffer.from("\x1d"));
    await new Promise((resolve) => setTimeout(resolve, 5));

    process.stdin.emit("data", Buffer.from("detach"));
    process.stdin.emit("data", Buffer.from("\x02"));
    await attaching;

    expect(hub.sendTerminalInputCalls).toEqual([]);
    expect(hub.sendTerminalControlCalls.some((args) => args[3] === "abort")).toBe(true);
  });

});

describe("TerminalAckTracker", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const linesMatching = (substring: string) =>
    stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(substring));

  it("warns once per stale period, deletes timed-out entries, and re-arms after drain", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.trackInput(1);
    tracker.trackInput(2);
    vi.advanceTimersByTime(1000);

    expect(linesMatching("Terminal input is delayed")).toHaveLength(1);

    // Both entries timed out and were deleted, so the warning re-arms.
    tracker.trackInput(3);
    vi.advanceTimersByTime(1000);

    expect(linesMatching("Terminal input is delayed")).toHaveLength(2);
  });

  it("ignores ACKs for entries already removed by timeout", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.trackInput(1);
    vi.advanceTimersByTime(1000);

    tracker.handleInputAck({
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      ok: false,
      error: "boom",
    });

    expect(linesMatching("Terminal input failed")).toHaveLength(0);
  });

  it("clear() drops pending entries so no warning fires after disconnect", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.trackInput(1);
    tracker.trackControl(1, "resize");
    tracker.clear();
    vi.advanceTimersByTime(5000);

    expect(linesMatching("delayed")).toHaveLength(0);
  });

  it("coalesces failed-ACK logs on a cooldown, not on drained maps", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");
    const failedAck = (inputSeq: number) => ({
      type: "terminal-input-ack" as const,
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq,
      ok: false,
      error: "No active terminal owner for session",
    });

    // Each failed ACK drains the map immediately — the second must still be
    // suppressed by the cooldown.
    tracker.trackInput(1);
    tracker.handleInputAck(failedAck(1));
    tracker.trackInput(2);
    tracker.handleInputAck(failedAck(2));
    expect(linesMatching("Terminal input failed")).toHaveLength(1);

    // After the cooldown the next failure logs again.
    vi.advanceTimersByTime(2001);
    tracker.trackInput(3);
    tracker.handleInputAck(failedAck(3));
    expect(linesMatching("Terminal input failed")).toHaveLength(2);
  });

  it("resets failure coalescing on a successful ACK", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");
    const ack = (inputSeq: number, ok: boolean, error?: string) => ({
      type: "terminal-input-ack" as const,
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq,
      ok,
      ...(error ? { error } : {}),
    });

    tracker.trackInput(1);
    tracker.handleInputAck(ack(1, false, "boom"));
    tracker.trackInput(2);
    tracker.handleInputAck(ack(2, true));
    tracker.trackInput(3);
    tracker.handleInputAck(ack(3, false, "boom again"));

    expect(linesMatching("Terminal input failed")).toHaveLength(2);
  });

  it("coalesces send-failure drop warnings on a cooldown", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.warnSendFailed("terminal input");
    tracker.warnSendFailed("terminal input");
    expect(linesMatching("terminal input dropped")).toHaveLength(1);

    vi.advanceTimersByTime(2001);
    tracker.warnSendFailed("terminal input");
    expect(linesMatching("terminal input dropped")).toHaveLength(2);
  });

  it("ignores ACKs for other clients or sessions", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.trackInput(1);
    tracker.handleInputAck({
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "other-client",
      inputSeq: 1,
      ok: false,
      error: "boom",
    });
    tracker.handleInputAck({
      type: "terminal-input-ack",
      sessionId: "other-session",
      clientId: "client-1",
      inputSeq: 1,
      ok: false,
      error: "boom",
    });

    expect(linesMatching("Terminal input failed")).toHaveLength(0);
    // The entry is still pending, so the stale warning fires on timeout.
    vi.advanceTimersByTime(1000);
    expect(linesMatching("Terminal input is delayed")).toHaveLength(1);
  });

  it("describes a delayed resize without implying that input is blocked", () => {
    const tracker = new TerminalAckTracker("session-1", "client-1");

    tracker.trackControl(1, "resize");
    vi.advanceTimersByTime(1000);

    expect(linesMatching("Terminal resize acknowledgement is delayed")).toHaveLength(1);
    expect(linesMatching("terminal input may still work")).toHaveLength(1);
  });
});
