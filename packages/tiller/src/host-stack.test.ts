import { describe, expect, it, vi } from "vitest";
import {
  resolveCompatibleRuntimeImage,
  runHostDownCommand,
  runHostSetupCommand,
  waitForHealthyMachineAdvertisement,
  waitForMachineAdvertisementWithdrawal,
  type HostSetupDeps,
} from "./host-stack.js";
import type { TillerConfig } from "./config.js";

const RUNTIME_IMAGE =
  `docker.io/jamieatlason/tiller-sandbox@sha256:${"1".repeat(64)}`;
const GENERATED_MACHINE_ID = "826c8bf6-f918-4e81-96da-f9d75bc35f67";
const EXISTING_MACHINE_ID = "b5fe8efb-5eba-4e9e-8270-1b3a148c53e4";
const CONTROL_SECRET = "must-not-appear-in-process-args-logs-or-urls";

function setupDeps(overrides: HostSetupDeps = {}) {
  const written: TillerConfig[] = [];
  const installOrUpdate = vi.fn(() => ({
    platform: "launchd" as const,
    installed: true,
    running: true,
    started: true,
    definitionPath: "/tmp/dev.tiller.host.plist",
    serviceName: "dev.tiller.host",
  }));
  const deps: HostSetupDeps = {
    loadConfig: vi.fn(() => ({
      hubUrl: "https://demo.preview.workers.dev",
    })),
    writeConfig: vi.fn((config) => written.push(config)),
    reloadConfig: vi.fn(),
    connectMachineCredential: vi.fn(async () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      controlSecret: CONTROL_SECRET,
    })),
    resolveCompatibleRuntimeImage: vi.fn(async () => RUNTIME_IMAGE),
    prepareLocalHostRuntime: vi.fn(async () => ({
      report: { ready: true, checks: [] },
      ready: true,
    })),
    createHostSupervisor: vi.fn(() => ({
      installOrUpdate,
      restart: vi.fn(),
      stop: vi.fn(),
      inspect: vi.fn(),
    })),
    waitForHealthyMachineAdvertisement: vi.fn(async () => undefined),
    machineId: vi.fn(() => GENERATED_MACHINE_ID),
    displayName: vi.fn(() => "Build Mac"),
    printCheckReport: vi.fn(),
    log: vi.fn(),
    printSettingsLink: vi.fn(),
    ...overrides,
  };
  return { deps, written, installOrUpdate };
}

describe("tiller host setup", () => {
  it("requires the exact workers.dev URL before authentication or local mutation", async () => {
    const { deps } = setupDeps({
      loadConfig: vi.fn(() => ({ hubUrl: "https://tiller.example.com" })),
    });

    await expect(runHostSetupCommand({}, deps)).rejects.toThrow("exact workers.dev Hub URL");
    expect(deps.connectMachineCredential).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.createHostSupervisor).not.toHaveBeenCalled();
  });

  it("creates a UUID identity, installs the persistent service, verifies advertisement, and prints Settings", async () => {
    const { deps, written, installOrUpdate } = setupDeps();

    await runHostSetupCommand({}, deps);

    expect(written).toEqual([{
      hubUrl: "https://demo.preview.workers.dev",
      clientId: "client-id",
      clientSecret: "client-secret",
      controlSecret: CONTROL_SECRET,
      machineId: GENERATED_MACHINE_ID,
      displayName: "Build Mac",
      localRunnerImage: RUNTIME_IMAGE,
    }]);
    expect(installOrUpdate).toHaveBeenCalledOnce();
    expect(deps.waitForHealthyMachineAdvertisement).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev",
      GENERATED_MACHINE_ID,
    );
    expect(deps.printSettingsLink).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev/settings",
    );
    expect(deps.resolveCompatibleRuntimeImage).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev",
      {
        clientId: "client-id",
        clientSecret: "client-secret",
        controlSecret: CONTROL_SECRET,
      },
    );
    expect(installOrUpdate).toHaveBeenCalledWith();
    expect(
      JSON.stringify({
        logs: (deps.log as ReturnType<typeof vi.fn>).mock.calls,
        urls: (deps.printSettingsLink as ReturnType<typeof vi.fn>).mock.calls,
        processArgs: installOrUpdate.mock.calls,
      }),
    ).not.toContain(CONTROL_SECRET);
  });

  it("lets an explicit workers.dev URL override a legacy HUB_URL during setup checks", async () => {
    const previousHubUrl = process.env.HUB_URL;
    process.env.HUB_URL = "https://legacy.example.com";
    const observedHubUrls: string[] = [];
    const { deps, written } = setupDeps({
      loadConfig: vi.fn(() => ({ hubUrl: "https://legacy.example.com" })),
      reloadConfig: vi.fn(() => {
        observedHubUrls.push(process.env.HUB_URL ?? "");
      }),
      prepareLocalHostRuntime: vi.fn(async () => {
        observedHubUrls.push(process.env.HUB_URL ?? "");
        return { report: { ready: true, checks: [] }, ready: true };
      }),
    });

    try {
      await runHostSetupCommand(
        { hubUrlOverride: "https://canonical.preview.workers.dev" },
        deps,
      );

      expect(written[0]?.hubUrl).toBe("https://canonical.preview.workers.dev");
      expect(observedHubUrls).toEqual([
        "https://canonical.preview.workers.dev",
        "https://canonical.preview.workers.dev",
      ]);
      expect(process.env.HUB_URL).toBe("https://legacy.example.com");
    } finally {
      if (previousHubUrl === undefined) delete process.env.HUB_URL;
      else process.env.HUB_URL = previousHubUrl;
    }
  });

  it("preserves the existing machine UUID and display name on subsequent setup", async () => {
    const { deps, written } = setupDeps({
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        machineId: EXISTING_MACHINE_ID,
        displayName: "Existing Mac",
      })),
    });

    await runHostSetupCommand({}, deps);

    expect(written[0]).toMatchObject({
      machineId: EXISTING_MACHINE_ID,
      displayName: "Existing Mac",
    });
    expect(deps.machineId).not.toHaveBeenCalled();
    expect(deps.displayName).not.toHaveBeenCalled();
  });

  it("replaces a hostname-derived legacy identity with a fresh UUID", async () => {
    const { deps, written } = setupDeps({
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        machineId: "legacy-build-mac",
        displayName: "Existing Mac",
      })),
    });

    await runHostSetupCommand({}, deps);

    expect(written[0]).toMatchObject({ machineId: GENERATED_MACHINE_ID });
    expect(deps.machineId).toHaveBeenCalledOnce();
  });

  it("does not install the supervisor when Docker or image checks fail", async () => {
    const { deps } = setupDeps({
      prepareLocalHostRuntime: vi.fn(async () => ({
        report: { ready: false, checks: [] },
        ready: false,
        blockingMessage: "Docker is not ready.",
      })),
    });

    await expect(runHostSetupCommand({}, deps)).rejects.toThrow("Docker is not ready");
    expect(deps.createHostSupervisor).not.toHaveBeenCalled();
    expect(deps.waitForHealthyMachineAdvertisement).not.toHaveBeenCalled();
  });

  it("does not advertise a Linux user service as ready while login linger is disabled", async () => {
    const stop = vi.fn(() => ({
      platform: "systemd" as const,
      installed: true,
      running: false,
      definitionPath: "/tmp/tiller-host.service",
      serviceName: "tiller-host.service",
      scope: "user" as const,
    }));
    const { deps } = setupDeps({
      createHostSupervisor: vi.fn(() => ({
        installOrUpdate: vi.fn(() => ({
          platform: "systemd" as const,
          installed: true,
          running: true,
          started: true,
          definitionPath: "/tmp/tiller-host.service",
          serviceName: "tiller-host.service",
          scope: "user" as const,
          lingerEnabled: false,
        })),
        restart: vi.fn(),
        stop,
        inspect: vi.fn(),
      })),
    });

    await expect(runHostSetupCommand({}, deps)).rejects.toThrow(
      "login linger is disabled",
    );

    expect(stop).toHaveBeenCalledOnce();
    expect(deps.waitForHealthyMachineAdvertisement).not.toHaveBeenCalled();
    expect(deps.printSettingsLink).not.toHaveBeenCalled();
  });

  it("refuses Hub release payloads without the required runtime field", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        kind: "installer-managed",
        currentRelease: {
          schemaVersion: 1,
          channel: "release",
          hubVersion: "0.2.54",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(resolveCompatibleRuntimeImage(
      "https://demo.preview.workers.dev",
      { clientId: "client-id", clientSecret: "client-secret" },
    )).rejects.toThrow("Malformed Hub release info response");
  });
});

