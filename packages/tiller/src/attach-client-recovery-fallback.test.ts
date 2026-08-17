import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  type RecoveryOptions = {
    write(message: { content: unknown }): Promise<void>;
    onStateChange(state: "recovering" | "ready" | "fault", fault?: string): void;
  };

  class FakeRecovery {
    static instances: FakeRecovery[] = [];
    readonly lastSeq = 0;
    readonly options: RecoveryOptions;
    startColdCalls = 0;
    disposed = false;

    constructor(options: RecoveryOptions) {
      this.options = options;
      FakeRecovery.instances.push(this);
      options.onStateChange("recovering");
    }

    async startCold(): Promise<void> {
      this.startColdCalls += 1;
      if (!this.disposed) this.options.onStateChange("ready");
    }

    recover() {}
    acceptLive() {}

    dispose(): void {
      this.disposed = true;
    }
  }

  class FakeHubClient {
    readonly listeners = new Map<string, Listener[]>();

    constructor(_config: unknown) {
      fakeHubClients.push(this);
    }

    setSessionId() {}
    markMessageComplete() {}
    supportsTerminalFastLane() { return false; }
    sendTerminalInput() { return false; }
    sendTerminalControl() { return false; }
    sendTerminalDetach() {}
    close() {}

    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    connect(): void {
      setImmediate(() => this.emit("connected"));
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  const fakeHubClients: FakeHubClient[] = [];
  const pickAndConnect = vi.fn();
  const writeStdoutWithBackpressure = vi.fn<(data: string) => Promise<void>>();

  return {
    FakeHubClient,
    FakeRecovery,
    fakeHubClients,
    pickAndConnect,
    writeStdoutWithBackpressure,
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

vi.mock("./terminal-recovery.js", () => ({
  CliTerminalRecovery: mocks.FakeRecovery,
  readJsonResponseWithinLimit: vi.fn(async () => []),
  writeStdoutWithBackpressure: mocks.writeStdoutWithBackpressure,
}));

import { runAttach } from "./attach-client.js";

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for attach fallback state");
}

describe("CLI recent-output recovery fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.FakeRecovery.instances.length = 0;
    mocks.fakeHubClients.length = 0;
    mocks.pickAndConnect.mockReset();
    mocks.writeStdoutWithBackpressure.mockReset();
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
    mocks.writeStdoutWithBackpressure.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
    vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("waits for stdout, cold-starts once, and reports a second failure", async () => {
    let releaseWrite!: () => void;
    mocks.writeStdoutWithBackpressure.mockImplementation((data) => (
      data === "pending-output"
        ? new Promise<void>((resolve) => { releaseWrite = resolve; })
        : Promise.resolve()
    ));
    const stderrSpy = vi.mocked(process.stderr.write);

    const attaching = runAttach([]);
    await waitForCondition(() => mocks.FakeRecovery.instances.length === 1);
    const initial = mocks.FakeRecovery.instances[0];
    const pendingWrite = initial.options.write({
      content: { type: "terminal-output", data: "pending-output" },
    });

    initial.options.onStateChange("fault", "overflow");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(initial.disposed).toBe(true);
    expect(mocks.FakeRecovery.instances).toHaveLength(1);
    expect(mocks.writeStdoutWithBackpressure).not.toHaveBeenCalledWith("\x1b[2J\x1b[H");

    releaseWrite();
    await pendingWrite;
    await waitForCondition(() => mocks.FakeRecovery.instances.length === 2);
    const fallback = mocks.FakeRecovery.instances[1];

    expect(fallback.startColdCalls).toBe(1);
    expect(mocks.writeStdoutWithBackpressure).toHaveBeenCalledWith("\x1b[2J\x1b[H");
    expect(stderrSpy.mock.calls.some(
      (call) => String(call[0]).includes("Showing recent output"),
    )).toBe(true);

    fallback.options.onStateChange("fault", "deadline");
    expect(mocks.FakeRecovery.instances).toHaveLength(2);
    expect(stderrSpy.mock.calls.some(
      (call) => String(call[0]).includes("Terminal recovery stopped (deadline)"),
    )).toBe(true);

    mocks.fakeHubClients[0].emit("session-deleted", "session-1");
    await attaching;
  });

  it("does not replace the controller for integrity faults", async () => {
    const stderrSpy = vi.mocked(process.stderr.write);
    const attaching = runAttach([]);
    await waitForCondition(() => mocks.FakeRecovery.instances.length === 1);

    mocks.FakeRecovery.instances[0].options.onStateChange("fault", "collision");

    expect(mocks.FakeRecovery.instances).toHaveLength(1);
    expect(stderrSpy.mock.calls.some(
      (call) => String(call[0]).includes("Terminal recovery stopped (collision)"),
    )).toBe(true);

    mocks.fakeHubClients[0].emit("session-deleted", "session-1");
    await attaching;
  });
});
