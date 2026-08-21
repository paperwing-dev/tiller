import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerSessionController } from "./runner-session.js";
import { HubClient, type RunnerControlRequestMessage } from "./hub-client.js";

function createController(): RunnerSessionController {
  return new RunnerSessionController({
    hubUrl: "https://hub.example.com",
    cfAccessHeaders: {},
    machineId: "machine-1",
    runnerPort: 8123,
    buildState: () => null,
    getStateSignature: () => "state",
    getMachineSignature: () => null,
  });
}

async function execute(
  controller: RunnerSessionController,
  request: RunnerControlRequestMessage,
): Promise<unknown> {
  return await (controller as unknown as {
    executeLocalRunnerRequest(value: RunnerControlRequestMessage): Promise<unknown>;
  }).executeLocalRunnerRequest(request);
}

describe("RunnerSessionController runner command forwarding", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("advertises runner capabilities on a new connection when durable state already matches", async () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    vi.spyOn(HubClient.prototype, "connect").mockImplementation(() => {});
    vi.spyOn(HubClient.prototype, "getSocket").mockReturnValue({ readyState: 1 } as WebSocket);
    const sendRunnerState = vi.spyOn(HubClient.prototype, "sendMachineUpdateRunnerState")
      .mockImplementation(() => {});
    const state = {
      host: {
        machineId: "machine-1",
        connectedAt: "2026-07-10T00:00:00.000Z",
        dockerAvailable: true,
        runnerCommandProtocol: 1 as const,
        codexRuntimeAuthProtocol: 1 as const,
        claudeSubscription: false,
        transport: "session" as const,
      },
    };
    const controller = new RunnerSessionController({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
      machineId: "machine-1",
      runnerPort: 8123,
      buildState: () => state,
      getStateSignature: () => "matching-state",
      getMachineSignature: () => "matching-state",
    });

    await controller.ensureConnected();
    const hub = (controller as unknown as { hub: HubClient }).hub;
    hub.emit("connected");
    hub.emit("machine-updated", {
      id: "machine-1",
      runner_state: JSON.stringify(state),
      runner_state_version: 7,
    });

    expect(sendRunnerState).toHaveBeenCalledWith("machine-1", state, 7);
    controller.close();
  });

  it("refreshes runner health before each lease advertisement", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    vi.spyOn(HubClient.prototype, "connect").mockImplementation(() => {});
    vi.spyOn(HubClient.prototype, "getSocket").mockReturnValue({ readyState: 1 } as WebSocket);
    const sendRunnerState = vi.spyOn(HubClient.prototype, "sendMachineUpdateRunnerState")
      .mockImplementation(() => {});
    let runnerAvailable = true;
    const refreshState = vi.fn(async () => {
      runnerAvailable = false;
    });
    const buildState = () => ({
      host: {
        machineId: "machine-1",
        connectedAt: "2026-07-10T00:00:00.000Z",
        dockerAvailable: true,
        runnerAvailable,
        runnerCommandProtocol: 1 as const,
        codexRuntimeAuthProtocol: 1 as const,
        claudeSubscription: false,
        transport: "session" as const,
      },
    });
    const controller = new RunnerSessionController({
      hubUrl: "https://hub.example.com",
      cfAccessHeaders: {},
      machineId: "machine-1",
      runnerPort: 8123,
      buildState,
      refreshState,
      getStateSignature: (state) => JSON.stringify(state),
      getMachineSignature: (machine) => machine.runner_state,
    });

    await controller.ensureConnected();
    const hub = (controller as unknown as { hub: HubClient }).hub;
    hub.emit("connected");
    hub.emit("machine-updated", {
      id: "machine-1",
      runner_state: JSON.stringify(buildState()),
      runner_state_version: 7,
    });
    hub.emit("machine-updated", {
      id: "machine-1",
      runner_state: JSON.stringify(buildState()),
      runner_state_version: 8,
    });
    sendRunnerState.mockClear();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshState).toHaveBeenCalledOnce();
    expect(sendRunnerState).toHaveBeenCalledWith(
      "machine-1",
      expect.objectContaining({
        host: expect.objectContaining({ runnerAvailable: false }),
      }),
      8,
    );
    controller.close();
  });

  it.each([
    ["start", "running"],
    ["stop", "stopped"],
    ["destroy", "absent"],
  ] as const)("forwards the command fence for %s", async (action, desiredState) => {
    let forwarded: { url: string; init?: RequestInit } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      forwarded = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    await execute(createController(), {
      type: "runner-control-request",
      requestId: "request-1",
      action,
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "codex" },
      commandGeneration: 4,
      operationId: `${action}-op-4`,
      desiredState,
    });

    expect(forwarded).not.toBeNull();
    const body = JSON.parse(String(forwarded!.init?.body));
    expect(body).toMatchObject({
      commandGeneration: 4,
      operationId: `${action}-op-4`,
      desiredState,
    });
    expect(body).not.toHaveProperty("startOpId");
    expect(body).not.toHaveProperty("stopOpId");
  });

  it("maps a status 404 to typed runner absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Runner not found",
    }), { status: 404 })));

    await expect(execute(createController(), {
      type: "runner-control-request",
      requestId: "request-status-404",
      action: "status",
      slug: "missing-env",
    })).rejects.toMatchObject({ code: "runner_not_found" });
  });

  it.each([
    "runner_command_superseded",
    "runner_command_superseded_before_mutation",
  ] as const)("preserves a structured %s error from Runner Server", async (code) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "older Start lost",
      code,
      currentCommandGeneration: 60,
    }), { status: 409 })));

    await expect(execute(createController(), {
      type: "runner-control-request",
      requestId: "request-1",
      action: "start",
      slug: "demo-env",
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    })).rejects.toMatchObject({
      code,
      currentCommandGeneration: 60,
    });
  });

  it("forwards the runner high-water in the machine websocket failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Runner command generation 1 was superseded by 60.",
      code: "runner_command_superseded_before_mutation",
      currentCommandGeneration: 60,
    }), { status: 409 })));
    const controller = createController();
    const sendRunnerControlResponse = vi.fn();
    (controller as unknown as { hub: unknown }).hub = { sendRunnerControlResponse };

    await (controller as unknown as {
      handleRunnerControlRequest(request: RunnerControlRequestMessage): Promise<void>;
    }).handleRunnerControlRequest({
      type: "runner-control-request",
      requestId: "request-1",
      action: "create",
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: {},
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    });

    expect(sendRunnerControlResponse).toHaveBeenCalledWith(
      "request-1",
      false,
      undefined,
      expect.stringContaining("superseded by 60"),
      "runner_command_superseded_before_mutation",
      60,
    );
  });
});
