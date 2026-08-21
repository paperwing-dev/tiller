import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const HUB_BUILD_LOCK_ENV = "TILLER_HUB_BUILD_LOCK_TOKEN";
export const HUB_BUILD_LOCK_FILE = ".tiller-hub-build.lock";

const LOCK_SCHEMA_VERSION = 1;
const PURPOSE_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWNER_KEYS = ["acquiredAt", "hostname", "pid", "purpose", "schemaVersion", "token"];
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_HUB_BUILD_LOCK_PATH = path.resolve(
  scriptDirectory,
  "..",
  HUB_BUILD_LOCK_FILE,
);

export class HubBuildLockBusyError extends Error {
  constructor(message, owner) {
    super(message);
    this.name = "HubBuildLockBusyError";
    this.owner = owner;
  }
}

function normalizePurpose(value) {
  const purpose = typeof value === "string" ? value.trim() : "";
  if (!PURPOSE_PATTERN.test(purpose)) {
    throw new Error("Hub build lock purpose is invalid.");
  }
  return purpose;
}

function normalizePid(value) {
  const pid = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Hub build lock PID is invalid.");
  }
  return pid;
}

function normalizeToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Hub build lock token is invalid.");
  }
  return token;
}

function normalizeHostname(value) {
  const hostname = typeof value === "string" ? value.trim() : "";
  if (!hostname || hostname.length > 255) {
    throw new Error("Hub build lock hostname is invalid.");
  }
  return hostname;
}

function normalizeAcquiredAt(value) {
  const acquiredAt = typeof value === "string" ? value.trim() : "";
  if (!acquiredAt || !Number.isFinite(Date.parse(acquiredAt))) {
    throw new Error("Hub build lock acquisition timestamp is invalid.");
  }
  return acquiredAt;
}

function parseOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hub build lock owner record is invalid.");
  }
  if (Object.keys(value).sort().join(",") !== OWNER_KEYS.join(",")) {
    throw new Error("Hub build lock owner record has unexpected fields.");
  }
  if (value.schemaVersion !== LOCK_SCHEMA_VERSION) {
    throw new Error("Hub build lock owner schema is invalid.");
  }
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    purpose: normalizePurpose(value.purpose),
    pid: normalizePid(value.pid),
    hostname: normalizeHostname(value.hostname),
    acquiredAt: normalizeAcquiredAt(value.acquiredAt),
    token: normalizeToken(value.token),
  };
}

function assertRegularLockFile(lockPath) {
  const stat = lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Hub build lock is not a regular file: ${lockPath}`);
  }
}

export function readHubBuildLock(lockPath = DEFAULT_HUB_BUILD_LOCK_PATH) {
  try {
    assertRegularLockFile(lockPath);
    return parseOwner(JSON.parse(readFileSync(lockPath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Hub build lock owner record is unreadable: ${lockPath}`);
    }
    throw error;
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && error.code === "ESRCH");
  }
}

function describeOwner(owner) {
  return `${owner.purpose} (PID ${owner.pid} on ${owner.hostname}, started ${owner.acquiredAt})`;
}

function contentionMessage(requestedPurpose, owner) {
  if (requestedPurpose === "deploy:dev") {
    return `deploy:dev cannot start because ${describeOwner(owner)} holds the Hub build lock. No waiting was performed.`;
  }
  if (owner.purpose === "deploy:dev") {
    return `Hub build skipped because deploy:dev is active (PID ${owner.pid}, started ${owner.acquiredAt}). No waiting was performed.`;
  }
  return `Hub build cannot start because ${describeOwner(owner)} holds the Hub build lock. No waiting was performed.`;
}

function unlinkOwnedLock(lockPath, expectedToken) {
  const current = readHubBuildLock(lockPath);
  if (!current) return false;
  if (current.token !== expectedToken) {
    throw new Error("Hub build lock ownership changed before cleanup.");
  }
  assertRegularLockFile(lockPath);
  unlinkSync(lockPath);
  return true;
}

