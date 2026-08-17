import { describe, expect, it } from "vitest";
import {
  buildSystemSystemdService,
  buildUserSystemdService,
  systemSystemdUnitPath,
  tillerConfigPathForHome,
  userSystemdUnitPathForHome,
} from "./host-service.js";

describe("host systemd service helpers", () => {
  it("writes the user unit under the caller home directory", () => {
    expect(userSystemdUnitPathForHome("/home/pi")).toBe(
      "/home/pi/.config/systemd/user/tiller-host.service",
    );
  });

  it("renders a stable tiller host user service", () => {
    const service = buildUserSystemdService({
      homeDir: "/home/pi",
      pathEnv: "/usr/local/bin:/usr/bin",
      serviceCommand: {
        command: "/usr/local/bin/tiller",
        args: ["host"],
      },
      extraEnv: {
        TILLER_CONFIG_PATH: "/home/pi/custom config.json",
      },
    });

    expect(service).toContain("Description=Tiller execution machine");
    expect(service).toContain("WorkingDirectory=/home/pi");
    expect(service).toContain("Environment=HOME=/home/pi");
    expect(service).toContain("Environment=TILLER_CONFIG_DIR=/home/pi/.config/tiller");
    expect(service).toContain("Environment=PATH=/usr/local/bin:/usr/bin");
    expect(service).toContain("Environment=\"TILLER_CONFIG_PATH=/home/pi/custom config.json\"");
    expect(service).toContain("ExecStart=/usr/local/bin/tiller host");
    expect(service).toContain("KillMode=mixed");
    expect(service).toContain("TimeoutStopSec=15s");
    expect(service).toContain("WantedBy=default.target");
  });

  it("quotes commands and escapes systemd specifiers when needed", () => {
    const service = buildUserSystemdService({
      homeDir: "/srv/pi host",
      pathEnv: "/usr/bin",
      serviceCommand: {
        command: "/opt/tiller bin/tiller",
        args: ["host", "--flag=100%"],
      },
    });

    expect(service).toContain("WorkingDirectory=\"/srv/pi host\"");
    expect(service).toContain("ExecStart=\"/opt/tiller bin/tiller\" host --flag=100%%");
  });

  it("renders a system service that starts at boot for the target user", () => {
    const service = buildSystemSystemdService({
      homeDir: "/home/pi",
      serviceUser: "pi",
      pathEnv: "/usr/local/bin:/usr/bin",
      serviceCommand: {
        command: "/usr/local/bin/tiller",
        args: ["host"],
      },
      extraEnv: {
        TILLER_CONFIG_PATH: tillerConfigPathForHome("/home/pi"),
      },
    });

    expect(systemSystemdUnitPath()).toBe("/etc/systemd/system/tiller-host.service");
    expect(service).toContain("User=pi");
    expect(service).toContain("Environment=HOME=/home/pi");
    expect(service).toContain("Environment=TILLER_CONFIG_DIR=/home/pi/.config/tiller");
    expect(service).toContain("Environment=TILLER_CONFIG_PATH=/home/pi/.config/tiller/config.json");
    expect(service).toContain("WantedBy=multi-user.target");
  });
});
