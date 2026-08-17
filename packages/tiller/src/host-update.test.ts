import { describe, expect, it, vi } from "vitest";
import {
  describeLocalRunnerImageOverride,
  isManagedLocalRunnerImageRef,
  parseManagedLocalRunnerImageSourceId,
  parseHostUpdateArgs,
  runHostUpdate,
  type HostUpdateDeps,
} from "./host-update.js";
import {
  resolveHostUpdateTargetImage,
} from "./host-runtime-metadata.js";
import type { TillerConfig } from "./config.js";

const CURRENT_RELEASE_ID = "0123456789abcdef0123456789abcdef01234567";
const RUNTIME_DIGEST = "1".repeat(64);
const TARGET_IMAGE = `docker.io/jamieatlason/tiller-sandbox@sha256:${RUNTIME_DIGEST}`;
const CURRENT_RELEASE = {
  schemaVersion: 1 as const,
  channel: "release" as const,
  hubVersion: "0.2.54",
  releaseId: CURRENT_RELEASE_ID,
  selfHostRuntimeImage: TARGET_IMAGE,
};

function baseDeps(overrides: HostUpdateDeps = {}): HostUpdateDeps {
  return {
    env: {},
    platform: "linux",
    loadedDotEnvValues: {},
    configPath: "/home/pi/.config/tiller/config.json",
    loadConfig: vi.fn(() => ({
      hubUrl: "https://demo.preview.workers.dev",
      localRunnerImage: "docker.io/jamieatlason/tiller-sandbox:stable",
    })),
    writeConfig: vi.fn(),
    reloadConfig: vi.fn(),
    fetchUpdateCheck: vi.fn(async () => ({
      kind: "installer-managed" as const,
      currentRelease: CURRENT_RELEASE,
      errors: [],
    })),
    pullImage: vi.fn(async () => undefined),
    getActiveSystemdServices: vi.fn(() => []),
    readActiveHostPidRecord: vi.fn(() => null),
    restartSystemdService: vi.fn(() => ({ scope: "user", ok: true, command: "systemctl --user restart tiller-host.service" })),
    checkLocalRunnerHealth: vi.fn(async () => ({ ok: true })),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    ...overrides,
  };
}

describe("host update helpers", () => {
  it("parses dry-run and yes flags", () => {
    expect(parseHostUpdateArgs(["--dry-run", "--yes"])).toEqual({
      dryRun: true,
      yes: true,
    });
  });

  it("requires explicit execution-machine runtime metadata", () => {
    expect(() => resolveHostUpdateTargetImage({
      schemaVersion: 1,
      channel: "release",
      hubVersion: "0.2.54",
    })).toThrow("selfHostRuntimeImage");
  });

  it("accepts only managed sandbox image refs", () => {
    expect(isManagedLocalRunnerImageRef("docker.io/jamieatlason/tiller-sandbox:stable")).toBe(true);
    expect(isManagedLocalRunnerImageRef("jamieatlason/tiller-sandbox:stable")).toBe(true);
    expect(isManagedLocalRunnerImageRef(TARGET_IMAGE)).toBe(true);
    expect(isManagedLocalRunnerImageRef("ghcr.io/example/tiller-sandbox:stable")).toBe(false);
    expect(isManagedLocalRunnerImageRef("docker.io/jamieatlason/tiller-scm:stable")).toBe(false);
    expect(parseManagedLocalRunnerImageSourceId(TARGET_IMAGE)).toBe(`sha256:${RUNTIME_DIGEST}`);
    expect(parseManagedLocalRunnerImageSourceId("jamieatlason/tiller-sandbox:0123456789abcdef0123456789abcdef01234567")).toBeNull();
    expect(parseManagedLocalRunnerImageSourceId("docker.io/jamieatlason/tiller-sandbox:stable")).toBeNull();
  });

  it("uses the digest-pinned image from the current release", () => {
    expect(resolveHostUpdateTargetImage({
      ...CURRENT_RELEASE,
    })).toBe(TARGET_IMAGE);
  });

  it("reports shell and dotenv image overrides", () => {
    expect(describeLocalRunnerImageOverride({ TILLER_LOCAL_RUNNER_IMAGE: "custom" }, {})).toContain("shell environment");
    expect(describeLocalRunnerImageOverride(
      { TILLER_LOCAL_RUNNER_IMAGE: "custom" },
      { TILLER_LOCAL_RUNNER_IMAGE: { path: "/home/pi/.config/tiller/.env", value: "custom" } },
    )).toContain("/home/pi/.config/tiller/.env");
  });
});