describe("execution-machine advertisement verification", () => {
  it("requires a fresh compatible Hub status for the exact machine", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        state: "ready",
        machineId: "machine-1",
        displayName: "Build Mac",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitForHealthyMachineAdvertisement(
      "https://demo.preview.workers.dev",
      "machine-1",
      100,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev/api/machines/machine-1/execution-status",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "application/json" }),
      }),
    );
  });

  it("fails immediately when the live advertisement is incompatible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        state: "incompatible",
        machineId: "machine-1",
        displayName: "Build Mac",
        code: "runtime_image",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(waitForHealthyMachineAdvertisement(
      "https://demo.preview.workers.dev",
      "machine-1",
      100,
    )).rejects.toThrow("incompatible (runtime_image)");
  });

  it("verifies that a stopped machine is no longer advertised", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ state: "not_connected" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitForMachineAdvertisementWithdrawal(
      "https://demo.preview.workers.dev",
      GENERATED_MACHINE_ID,
      100,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      `https://demo.preview.workers.dev/api/machines/${GENERATED_MACHINE_ID}/execution-status`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json",
          "Cache-Control": "no-store",
        }),
      }),
    );
  });
});

describe("tiller down", () => {
  it("stops a managed supervisor before touching its PID and verifies withdrawal", async () => {
    const stop = vi.fn(() => ({
      platform: "systemd" as const,
      scope: "user" as const,
      installed: true,
      running: false,
      definitionPath: "/home/ada/.config/systemd/user/tiller-host.service",
      serviceName: "tiller-host.service",
    }));
    const signalProcess = vi.fn();
    const waitForWithdrawal = vi.fn(async () => undefined);
    const removePidRecord = vi.fn();

    await runHostDownCommand({
      platform: "linux",
      hostSupervisor: {
        inspect: vi.fn(() => ({
          platform: "systemd",
          scope: "user",
          installed: true,
          running: true,
          definitionPath: "/home/ada/.config/systemd/user/tiller-host.service",
          serviceName: "tiller-host.service",
        })),
        installOrUpdate: vi.fn(),
        restart: vi.fn(),
        stop,
      },
      readHostPidRecord: () => ({
        pid: 123,
        startedAt: "2026-07-17T00:00:00.000Z",
      }),
      processIsRunning: () => true,
      waitForProcessExit: vi.fn(async () => true),
      signalProcess,
      removePidRecord,
      waitForMachineAdvertisementWithdrawal: waitForWithdrawal,
      hubUrl: "https://demo.preview.workers.dev",
      machineId: GENERATED_MACHINE_ID,
      log: vi.fn(),
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(signalProcess).not.toHaveBeenCalled();
    expect(removePidRecord).toHaveBeenCalledOnce();
    expect(waitForWithdrawal).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev",
      GENERATED_MACHINE_ID,
    );
  });
});
