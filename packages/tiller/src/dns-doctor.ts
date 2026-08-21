import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolve4 } from "node:dns/promises";
import { HUB_URL, LOCAL_STATE_DIR } from "./config.js";
import { ansi } from "./ansi.js";

const PUBLIC_DNS_PRIMARY = "1.1.1.1";
const PUBLIC_DNS_SECONDARY = "8.8.8.8";
const STATE_DIR = join(LOCAL_STATE_DIR || tmpdir(), "dns-doctor");
const RESOLVER_DIR = "/etc/resolver";

type DnsDoctorAction = "status" | "repair" | "restore";

interface DnsDoctorOptions {
  action: DnsDoctorAction;
  hostname?: string;
  networkService?: string;
}

interface DnsDoctorDependencies {
  platform: NodeJS.Platform;
  hubUrl: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

interface ScopedResolverState {
  mode: "absent" | "file";
  content?: string;
}

function usage(): void {
  process.stderr.write("Usage: tiller doctor dns [status|repair|restore] [--hostname example.com] [--network-service \"Wi-Fi\"]\n");
}

function runCommand(command: string, args: string[], inherit = false): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function sanitizeServiceName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

function stateFileForHostname(hostname: string): string {
  return join(STATE_DIR, `host-${sanitizeServiceName(hostname)}.json`);
}

function resolverFileForHostname(hostname: string): string {
  return join(RESOLVER_DIR, hostname);
}

function parseHostnameFromUrl(hubUrl: string): string {
  try {
    return new URL(hubUrl).hostname || "";
  } catch {
    return "";
  }
}

export function parseDnsDoctorArgs(argv: string[]): DnsDoctorOptions {
  let action: DnsDoctorAction = "status";
  let hostname: string | undefined;
  let networkService: string | undefined;
  let actionSet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hostname" || arg === "--host") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      hostname = value.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--hostname=") || arg.startsWith("--host=")) {
      const value = arg.slice(arg.indexOf("=") + 1).trim();
      if (!value) throw new Error("hostname requires a value");
      hostname = value;
      continue;
    }
    if (arg === "--network-service") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--network-service requires a value");
      }
      networkService = value.trim();
      i += 1;
      continue;
    }
    if (arg.startsWith("--network-service=")) {
      const value = arg.slice("--network-service=".length).trim();
      if (!value) throw new Error("network service requires a value");
      networkService = value;
      continue;
    }
    if (!actionSet && (arg === "status" || arg === "repair" || arg === "restore")) {
      action = arg;
      actionSet = true;
      continue;
    }
    if (!hostname) {
      hostname = arg.trim();
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { action, ...(hostname ? { hostname } : {}), ...(networkService ? { networkService } : {}) };
}

export function resolveDnsDoctorHostname(options: DnsDoctorOptions, dependencies: DnsDoctorDependencies): string {
  const explicit = options.hostname?.trim();
  if (explicit) return explicit;

  const inferred = parseHostnameFromUrl(dependencies.hubUrl);
  if (inferred) return inferred;

  throw new Error("No hostname provided and no hub URL is configured. Pass --hostname or run `tiller init`.");
}

function readLocalResolverMac(hostname: string): string[] {
  const result = runCommand("dscacheutil", ["-q", "host", "-a", "name", hostname]);
  if (!result.ok) return [];

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("ip_address: "))
    .map((line) => line.slice("ip_address: ".length).trim())
    .filter(Boolean);
}

async function readLocalResolver(hostname: string, platform: NodeJS.Platform): Promise<string[]> {
  if (platform === "darwin") {
    return readLocalResolverMac(hostname);
  }

  try {
    return await resolve4(hostname);
  } catch {
    return [];
  }
}

async function readPublicResolver(hostname: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (!response.ok) return [];

    const body = await response.json() as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };

    if (body.Status !== 0 || !Array.isArray(body.Answer)) return [];

    return body.Answer
      .filter((answer) => answer?.type === 1 && typeof answer.data === "string")
      .map((answer) => answer.data!.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function verifyHostnameViaIp(hostname: string, ip: string): boolean {
  const result = runCommand("curl", [
    "--connect-timeout",
    "5",
    "--resolve",
    `${hostname}:443:${ip}`,
    "-I",
    "-sS",
    `https://${hostname}/`,
  ]);
  return result.ok;
}

function printDnsServers(service: string): string {
  const result = runCommand("networksetup", ["-getdnsservers", service]);
  return result.ok ? result.stdout.trim() : result.stderr.trim();
}

function defaultInterface(): string {
  const result = runCommand("route", ["-n", "get", "default"]);
  if (!result.ok) return "";
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.includes("interface:"));
  return line?.split("interface:")[1]?.trim() || "";
}

