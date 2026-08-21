import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOME_DIR } from "./config.js";

export interface HostServiceCommand {
  command: string;
  args: string[];
}

export type SystemdServiceScope = "user" | "system";

interface BaseSystemdServiceOptions {
  homeDir?: string;
  pathEnv?: string;
  serviceCommand: HostServiceCommand;
  extraEnv?: Record<string, string | undefined>;
}

export interface UserSystemdServiceOptions extends BaseSystemdServiceOptions {}

export interface SystemSystemdServiceOptions extends BaseSystemdServiceOptions {
  serviceUser: string;
}

export interface InstallSystemdServiceResult {
  scope: SystemdServiceScope;
  unitPath: string;
  serviceName: string;
  daemonReloaded: boolean;
  enabled: boolean;
  started: boolean;
  lingerEnabled: boolean | null;
  serviceUser?: string;
  homeDir: string;
  configPath: string;
}

export interface ActiveSystemdService {
  scope: SystemdServiceScope;
  serviceName: string;
  unitPath: string | null;
  configPath: string | null;
}

export interface SystemdRestartResult {
  scope: SystemdServiceScope;
  ok: boolean;
  command: string;
  stderr?: string;
}

const SERVICE_NAME = "tiller-host.service";
const SYSTEM_UNIT_PATH = "/etc/systemd/system/tiller-host.service";

