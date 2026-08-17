import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchdPlist,
  createHostSupervisor,
  launchdPlistPath,
  selectHostSupervisor,
} from "./host-supervisor.js";

describe("macOS execution-machine supervisor", () => {
  it("renders a persistent launchd service with the exact saved config", () => {
    const plist = buildLaunchdPlist({
      command: "/opt/Tiller & Tools/tiller",
      args: ["host"],
      homeDir: "/Users/ada",
      pathEnv: "/opt/homebrew/bin:/usr/bin",
      configPath: "/Users/ada/.config/tiller/config.json",
    });

    expect(plist).toContain("<string>dev.tiller.host</string>");
    expect(plist).toContain("<string>/opt/Tiller &amp; Tools/tiller</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/Users/ada/.config/tiller/config.json</string>");
    expect(launchdPlistPath("/Users/ada")).toBe(
      "/Users/ada/Library/LaunchAgents/dev.tiller.host.plist",
    );
  });
});

describe("Linux execution-machine supervisor", () => {
  it("routes system-scope inspection, installation, and restart through one supervisor", () => {
    const active = {
      scope: "system" as const,
      serviceName: "tiller-host.service",
      unitPath: "/etc/systemd/system/tiller-host.service",
      configPath: "/home/ada/.config/tiller/config.json",
    };
    const restartSystemdService = vi.fn(() => ({
      scope: "system" as const,
      ok: true,
      command: "systemctl restart tiller-host.service",
    }));
    const stopSystemdService = vi.fn(() => ({
      scope: "system" as const,
      ok: true,
      command: "systemctl stop tiller-host.service",
    }));
    const installSystemSystemdService = vi.fn(() => ({
      ...active,
      unitPath: active.unitPath,
      daemonReloaded: true,
      enabled: true,
      started: true,
      lingerEnabled: null,
      serviceUser: "ada",
      homeDir: "/home/ada",
      configPath: active.configPath,
    }));
    const supervisor = createHostSupervisor("linux", {
      systemdScope: "system",
      getActiveSystemdServices: () => [active],
      installSystemSystemdService,
      restartSystemdService,
      stopSystemdService,
    });

    expect(supervisor.inspect()).toMatchObject({
      platform: "systemd",
      scope: "system",
      installed: true,
      running: true,
    });
    expect(supervisor.installOrUpdate()).toMatchObject({
      scope: "system",
      serviceUser: "ada",
      started: true,
    });
    expect(supervisor.restart()).toMatchObject({
      scope: "system",
      running: true,
    });
    expect(supervisor.stop()).toMatchObject({
      scope: "system",
    });
    expect(installSystemSystemdService).toHaveBeenCalledOnce();
    expect(restartSystemdService).toHaveBeenCalledWith("system");
    expect(stopSystemdService).toHaveBeenCalledWith("system");
  });

  it("reuses the sole installed scope and rejects attempts to add a second service", () => {
    const active = {
      scope: "system" as const,
      serviceName: "tiller-host.service",
      unitPath: "/etc/systemd/system/tiller-host.service",
      configPath: "/home/ada/.config/tiller/config.json",
    };
    const getActiveSystemdServices = vi.fn(() => [active]);

    expect(selectHostSupervisor("linux", {
      getActiveSystemdServices,
    }).inspect()).toMatchObject({
      scope: "system",
      installed: true,
      running: true,
    });
    expect(() => selectHostSupervisor("linux", {
      preferredSystemdScope: "user",
      getActiveSystemdServices,
    })).toThrow("system tiller-host service is already installed");
  });

  it("fails closed when both systemd scopes are installed", () => {
    expect(() => selectHostSupervisor("linux", {
      getActiveSystemdServices: () => [
        {
          scope: "user",
          serviceName: "tiller-host.service",
          unitPath: "/home/ada/.config/systemd/user/tiller-host.service",
          configPath: "/home/ada/.config/tiller/config.json",
        },
        {
          scope: "system",
          serviceName: "tiller-host.service",
          unitPath: "/etc/systemd/system/tiller-host.service",
          configPath: "/home/ada/.config/tiller/config.json",
        },
      ],
    })).toThrow("Both user and system tiller-host services are installed");
  });
});