function serviceForInterface(iface: string): string {
  const result = runCommand("networksetup", ["-listnetworkserviceorder"]);
  if (!result.ok) return "";

  const lines = result.stdout.split(/\r?\n/);
  let currentService = "";
  for (const line of lines) {
    const serviceMatch = line.match(/^\(\d+\)\s+(.*)$/);
    if (serviceMatch) {
      currentService = serviceMatch[1].replace(/^\*\s+/, "").trim();
      continue;
    }
    if (line.includes(`Device: ${iface})`)) {
      return currentService;
    }
  }
  return "";
}

function resolveNetworkService(explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  const iface = defaultInterface();
  if (!iface) {
    throw new Error("Could not determine the default network interface. Pass --network-service explicitly.");
  }
  const service = serviceForInterface(iface);
  if (!service) {
    throw new Error(`Could not map interface ${iface} to a macOS network service. Pass --network-service explicitly.`);
  }
  return service;
}

function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

function saveScopedResolverState(hostname: string): void {
  ensureStateDir();
  const statePath = stateFileForHostname(hostname);
  if (existsSync(statePath)) return;

  const resolverPath = resolverFileForHostname(hostname);
  const state: ScopedResolverState = existsSync(resolverPath)
    ? { mode: "file", content: readFileSync(resolverPath, "utf8") }
    : { mode: "absent" };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function renderScopedResolverConfig(hostname: string): string {
  return [
    `# Added by tiller doctor dns repair for ${hostname}`,
    `nameserver ${PUBLIC_DNS_PRIMARY}`,
    `nameserver ${PUBLIC_DNS_SECONDARY}`,
    "",
  ].join("\n");
}

function writeScopedResolver(hostname: string, content: string): void {
  ensureStateDir();
  const destination = resolverFileForHostname(hostname);
  const tempPath = join(STATE_DIR, `${sanitizeServiceName(hostname)}.resolver.tmp`);
  writeFileSync(tempPath, content);

  try {
    const ensureDir = runCommand("sudo", ["mkdir", "-p", RESOLVER_DIR], true);
    if (!ensureDir.ok) throw new Error(`Failed to create ${RESOLVER_DIR}.`);

    const copy = runCommand("sudo", ["cp", tempPath, destination], true);
    if (!copy.ok) throw new Error(`Failed to write scoped resolver for ${hostname}.`);

    const chmod = runCommand("sudo", ["chmod", "644", destination], true);
    if (!chmod.ok) throw new Error(`Failed to set permissions on scoped resolver for ${hostname}.`);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function installScopedResolver(hostname: string): void {
  writeScopedResolver(hostname, renderScopedResolverConfig(hostname));
}

function restoreScopedResolverState(hostname: string): void {
  const statePath = stateFileForHostname(hostname);
  const state = JSON.parse(readFileSync(statePath, "utf8")) as ScopedResolverState;
  const resolverPath = resolverFileForHostname(hostname);

  if (state.mode === "absent") {
    const result = runCommand("sudo", ["rm", "-f", resolverPath], true);
    if (!result.ok) throw new Error(`Failed to remove scoped resolver for ${hostname}.`);
  } else if (state.mode === "file" && typeof state.content === "string") {
    writeScopedResolver(hostname, state.content);
  } else {
    throw new Error(`Invalid saved DNS repair state for ${hostname}.`);
  }

  flushMacDns();
  rmSync(statePath, { force: true });
}

function flushMacDns(): void {
  const flush = runCommand("sudo", ["dscacheutil", "-flushcache"], true);
  if (!flush.ok) throw new Error("Failed to flush the macOS DNS cache.");
  const reload = runCommand("sudo", ["killall", "-HUP", "mDNSResponder"], true);
  if (!reload.ok) throw new Error("Failed to reload mDNSResponder.");
}

async function printStatus(hostname: string, service: string | null, platform: NodeJS.Platform): Promise<{
  localIps: string[];
  publicIps: string[];
}> {
  const localIps = await readLocalResolver(hostname, platform);
  const publicIps = await readPublicResolver(hostname);

  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} DNS doctor for ${hostname}\n`);
  if (service) {
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Network service ${ansi.dim}${service}${ansi.reset}\n`);
    const dnsServers = printDnsServers(service);
    if (dnsServers) {
      const rendered = dnsServers.replace(/\r?\n/g, ", ");
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} DNS servers ${ansi.dim}${rendered}${ansi.reset}\n`);
    }
  }
  if (platform === "darwin") {
    const resolverPath = resolverFileForHostname(hostname);
    if (existsSync(resolverPath)) {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Scoped resolver ${ansi.dim}${resolverPath}${ansi.reset}\n`);
    }
  }

  const localDetail = localIps.length > 0 ? localIps.join(", ") : "(no local result)";
  const publicDetail = publicIps.length > 0 ? publicIps.join(", ") : "(no public result)";
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Local resolver ${ansi.dim}${localDetail}${ansi.reset}\n`);
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Public DNS ${ansi.dim}${publicDetail}${ansi.reset}\n`);

  if (publicIps.length > 0) {
    const reachable = publicIps.some((ip) => verifyHostnameViaIp(hostname, ip));
    process.stderr.write(
      `${ansi.bold}[tiller]${ansi.reset} Public route ${ansi.dim}${reachable ? "reachable" : "not reachable"}${ansi.reset}\n`,
    );
  }

  return { localIps, publicIps };
}