function systemdQuote(value: string): string {
  const escaped = value
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
  return /[\s"'\\]/.test(value) ? `"${escaped}"` : escaped;
}

function environmentLine(key: string, value: string): string {
  return `Environment=${systemdQuote(`${key}=${value}`)}`;
}

function runCommand(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function commandAvailable(command: string): boolean {
  return runCommand("/bin/sh", ["-lc", `command -v ${command}`]).ok;
}

export function userSystemdUnitPathForHome(homeDir: string): string {
  return resolve(homeDir, ".config", "systemd", "user", SERVICE_NAME);
}

export function systemSystemdUnitPath(): string {
  return SYSTEM_UNIT_PATH;
}

export function tillerConfigDirForHome(homeDir: string): string {
  return resolve(homeDir, ".config", "tiller");
}

export function tillerConfigPathForHome(homeDir: string): string {
  return resolve(tillerConfigDirForHome(homeDir), "config.json");
}

function splitSystemdEnvironment(raw: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  let escaping = false;

  for (const char of raw.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (!quoted && /\s/.test(char)) {
      if (current) {
        values.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    values.push(current);
  }

  return values;
}

function parseEnvironmentValue(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const token of splitSystemdEnvironment(raw)) {
    const separator = token.indexOf("=");
    if (separator <= 0) continue;
    values[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return values;
}

function parseSystemctlShow(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function inspectSystemdService(scope: SystemdServiceScope): ActiveSystemdService | null {
  if (process.platform !== "linux" || !commandAvailable("systemctl")) {
    return null;
  }

  const args = [
    ...(scope === "user" ? ["--user"] : []),
    "show",
    SERVICE_NAME,
    "--property=ActiveState",
    "--property=FragmentPath",
    "--property=Environment",
    "--no-pager",
  ];
  const show = runCommand("systemctl", args);
  if (!show.ok) {
    return null;
  }

  const values = parseSystemctlShow(show.stdout);
  if (values.ActiveState !== "active") {
    return null;
  }

  const fallbackUnitPath = scope === "user"
    ? userSystemdUnitPathForHome(HOME_DIR)
    : systemSystemdUnitPath();
  const unitPath = values.FragmentPath?.trim() || (existsSync(fallbackUnitPath) ? fallbackUnitPath : null);
  const environment = values.Environment ? parseEnvironmentValue(values.Environment) : {};
  const configPath = environment.TILLER_CONFIG_PATH?.trim()
    || (environment.HOME?.trim() ? tillerConfigPathForHome(environment.HOME.trim()) : null);

  return {
    scope,
    serviceName: SERVICE_NAME,
    unitPath,
    configPath,
  };
}

export function getActiveSystemdServices(): ActiveSystemdService[] {
  return (["user", "system"] as const)
    .map((scope) => inspectSystemdService(scope))
    .filter((service): service is ActiveSystemdService => Boolean(service));
}

export function restartSystemdService(scope: SystemdServiceScope): SystemdRestartResult {
  const args = scope === "user"
    ? ["--user", "restart", SERVICE_NAME]
    : ["restart", SERVICE_NAME];
  if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
    const sudo = runCommand("sudo", ["-n", "systemctl", ...args]);
    return {
      scope,
      ok: sudo.ok,
      command: `sudo -n systemctl ${args.join(" ")}`,
      ...(sudo.stderr ? { stderr: sudo.stderr } : {}),
    };
  }

  const restart = runCommand("systemctl", args);
  return {
    scope,
    ok: restart.ok,
    command: `systemctl ${args.join(" ")}`,
    ...(restart.stderr ? { stderr: restart.stderr } : {}),
  };
}

export function stopSystemdService(scope: SystemdServiceScope): SystemdRestartResult {
  const args = scope === "user"
    ? ["--user", "stop", SERVICE_NAME]
    : ["stop", SERVICE_NAME];
  if (scope === "system" && typeof process.getuid === "function" && process.getuid() !== 0) {
    const sudo = runCommand("sudo", ["-n", "systemctl", ...args]);
    return {
      scope,
      ok: sudo.ok,
      command: `sudo -n systemctl ${args.join(" ")}`,
      ...(sudo.stderr ? { stderr: sudo.stderr } : {}),
    };
  }

  const stopped = runCommand("systemctl", args);
  return {
    scope,
    ok: stopped.ok,
    command: `systemctl ${args.join(" ")}`,
    ...(stopped.stderr ? { stderr: stopped.stderr } : {}),
  };
}

function buildSystemdService(
  options: BaseSystemdServiceOptions & {
    scope: SystemdServiceScope;
    serviceUser?: string;
  },
): string {
  const homeDir = options.homeDir ?? HOME_DIR;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const execStart = [options.serviceCommand.command, ...options.serviceCommand.args]
    .map((value) => systemdQuote(value))
    .join(" ");
  const environment = {
    HOME: homeDir,
    PATH: pathEnv,
    TILLER_CONFIG_DIR: tillerConfigDirForHome(homeDir),
    ...(options.extraEnv ?? {}),
  };
  const envLines = (Object.entries(environment) as Array<[string, string | undefined]>)
    .reduce<string[]>((lines, [key, value]) => {
      if (value && value.trim()) {
        lines.push(environmentLine(key, value));
      }
      return lines;
    }, [])
    .join("\n");

  return [
    "[Unit]",
    "Description=Tiller execution machine",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdQuote(homeDir)}`,
    ...(options.scope === "system" && options.serviceUser
      ? [`User=${systemdQuote(options.serviceUser)}`]
      : []),
    envLines,
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "KillSignal=SIGTERM",
    "KillMode=mixed",
    "TimeoutStopSec=15s",
    "",
    "[Install]",
    options.scope === "system" ? "WantedBy=multi-user.target" : "WantedBy=default.target",
    "",
  ].join("\n");
}

export function buildUserSystemdService(options: UserSystemdServiceOptions): string {
  return buildSystemdService({
    ...options,
    scope: "user",
  });
}

export function buildSystemSystemdService(options: SystemSystemdServiceOptions): string {
  return buildSystemdService({
    ...options,
    scope: "system",
  });
}

export function resolveHostServiceCommand(): HostServiceCommand {
  const tillerOnPath = runCommand("/bin/sh", ["-lc", "command -v tiller"]);
  if (tillerOnPath.ok && tillerOnPath.stdout) {
    return {
      command: tillerOnPath.stdout,
      args: ["host"],
    };
  }

  const scriptPath = process.argv[1]?.trim();
  if (scriptPath) {
    return {
      command: process.execPath,
      args: [resolve(scriptPath), "host"],
    };
  }

  throw new Error("Could not resolve a stable command for `tiller host`");
}

function assertLinuxSystemdHost(): void {
  if (process.platform !== "linux") {
    throw new Error("This service operation requires Linux systemd.");
  }

  const systemctl = runCommand("systemctl", ["--version"]);
  if (!systemctl.ok) {
    throw new Error("systemctl is not available on this machine");
  }
}

function resolveLinuxHomeDir(user: string): string {
  const passwd = runCommand("getent", ["passwd", user]);
  if (passwd.ok && passwd.stdout) {
    const homeDir = passwd.stdout.split(":")[5]?.trim();
    if (homeDir) return homeDir;
  }

  if (process.env.USER?.trim() === user) {
    const homeDir = process.env.HOME?.trim();
    if (homeDir) return homeDir;
  }

  throw new Error(`Could not determine the home directory for ${user}`);
}

function resolveSystemServiceUser(): string {
  const sudoUser = process.env.SUDO_USER?.trim();
  if (sudoUser && sudoUser !== "root") {
    return sudoUser;
  }

  const user = process.env.USER?.trim();
  if (user && user !== "root") {
    return user;
  }

  throw new Error(
    "Run `sudo tiller host install-service --system` from the account that should own the execution-machine config.",
  );
}

export function installUserSystemdService(): InstallSystemdServiceResult {
  assertLinuxSystemdHost();

  const homeDir = HOME_DIR;
  const unitPath = userSystemdUnitPathForHome(homeDir);
  const configPath = process.env.TILLER_CONFIG_PATH || tillerConfigPathForHome(homeDir);
  mkdirSync(resolve(homeDir, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(
    unitPath,
    buildUserSystemdService({
      homeDir,
      pathEnv: process.env.PATH ?? "",
      serviceCommand: resolveHostServiceCommand(),
      extraEnv: {
        TILLER_CONFIG_PATH: configPath,
        TILLER_DOTENV_PATH: process.env.TILLER_DOTENV_PATH,
      },
    }),
  );

  const daemonReload = runCommand("systemctl", ["--user", "daemon-reload"]);
  const enable = daemonReload.ok
    ? runCommand("systemctl", ["--user", "enable", SERVICE_NAME])
    : { ok: false, stdout: "", stderr: daemonReload.stderr };
  const start = enable.ok
    ? runCommand("systemctl", ["--user", "restart", SERVICE_NAME])
    : { ok: false, stdout: "", stderr: enable.stderr };

  const linger = process.env.USER
    ? runCommand("loginctl", ["show-user", process.env.USER, "--property=Linger", "--value"])
    : { ok: false, stdout: "", stderr: "" };

  return {
    scope: "user",
    unitPath,
    serviceName: SERVICE_NAME,
    daemonReloaded: daemonReload.ok,
    enabled: enable.ok,
    started: start.ok,
    lingerEnabled: linger.ok ? linger.stdout.trim() === "yes" : null,
    homeDir,
    configPath,
  };
}

export function installSystemSystemdService(): InstallSystemdServiceResult {
  assertLinuxSystemdHost();

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    throw new Error("System service install requires root. Re-run with `sudo`, or use `--user`.");
  }

  const serviceUser = resolveSystemServiceUser();
  const homeDir = resolveLinuxHomeDir(serviceUser);
  const unitPath = systemSystemdUnitPath();
  const configPath = tillerConfigPathForHome(homeDir);

  if (!existsSync(configPath)) {
    throw new Error(
      `No execution-machine config was found for ${serviceUser} at ${configPath}. Run \`tiller host setup\` as ${serviceUser} first.`,
    );
  }

  writeFileSync(
    unitPath,
    buildSystemSystemdService({
      homeDir,
      serviceUser,
      pathEnv: process.env.PATH ?? "",
      serviceCommand: resolveHostServiceCommand(),
      extraEnv: {
        TILLER_CONFIG_PATH: configPath,
        TILLER_DOTENV_PATH: resolve(tillerConfigDirForHome(homeDir), ".env"),
      },
    }),
  );

  const daemonReload = runCommand("systemctl", ["daemon-reload"]);
  const enable = daemonReload.ok
    ? runCommand("systemctl", ["enable", SERVICE_NAME])
    : { ok: false, stdout: "", stderr: daemonReload.stderr };
  const start = enable.ok
    ? runCommand("systemctl", ["restart", SERVICE_NAME])
    : { ok: false, stdout: "", stderr: enable.stderr };

  return {
    scope: "system",
    unitPath,
    serviceName: SERVICE_NAME,
    daemonReloaded: daemonReload.ok,
    enabled: enable.ok,
    started: start.ok,
    lingerEnabled: null,
    serviceUser,
    homeDir,
    configPath,
  };
}