describe("runHostUpdate", () => {
  it("uses the current release runtime image", async () => {
    const written: TillerConfig[] = [];
    const deps = baseDeps({
      writeConfig: vi.fn((config) => written.push(config)),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.targetImage).toBe(TARGET_IMAGE);
    expect(deps.pullImage).toHaveBeenCalledWith(TARGET_IMAGE);
    expect(written[0]?.localRunnerImage).toBe(TARGET_IMAGE);
  });

  it("uses currentRelease.selfHostRuntimeImage when present", async () => {
    const runtimeDigest = "2".repeat(64);
    const runtimeImage = `docker.io/jamieatlason/tiller-sandbox@sha256:${runtimeDigest}`;
    const written: TillerConfig[] = [];
    const deps = baseDeps({
      fetchUpdateCheck: vi.fn(async () => ({
        kind: "installer-managed" as const,
        currentRelease: {
          ...CURRENT_RELEASE,
          selfHostRuntimeImage: runtimeImage,
        },
        errors: [],
      })),
      writeConfig: vi.fn((config) => written.push(config)),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(result.targetImage).toBe(runtimeImage);
    expect(deps.pullImage).toHaveBeenCalledWith(runtimeImage);
    expect(written[0]?.localRunnerImage).toBe(runtimeImage);
  });

  it("fails malformed selfHostRuntimeImage metadata before mutation", async () => {
    const deps = baseDeps({
      fetchUpdateCheck: vi.fn(async () => ({
        kind: "installer-managed" as const,
        currentRelease: {
          ...CURRENT_RELEASE,
          selfHostRuntimeImage: "docker.io/jamieatlason/tiller-sandbox:stable",
        },
        errors: [],
      })),
    });

    await expect(runHostUpdate({ yes: true }, deps)).rejects.toThrow("currentRelease.selfHostRuntimeImage");
    expect(deps.pullImage).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("allows update-check issues when current runtime metadata is valid", async () => {
    const deps = baseDeps({
      fetchUpdateCheck: vi.fn(async () => ({
        kind: "installer-managed" as const,
        currentRelease: CURRENT_RELEASE,
        errors: [{ code: "stable_release_unavailable", message: "service degraded" }],
      })),
    });

    await expect(runHostUpdate({ yes: true }, deps)).resolves.toMatchObject({
      ok: true,
      targetImage: TARGET_IMAGE,
    });
  });

  it("dry-run prints state without Docker, config, container, service, or prompt mutation", async () => {
    const log = vi.fn();
    const deps = baseDeps({ log });

    const result = await runHostUpdate({ dryRun: true }, deps);

    expect(result.ok).toBe(true);
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain("current image: docker.io/jamieatlason/tiller-sandbox:stable");
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain(`target image: ${TARGET_IMAGE}`);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.pullImage).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.restartSystemdService).not.toHaveBeenCalled();
  });

  it("refuses shell env image overrides before mutation", async () => {
    const deps = baseDeps({
      env: { TILLER_LOCAL_RUNNER_IMAGE: "custom" },
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.blockers.join("\n")).toContain("TILLER_LOCAL_RUNNER_IMAGE");
    expect(deps.pullImage).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("refuses configured custom image refs", async () => {
    const deps = baseDeps({
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        localRunnerImage: "ghcr.io/example/custom:latest",
      })),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.blockers.join("\n")).toContain("tiller host update cannot safely manage custom images");
    expect(deps.pullImage).not.toHaveBeenCalled();
  });

  it("accepts unqualified managed stable image refs", async () => {
    const deps = baseDeps({
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        localRunnerImage: "jamieatlason/tiller-sandbox:stable",
      })),
    });

    await expect(runHostUpdate({ yes: true }, deps)).resolves.toMatchObject({ ok: true });
    expect(deps.pullImage).toHaveBeenCalledWith(TARGET_IMAGE);
  });

  it("fails both active systemd services before pull, config write, or container removal", async () => {
    const deps = baseDeps({
      getActiveSystemdServices: vi.fn(() => [
        { scope: "user", serviceName: "tiller-host.service", unitPath: "/home/pi/.config/systemd/user/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
        { scope: "system", serviceName: "tiller-host.service", unitPath: "/etc/systemd/system/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
      ]),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.blockers.join("\n")).toContain("Both the user and system");
    expect(deps.pullImage).not.toHaveBeenCalled();
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("fails active service config path mismatch with service-user guidance", async () => {
    const deps = baseDeps({
      configPath: "/root/.config/tiller/config.json",
      getActiveSystemdServices: vi.fn(() => [
        { scope: "system", serviceName: "tiller-host.service", unitPath: "/etc/systemd/system/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
      ]),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(false);
    expect(result.blockers.join("\n")).toContain("Run `tiller host update` as the service user");
    expect(deps.pullImage).not.toHaveBeenCalled();
  });

  it("reports manual host processes in dry-run and does not auto-restart them", async () => {
    const log = vi.fn();
    const deps = baseDeps({
      log,
      readActiveHostPidRecord: vi.fn(() => ({ pid: 1234, startedAt: "2026-06-10T00:00:00.000Z" })),
    });

    await runHostUpdate({ dryRun: true }, deps);
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain("manual host process: active [pid 1234]");

    await runHostUpdate({ yes: true }, deps);
    expect(deps.restartSystemdService).not.toHaveBeenCalled();
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain("Restart the active `tiller host` process [pid 1234] manually");
  });

  it("already-pinned target leaves workload containers unchanged and restarts the host", async () => {
    const log = vi.fn();
    const deps = baseDeps({
      log,
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        localRunnerImage: TARGET_IMAGE,
      })),
      getActiveSystemdServices: vi.fn(() => [
        { scope: "user", serviceName: "tiller-host.service", unitPath: "/home/pi/.config/systemd/user/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
      ]),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain(`localRunnerImage already pinned to ${TARGET_IMAGE}`);
    expect(deps.pullImage).toHaveBeenCalledWith(TARGET_IMAGE);
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain("existing workload containers were left unchanged");
    expect(deps.restartSystemdService).toHaveBeenCalledWith("user");
  });

  it("preserves non-image config fields without touching workload containers", async () => {
    const order: string[] = [];
    const written: TillerConfig[] = [];
    const deps = baseDeps({
      loadConfig: vi.fn(() => ({
        hubUrl: "https://demo.preview.workers.dev",
        localRunnerImage: "docker.io/jamieatlason/tiller-sandbox:stable",
        machineId: "machine-1",
      })),
      confirm: vi.fn(async () => {
        order.push("confirm");
        return true;
      }),
      pullImage: vi.fn(async () => {
        order.push("pull");
      }),
      writeConfig: vi.fn((config) => {
        order.push("write");
        written.push(config);
      }),
    });

    await runHostUpdate({}, deps);

    expect(order).toEqual(["confirm", "pull", "write"]);
    expect(written[0]).toMatchObject({
      hubUrl: "https://demo.preview.workers.dev",
      localRunnerImage: TARGET_IMAGE,
      machineId: "machine-1",
    });
  });

  it("restarts an installed macOS launchd service without inspecting systemd", async () => {
    const restart = vi.fn(() => ({
      platform: "launchd" as const,
      installed: true,
      running: true,
      definitionPath: "/Users/test/Library/LaunchAgents/dev.tiller.host.plist",
      serviceName: "dev.tiller.host",
    }));
    const inspect = vi.fn(() => ({
      platform: "launchd" as const,
      installed: true,
      running: true,
      definitionPath: "/Users/test/Library/LaunchAgents/dev.tiller.host.plist",
      serviceName: "dev.tiller.host",
    }));
    const deps = baseDeps({
      platform: "darwin",
      hostSupervisor: {
        inspect,
        restart,
        stop: vi.fn(),
        installOrUpdate: vi.fn(),
      },
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(restart).toHaveBeenCalledOnce();
    expect(deps.getActiveSystemdServices).not.toHaveBeenCalled();
    expect(deps.checkLocalRunnerHealth).toHaveBeenCalled();
  });

  it("restarts the active user systemd service and requires local runner health", async () => {
    const deps = baseDeps({
      getActiveSystemdServices: vi.fn(() => [
        { scope: "user", serviceName: "tiller-host.service", unitPath: "/home/pi/.config/systemd/user/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
      ]),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(deps.restartSystemdService).toHaveBeenCalledWith("user");
    expect(deps.checkLocalRunnerHealth).toHaveBeenCalled();
  });

  it("prints manual instructions and succeeds when system service restart is not permitted", async () => {
    const log = vi.fn();
    const deps = baseDeps({
      log,
      getActiveSystemdServices: vi.fn(() => [
        { scope: "system", serviceName: "tiller-host.service", unitPath: "/etc/systemd/system/tiller-host.service", configPath: "/home/pi/.config/tiller/config.json" },
      ]),
      restartSystemdService: vi.fn(() => ({ scope: "system", ok: false, command: "sudo -n systemctl restart tiller-host.service", stderr: "a password is required" })),
    });

    const result = await runHostUpdate({ yes: true }, deps);

    expect(result.ok).toBe(true);
    expect(log.mock.calls.map((call) => call[0]).join("\n")).toContain("sudo systemctl restart tiller-host.service");
    expect(deps.checkLocalRunnerHealth).not.toHaveBeenCalled();
  });
});
