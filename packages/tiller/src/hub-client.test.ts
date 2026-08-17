import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "./hub-client.js";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(
    readonly url: string,
    readonly options?: unknown,
  ) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatchOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }

  dispatchMessage(data: unknown): void {
    this.dispatch("message", { data });
  }

  dispatchClose(event: { code?: number; wasClean?: boolean; reason?: string } = {}): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", {
      code: 1006,
      wasClean: false,
      reason: "",
      ...event,
    });
  }

  private dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("HubClient reconnect recovery", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.WebSocket = FakeWebSocket as any;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retries after a connect timeout even if the socket never emits close", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    client.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const firstSocket = FakeWebSocket.instances[0];

    vi.advanceTimersByTime(30_000);

    expect(firstSocket.closeCalls).toBe(1);

    vi.advanceTimersByTime(2_000);

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("forces a fresh reconnect after pong silence without waiting for a close event", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    client.connect();

    const firstSocket = FakeWebSocket.instances[0];
    firstSocket.dispatchOpen();

    vi.advanceTimersByTime(120_000);

    expect(firstSocket.closeCalls).toBe(1);

    vi.advanceTimersByTime(2_000);

    expect(FakeWebSocket.instances).toHaveLength(2);

    vi.advanceTimersByTime(60_000);

    expect(firstSocket.closeCalls).toBe(1);
  });

  it("ignores message events for other sessions", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    client.setSessionId("session-1");
    const seen: unknown[] = [];
    client.on("message-received", (msg) => {
      seen.push(msg);
    });

    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.dispatchOpen();
    socket.dispatchMessage(JSON.stringify({
      type: "message-received",
      sessionId: "session-2",
      seq: 9,
      content: { type: "terminal-output", data: "wrong-session" },
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "message-received",
      sessionId: "session-1",
      seq: 10,
      content: { type: "terminal-output", data: "right-session" },
    }));

    expect(seen).toHaveLength(1);
    expect((seen[0] as { sessionId: string }).sessionId).toBe("session-1");
    expect(client.getLastSeq()).toBe(0);
    client.markMessageComplete(10);
    expect(client.getLastSeq()).toBe(10);
  });

  it("keeps viewer session filtering without sending session-alive directly", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    client.setSessionId("session-1", { lifecycle: "viewer" });
    const seen: unknown[] = [];
    client.on("message-received", (msg) => {
      seen.push(msg);
    });

    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.dispatchOpen();
    client.sendSessionAlive("session-1");
    socket.dispatchMessage(JSON.stringify({
      type: "message-received",
      sessionId: "session-2",
      seq: 9,
      content: { type: "terminal-output", data: "wrong-session" },
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "message-received",
      sessionId: "session-1",
      seq: 10,
      content: { type: "terminal-output", data: "right-session" },
    }));

    expect(socket.sent.map((payload) => JSON.parse(payload))).not.toContainEqual({
      type: "session-alive",
      sessionId: "session-1",
    });
    expect(seen).toHaveLength(1);
    expect((seen[0] as { sessionId: string }).sessionId).toBe("session-1");
    expect(client.getLastSeq()).toBe(0);
    client.markMessageComplete(10);
    expect(client.getLastSeq()).toBe(10);
  });

  it("tracks terminal fast-lane capability and sends live terminal input", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    const capabilities: unknown[] = [];
    client.on("capabilities", (msg) => {
      capabilities.push(msg);
    });

    client.connect();

    const socket = FakeWebSocket.instances[0];
    expect(client.supportsTerminalFastLane()).toBe(false);
    expect(client.sendTerminalInput("session-1", "client-1", 1, "a")).toBe(false);

    socket.dispatchOpen();
    socket.dispatchMessage(JSON.stringify({
      type: "capabilities",
      terminalFastLane: true,
    }));

    expect(capabilities).toEqual([{ terminalFastLane: true }]);
    expect(client.supportsTerminalFastLane()).toBe(true);
    expect(client.sendTerminalInput("session-1", "client-1", 1, "a")).toBe(true);
    expect(client.sendTerminalControl(
      "session-1",
      "client-1",
      1,
      "resize",
      { cols: 100, rows: 40 },
      { claim: true },
    )).toBe(true);
    expect(socket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      data: "a",
    });
    expect(socket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "resize",
      cols: 100,
      rows: 40,
      claim: true,
    });
  });

  it("emits terminal input/control events for the current session and ACK events by client id", () => {
    const client = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });

    client.setSessionId("session-1");
    const inputEvents: unknown[] = [];
    const controlEvents: unknown[] = [];
    const inputAcks: unknown[] = [];
    const controlAcks: unknown[] = [];
    client.on("terminal-input", (msg) => inputEvents.push(msg));
    client.on("terminal-control", (msg) => controlEvents.push(msg));
    client.on("terminal-input-ack", (msg) => inputAcks.push(msg));
    client.on("terminal-control-ack", (msg) => controlAcks.push(msg));

    client.connect();

    const socket = FakeWebSocket.instances[0];
    socket.dispatchOpen();
    socket.dispatchMessage(JSON.stringify({
      type: "terminal-input",
      sessionId: "session-2",
      clientId: "client-1",
      inputSeq: 1,
      data: "wrong",
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 2,
      data: "right",
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "resize",
      cols: 80,
      rows: 24,
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 2,
      ok: true,
    }));
    socket.dispatchMessage(JSON.stringify({
      type: "terminal-control-ack",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      ok: false,
      error: "bad resize",
    }));

    expect(inputEvents).toEqual([
      {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 2,
        data: "right",
      },
    ]);
    expect(controlEvents).toEqual([
      {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        action: "resize",
        cols: 80,
        rows: 24,
      },
    ]);
    expect(inputAcks).toEqual([
      {
        type: "terminal-input-ack",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 2,
        ok: true,
      },
    ]);
    expect(controlAcks).toEqual([
      {
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        ok: false,
        error: "bad resize",
      },
    ]);
  });

  it("sends owner session-alive heartbeats but not viewer session-alive heartbeats", () => {
    const owner = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });
    owner.setSessionId("session-owner");
    owner.connect();
    const ownerSocket = FakeWebSocket.instances[0];
    ownerSocket.dispatchOpen();

    vi.advanceTimersByTime(90_000);
    ownerSocket.dispatchMessage(JSON.stringify({ type: "pong" }));
    vi.advanceTimersByTime(60_000);

    expect(ownerSocket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "session-alive",
      sessionId: "session-owner",
    });

    owner.close();

    const viewer = new HubClient({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
    });
    viewer.setSessionId("session-viewer", { lifecycle: "viewer" });
    viewer.connect();
    const viewerSocket = FakeWebSocket.instances[1];
    viewerSocket.dispatchOpen();

    vi.advanceTimersByTime(90_000);
    viewerSocket.dispatchMessage(JSON.stringify({ type: "pong" }));
    vi.advanceTimersByTime(60_000);

    expect(viewerSocket.sent.map((payload) => JSON.parse(payload))).not.toContainEqual({
      type: "session-alive",
      sessionId: "session-viewer",
    });
  });
});