export function acquireHubBuildLock({
  lockPath = DEFAULT_HUB_BUILD_LOCK_PATH,
  purpose,
  pid = process.pid,
  hostname = os.hostname(),
  acquiredAt = new Date().toISOString(),
  token = randomUUID(),
  processAlive = isProcessAlive,
} = {}) {
  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    purpose: normalizePurpose(purpose),
    pid: normalizePid(pid),
    hostname: normalizeHostname(hostname),
    acquiredAt: normalizeAcquiredAt(acquiredAt),
    token: normalizeToken(token),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
      const existing = readHubBuildLock(lockPath);
      if (!existing) continue;
      const safelyStale = existing.hostname === owner.hostname && !processAlive(existing.pid);
      if (safelyStale && attempt === 0) {
        unlinkOwnedLock(lockPath, existing.token);
        continue;
      }
      throw new HubBuildLockBusyError(contentionMessage(owner.purpose, existing), existing);
    }

    try {
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    return owner;
  }

  throw new Error("Hub build lock could not be acquired.");
}

export function releaseHubBuildLock({
  lockPath = DEFAULT_HUB_BUILD_LOCK_PATH,
  token,
} = {}) {
  return unlinkOwnedLock(lockPath, normalizeToken(token));
}

export function assertHubBuildLockOwnership({
  lockPath = DEFAULT_HUB_BUILD_LOCK_PATH,
  token,
  hostname = os.hostname(),
  processAlive = isProcessAlive,
} = {}) {
  const expectedToken = normalizeToken(token);
  const owner = readHubBuildLock(lockPath);
  if (!owner || owner.token !== expectedToken) {
    throw new Error("Inherited Hub build lock ownership is invalid.");
  }
  if (owner.hostname !== hostname || !processAlive(owner.pid)) {
    throw new Error("Inherited Hub build lock owner is no longer active.");
  }
  return owner;
}

function runChild(command, args, env, stdio = "inherit") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio,
    });
    const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
    const signalHandlers = new Map();

    const cleanupSignalHandlers = () => {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler);
      }
    };
    for (const signal of Object.keys(signalExitCodes)) {
      const handler = () => {
        if (!child.killed) child.kill(signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }

    child.once("error", (error) => {
      cleanupSignalHandlers();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanupSignalHandlers();
      resolve(code ?? signalExitCodes[signal] ?? 1);
    });
  });
}

export async function runWithHubBuildLock({
  lockPath = DEFAULT_HUB_BUILD_LOCK_PATH,
  purpose,
  command,
  args = [],
  env = process.env,
  stdio = "inherit",
} = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("Hub build lock child command is missing.");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new Error("Hub build lock child arguments are invalid.");
  }
  const inheritedToken = env[HUB_BUILD_LOCK_ENV]?.trim() ?? "";
  const owner = inheritedToken
    ? assertHubBuildLockOwnership({ lockPath, token: inheritedToken })
    : acquireHubBuildLock({ lockPath, purpose });
  const acquiredHere = !inheritedToken;

  try {
    return await runChild(command, args, {
      ...env,
      [HUB_BUILD_LOCK_ENV]: owner.token,
    }, stdio);
  } finally {
    if (acquiredHere) {
      releaseHubBuildLock({ lockPath, token: owner.token });
    }
  }
}

function usage() {
  return [
    "Usage:",
    "  hub-build-lock.mjs acquire <purpose> <owner-pid>",
    "  hub-build-lock.mjs release <token>",
    "  hub-build-lock.mjs run <purpose> -- <command> [args...]",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (action === "acquire" && args.length === 2) {
    const owner = acquireHubBuildLock({ purpose: args[0], pid: args[1] });
    process.stdout.write(owner.token);
    return;
  }
  if (action === "release" && args.length === 1) {
    releaseHubBuildLock({ token: args[0] });
    return;
  }
  if (action === "run" && args.length >= 3 && args[1] === "--") {
    const exitCode = await runWithHubBuildLock({
      purpose: args[0],
      command: args[2],
      args: args.slice(3),
    });
    process.exitCode = exitCode;
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