function printMacOnlyMessage(action: DnsDoctorAction): void {
  const prefix = `${ansi.bold}[tiller]${ansi.reset}`;
  process.stderr.write(`${prefix} Automatic DNS ${action} currently only supports macOS.\n`);
  process.stderr.write(`${prefix} You can still compare local vs public DNS with \`tiller doctor dns status --hostname <host>\`.\n`);
  process.exitCode = 1;
}

export async function runDnsDoctorCommand(
  argv: string[],
  options: { hubUrlOverride?: string } = {},
): Promise<void> {
  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    usage();
    return;
  }

  const parsed = parseDnsDoctorArgs(argv);
  const dependencies: DnsDoctorDependencies = {
    platform: process.platform,
    hubUrl: options.hubUrlOverride?.trim() || HUB_URL,
  };
  const hostname = resolveDnsDoctorHostname(parsed, dependencies);

  if (parsed.action === "restore") {
    if (dependencies.platform !== "darwin") {
      printMacOnlyMessage("restore");
      return;
    }
    const scopedStatePath = stateFileForHostname(hostname);
    if (existsSync(scopedStatePath)) {
      restoreScopedResolverState(hostname);
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Restored scoped DNS resolver state for ${hostname}.\n`);
      return;
    }

    const resolverPath = resolverFileForHostname(hostname);
    if (existsSync(resolverPath)) {
      throw new Error(
        `No saved DNS repair state was found for ${hostname}. A scoped resolver still exists at ${resolverPath}; remove it manually if you want to clear it.`,
      );
    }

    throw new Error(`No saved DNS repair state was found for ${hostname}.`);
  }

  const service = dependencies.platform === "darwin"
    ? resolveNetworkService(parsed.networkService)
    : null;
  const status = await printStatus(hostname, service, dependencies.platform);

  if (parsed.action === "status") {
    if (status.publicIps.length > 0 && status.localIps.length === 0) {
      if (dependencies.platform === "darwin") {
        process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Public DNS is correct but local macOS resolution is stale.\n`);
        process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Run \`tiller doctor dns repair --hostname ${hostname}\` to repair it.\n`);
      } else {
        process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Public DNS is correct but local resolution is stale.\n`);
        process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Automatic repair currently only supports macOS.\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} DNS looks healthy.\n`);
    return;
  }

  if (dependencies.platform !== "darwin") {
    printMacOnlyMessage("repair");
    return;
  }

  if (status.publicIps.length === 0) {
    throw new Error(`Public DNS does not resolve ${hostname} yet. This is not a local macOS cache problem.`);
  }

  if (status.localIps.length > 0) {
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Local resolution already looks healthy. No repair needed.\n`);
    return;
  }

  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Flushing local macOS DNS caches...\n`);
  flushMacDns();
  const afterFlush = readLocalResolverMac(hostname);
  if (afterFlush.length > 0) {
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Local resolution recovered after the cache flush.\n`);
    return;
  }

  const resolverPath = resolverFileForHostname(hostname);
  process.stderr.write(
    `${ansi.bold}[tiller]${ansi.reset} Local resolution is still stale. Installing a scoped resolver for ${hostname} at ${resolverPath}.\n`,
  );
  saveScopedResolverState(hostname);
  installScopedResolver(hostname);

  flushMacDns();
  const afterSwitch = readLocalResolverMac(hostname);
  if (afterSwitch.length > 0) {
    process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} Local resolution recovered after installing the scoped resolver.\n`);
    process.stderr.write(
      `${ansi.bold}[tiller]${ansi.reset} Remove it later with \`tiller doctor dns restore --hostname ${hostname}\`.\n`,
    );
    return;
  }

  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} The scoped resolver is installed, but ${hostname} still does not resolve locally.\n`);
  process.stderr.write(
    `${ansi.bold}[tiller]${ansi.reset} Remove it later with \`tiller doctor dns restore --hostname ${hostname}\`.\n`,
  );
  process.exitCode = 1;
}

export function printDnsDoctorHelp(): void {
  usage();
}
