import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_PATH, HOME_DIR } from "./config.js";
import {
  getActiveSystemdServices,
  installSystemSystemdService,
  installUserSystemdService,
  resolveHostServiceCommand,
  restartSystemdService,
  stopSystemdService,
  systemSystemdUnitPath,
  userSystemdUnitPathForHome,
  type ActiveSystemdService,
  type InstallSystemdServiceResult,
  type SystemdRestartResult,
  type SystemdServiceScope,
} from "./host-service.js";

export type HostSupervisorPlatform = "systemd" | "launchd";

export interface HostSupervisorInspection {
  platform: HostSupervisorPlatform;
  installed: boolean;
  running: boolean;
  definitionPath: string;
  serviceName: string;
  scope?: SystemdServiceScope;
  configPath?: string | null;
}

export interface HostSupervisorInstallResult extends HostSupervisorInspection {
  started: boolean;
  daemonReloaded?: boolean;
  enabled?: boolean;
  lingerEnabled?: boolean | null;
  serviceUser?: string;
  configPath?: string | null;
}

export interface HostSupervisor {
  installOrUpdate(): HostSupervisorInstallResult;
  restart(): HostSupervisorInspection;
  stop(): HostSupervisorInspection;
  inspect(): HostSupervisorInspection;
}

export class HostSupervisorRestartError extends Error {
  constructor(
    message: string,
    readonly result: SystemdRestartResult,
  ) {
    super(message);
    this.name = "HostSupervisorRestartError";
  }
}

export interface HostSupervisorOptions {
  systemdScope?: SystemdServiceScope;
  getActiveSystemdServices?: () => ActiveSystemdService[];
  installUserSystemdService?: () => InstallSystemdServiceResult;
  installSystemSystemdService?: () => InstallSystemdServiceResult;
  restartSystemdService?: (scope: SystemdServiceScope) => SystemdRestartResult;
  stopSystemdService?: (scope: SystemdServiceScope) => SystemdRestartResult;
  configPath?: string;
}

export const LAUNCHD_LABEL = "dev.tiller.host";
export const LAUNCHD_FILE_NAME = `${LAUNCHD_LABEL}.plist`;

function run(
  command: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function launchdPlistPath(homeDir = HOME_DIR): string {
  return resolve(homeDir, "Library", "LaunchAgents", LAUNCHD_FILE_NAME);
}

export function buildLaunchdPlist(options: {
  command: string;
  args: string[];
  homeDir?: string;
  pathEnv?: string;
  configPath?: string;
}): string {
  const homeDir = options.homeDir ?? HOME_DIR;
  const configPath = options.configPath ?? resolve(homeDir, ".config", "tiller", "config.json");
  const logsDir = resolve(homeDir, "Library", "Logs");
  const programArguments = [options.command, ...options.args]
    .map((argument) => `      <string>${xml(argument)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    <string>${xml(homeDir)}</string>`,
    "    <key>PATH</key>",
    `    <string>${xml(options.pathEnv ?? process.env.PATH ?? "")}</string>`,
    "    <key>TILLER_CONFIG_PATH</key>",
    `    <string>${xml(configPath)}</string>`,
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(homeDir)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${xml(resolve(logsDir, "tiller-host.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(resolve(logsDir, "tiller-host.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

class SystemdHostSupervisor implements HostSupervisor {
  constructor(
    private readonly scope: SystemdServiceScope,
    private readonly options: HostSupervisorOptions,
  ) {}

  inspect(): HostSupervisorInspection {
    const expectedDefinitionPath = this.scope === "user"
      ? userSystemdUnitPathForHome(HOME_DIR)
      : systemSystemdUnitPath();
    const active = (
      this.options.getActiveSystemdServices ?? getActiveSystemdServices
    )().find((service) => service.scope === this.scope);
    const definitionPath = active?.unitPath ?? expectedDefinitionPath;
    return {
      platform: "systemd",
      installed: Boolean(active) || existsSync(definitionPath),
      running: Boolean(active),
      definitionPath,
      serviceName: "tiller-host.service",
      scope: this.scope,
      configPath: active?.configPath ?? null,
    };
  }

  installOrUpdate(): HostSupervisorInstallResult {
    const installed = this.scope === "user"
      ? (this.options.installUserSystemdService ?? installUserSystemdService)()
      : (this.options.installSystemSystemdService ?? installSystemSystemdService)();
    return {
      ...this.inspect(),
      installed: true,
      definitionPath: installed.unitPath,
      started: installed.started,
      daemonReloaded: installed.daemonReloaded,
      enabled: installed.enabled,
      lingerEnabled: installed.lingerEnabled,
      ...(installed.serviceUser ? { serviceUser: installed.serviceUser } : {}),
      configPath: installed.configPath,
    };
  }

  restart(): HostSupervisorInspection {
    const result = (
      this.options.restartSystemdService ?? restartSystemdService
    )(this.scope);
    if (!result.ok) {
      throw new HostSupervisorRestartError(
        `Could not restart ${result.command}${result.stderr ? `: ${result.stderr}` : ""}`,
        result,
      );
    }
    return this.inspect();
  }

  stop(): HostSupervisorInspection {
    const result = (
      this.options.stopSystemdService ?? stopSystemdService
    )(this.scope);
    if (!result.ok) {
      throw new Error(
        `Could not stop ${result.command}${result.stderr ? `: ${result.stderr}` : ""}`,
      );
    }
    return this.inspect();
  }
}

class LaunchdHostSupervisor implements HostSupervisor {
  private readonly domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
  private readonly definitionPath = launchdPlistPath();

  constructor(private readonly options: HostSupervisorOptions) {}

  inspect(): HostSupervisorInspection {
    const status = run("launchctl", ["print", `${this.domain}/${LAUNCHD_LABEL}`]);
    return {
      platform: "launchd",
      installed: existsSync(this.definitionPath),
      running: status.ok,
      definitionPath: this.definitionPath,
      serviceName: LAUNCHD_LABEL,
      configPath: this.options.configPath ?? CONFIG_PATH,
    };
  }

  installOrUpdate(): HostSupervisorInstallResult {
    const command = resolveHostServiceCommand();
    mkdirSync(resolve(HOME_DIR, "Library", "LaunchAgents"), { recursive: true });
    mkdirSync(resolve(HOME_DIR, "Library", "Logs"), { recursive: true });
    writeFileSync(this.definitionPath, buildLaunchdPlist({
      command: command.command,
      args: command.args,
      homeDir: HOME_DIR,
      pathEnv: process.env.PATH ?? "",
      configPath: this.options.configPath ?? CONFIG_PATH,
    }), { mode: 0o600 });
    run("launchctl", ["bootout", `${this.domain}/${LAUNCHD_LABEL}`]);
    const bootstrap = run("launchctl", ["bootstrap", this.domain, this.definitionPath]);
    if (!bootstrap.ok) {
      throw new Error(`Could not install ${LAUNCHD_LABEL}${bootstrap.stderr ? `: ${bootstrap.stderr}` : ""}`);
    }
    const kickstart = run("launchctl", ["kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`]);
    return {
      ...this.inspect(),
      installed: true,
      started: kickstart.ok,
    };
  }

  restart(): HostSupervisorInspection {
    const result = run("launchctl", ["kickstart", "-k", `${this.domain}/${LAUNCHD_LABEL}`]);
    if (!result.ok) {
      throw new Error(`Could not restart ${LAUNCHD_LABEL}${result.stderr ? `: ${result.stderr}` : ""}`);
    }
    return this.inspect();
  }

  stop(): HostSupervisorInspection {
    const result = run("launchctl", ["bootout", `${this.domain}/${LAUNCHD_LABEL}`]);
    if (!result.ok) {
      throw new Error(`Could not stop ${LAUNCHD_LABEL}${result.stderr ? `: ${result.stderr}` : ""}`);
    }
    return this.inspect();
  }
}

export function createHostSupervisor(
  platform = process.platform,
  options: HostSupervisorOptions = {},
): HostSupervisor {
  if (platform === "linux") {
    return new SystemdHostSupervisor(options.systemdScope ?? "user", options);
  }
  if (platform === "darwin") return new LaunchdHostSupervisor(options);
  throw new Error("Persistent execution-machine services are supported on Linux and macOS.");
}

export function selectHostSupervisor(
  platform = process.platform,
  options: HostSupervisorOptions & {
    preferredSystemdScope?: SystemdServiceScope;
  } = {},
): HostSupervisor {
  if (platform !== "linux") {
    return createHostSupervisor(platform, options);
  }

  const activeServices = (
    options.getActiveSystemdServices ?? getActiveSystemdServices
  )();
  const sharedOptions: HostSupervisorOptions = {
    ...options,
    getActiveSystemdServices: () => activeServices,
  };
  const candidates = (["user", "system"] as const).map((scope) => {
    const supervisor = createHostSupervisor(platform, {
      ...sharedOptions,
      systemdScope: scope,
    });
    return { scope, supervisor, inspection: supervisor.inspect() };
  });
  const installed = candidates.filter((candidate) => candidate.inspection.installed);
  if (installed.length > 1) {
    throw new Error(
      "Both user and system tiller-host services are installed. Remove one before continuing.",
    );
  }

  const preferredScope = options.preferredSystemdScope;
  if (
    preferredScope
    && installed.length === 1
    && installed[0]!.scope !== preferredScope
  ) {
    throw new Error(
      `A ${installed[0]!.scope} tiller-host service is already installed. Reuse it or remove it before installing a ${preferredScope} service.`,
    );
  }

  const scope = preferredScope
    ?? installed[0]?.scope
    ?? options.systemdScope
    ?? "user";
  return createHostSupervisor(platform, {
    ...options,
    systemdScope: scope,
  });
}
