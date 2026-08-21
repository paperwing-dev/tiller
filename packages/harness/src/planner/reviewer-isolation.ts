import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Harness } from "../harness.js";

export const REVIEWER_ISOLATION_PROTOCOL = 1 as const;
const PROTECTED_REVIEWER_WORKSPACE_ROOT = "/tmp/tiller-planner";

export interface ReviewerAccount {
  uid: number;
  gid: number;
}

export interface ReviewerRuntimeDirectories {
  root: string;
  home: string;
  codexHome: string;
  temporary: string;
  cache: string;
  config: string;
  data: string;
  state: string;
  output: string;
  fallbackOutput: string;
}

function providerAccount(): ReviewerAccount {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
  }
  return {
    uid: Number(execFileSync("id", ["-u", "tiller"], { encoding: "utf8" }).trim()),
    gid: Number(execFileSync("id", ["-g", "tiller"], { encoding: "utf8" }).trim()),
  };
}

function createOwnedDirectory(path: string, account: ReviewerAccount): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  if (process.getuid?.() === 0) chownSync(path, account.uid, account.gid);
}

function prepareReviewerWorkspaceRoot(checkoutDir: string): string {
  if (!isAbsolute(checkoutDir)) {
    throw new Error("Reviewer checkout path must be absolute.");
  }
  const workspaceRoot = resolve(dirname(checkoutDir));
  if (
    workspaceRoot === dirname(workspaceRoot) ||
    workspaceRoot === resolve(tmpdir())
  ) {
    throw new Error("Reviewer workspace root must be a dedicated directory.");
  }
  const protectedProtocol = process.env.TILLER_REVIEWER_ISOLATION_PROTOCOL === "1";
  if (protectedProtocol && workspaceRoot !== PROTECTED_REVIEWER_WORKSPACE_ROOT) {
    throw new Error(`Protected reviewer checkout must use ${PROTECTED_REVIEWER_WORKSPACE_ROOT}.`);
  }
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  if (protectedProtocol) {
    const entry = lstatSync(workspaceRoot);
    if (!entry.isDirectory()) {
      throw new Error("Reviewer workspace root must be a directory.");
    }
    if (entry.uid !== 0 || entry.gid !== 0) {
      throw new Error("Reviewer workspace root must be owned by the privileged supervisor.");
    }
    // Provider children need to traverse to known paths without being able to
    // list, rename, or create siblings in the supervisor-owned workspace.
    chmodSync(workspaceRoot, 0o711);
  }
  return workspaceRoot;
}

export function prepareReviewerRuntimeDirectories(
  checkoutDir: string,
  runId: string,
): { account: ReviewerAccount; directories: ReviewerRuntimeDirectories } {
  if (process.env.TILLER_REVIEWER_ISOLATION_PROTOCOL === "1" && process.getuid?.() !== 0) {
    throw new Error("Reviewer isolation protocol 1 requires a privileged supervisor.");
  }
  const account = providerAccount();
  const workspaceRoot = prepareReviewerWorkspaceRoot(checkoutDir);
  const root = join(workspaceRoot, `runtime-${runId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`);
  const directories: ReviewerRuntimeDirectories = {
    root,
    home: join(root, "home"),
    codexHome: join(root, "home", ".codex"),
    temporary: join(root, "tmp"),
    cache: join(root, "cache"),
    config: join(root, "config"),
    data: join(root, "data"),
    state: join(root, "state"),
    output: join(root, "output", "review.md"),
    fallbackOutput: join(root, "output", "last-message.md"),
  };
  for (const path of [
    directories.root,
    directories.home,
    directories.codexHome,
    directories.temporary,
    directories.cache,
    directories.config,
    directories.data,
    directories.state,
    dirname(directories.output),
    dirname(directories.fallbackOutput),
  ]) createOwnedDirectory(path, account);
  return { account, directories };
}

function chownTree(path: string, account: ReviewerAccount): void {
  const entry = lstatSync(path);
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) chownTree(join(path, child), account);
  }
  if (process.getuid?.() === 0) chownSync(path, account.uid, account.gid);
}

export function seedOpenCodeReviewerRuntime(
  directories: ReviewerRuntimeDirectories,
  account: ReviewerAccount,
  seedRoot = "/opt/opencode-seed",
): void {
  for (const [seedName, destinationRoot] of [
    ["data", directories.data],
    ["cache", directories.cache],
    ["state", directories.state],
  ] as const) {
    const source = join(seedRoot, seedName);
    if (!existsSync(source)) continue;
    const destination = join(destinationRoot, "opencode");
    createOwnedDirectory(destination, account);
    for (const child of readdirSync(source)) {
      cpSync(join(source, child), join(destination, child), { recursive: true });
    }
    chownTree(destination, account);
  }
}

function makeReadOnly(path: string): void {
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    chmodSync(path, 0o444);
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      makeReadOnly(child);
      chmodSync(child, 0o555);
    } else if (entry.isFile()) {
      chmodSync(child, 0o444);
    }
  }
  chmodSync(path, 0o555);
}

export function protectReviewerCheckout(checkoutDir: string): void {
  makeReadOnly(checkoutDir);
  if (process.env.TILLER_REVIEWER_ISOLATION_PROTOCOL === "1") {
    const owner = lstatSync(checkoutDir);
    if (owner.uid !== 0 || owner.gid !== 0) {
      throw new Error("Reviewer checkout is not owned by the privileged supervisor.");
    }
  }
}

export function fingerprintReviewerCheckout(rootDir: string): string {
  const hash = createHash("sha256");
  function visit(dir: string, relDir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const stat = lstatSync(child);
      hash.update(`${relPath}\0${stat.mode & 0o7777}\0`);
      if (entry.isDirectory()) {
        hash.update("dir\0");
        visit(child, relPath);
      } else if (entry.isFile()) {
        hash.update(`file\0${stat.size}\0`);
        hash.update(readFileSync(child));
        hash.update("\0");
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${readlinkSync(child)}\0`);
      } else {
        hash.update(`other\0${stat.size}\0`);
      }
    }
  }
  visit(rootDir, "");
  return hash.digest("hex");
}

const COMMON_KEYS = ["PATH", "LANG", "LC_ALL", "TERM", "COLORTERM", "TZ", "SHELL", "NODE_OPTIONS"] as const;
const OPENCODE_KEYS = [
  "TILLER_OPENCODE_BASE_URL",
  "TILLER_OPENCODE_AUTH_TOKEN",
  "TILLER_OPENCODE_PROVIDER_KIND",
  "TILLER_OPENCODE_PROVIDER_ALIAS",
  "TILLER_OPENCODE_PROVIDER_LABEL",
  "TILLER_OPENCODE_PROVIDER_PACKAGE",
  "TILLER_OPENCODE_PROVIDER_VERSION",
  "TILLER_OPENCODE_MODEL_ID",
  "TILLER_OPENCODE_MODEL_ALIAS",
  "TILLER_OPENCODE_MODEL_LABEL",
  "TILLER_OPENCODE_MODEL_CONTEXT_LIMIT",
  "TILLER_OPENCODE_MODEL_INPUT_LIMIT",
  "TILLER_OPENCODE_MODEL_OUTPUT_LIMIT",
  "TILLER_OPENCODE_REASONING_EFFORT",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_CONFIG_CONTENT",
] as const;

export function buildReviewerProviderEnvironment(options: {
  harness: Harness;
  source: NodeJS.ProcessEnv;
  commandEnv?: Record<string, string>;
  directories: ReviewerRuntimeDirectories;
}): Record<string, string> {
  const source = { ...options.source, ...(options.commandEnv ?? {}) };
  const allowed = new Set<string>(COMMON_KEYS);
  if (options.harness === "claude-code") {
    allowed.add("TILLER_CLAUDE_AUTH_RESOLVED_MODE");
    allowed.add("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST");
    const mode = source.TILLER_CLAUDE_AUTH_RESOLVED_MODE;
    allowed.add(mode === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY");
  } else if (options.harness === "codex") {
    if (source.TILLER_CODEX_AUTH_MODE === "api-key") allowed.add("OPENAI_API_KEY");
    allowed.add("RUNNER_BACKEND");
  } else {
    for (const key of OPENCODE_KEYS) allowed.add(key);
    // The Workers AI model proxy is behind the Hub's Cloudflare Access
    // application. Preserve only a complete pair for this provider so the
    // generated OpenCode config can authenticate at the edge.
    if (
      source.TILLER_OPENCODE_PROVIDER_KIND === "cloudflare-workers-ai"
      && source.CF_ACCESS_CLIENT_ID?.trim()
      && source.CF_ACCESS_CLIENT_SECRET?.trim()
    ) {
      allowed.add("CF_ACCESS_CLIENT_ID");
      allowed.add("CF_ACCESS_CLIENT_SECRET");
    }
  }
  // Explicit provider transport only. Callback, GitHub bridge, and workspace
  // synchronization credentials are absent. OpenCode additionally receives
  // the Access pair required to reach its protected Hub model proxy.
  allowed.add("TILLER_PLANNER_OUTPUT_FILE");
  if (source.NODE_ENV === "test" && source.TILLER_ENV_CAPTURE_FILE) {
    allowed.add("NODE_ENV");
    allowed.add("TILLER_ENV_CAPTURE_FILE");
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key)) env[key] = value;
  }
  const isolated: Record<string, string> = {
    ...env,
    HOME: options.directories.home,
    USER: "tiller",
    LOGNAME: "tiller",
    TMPDIR: options.directories.temporary,
    XDG_CACHE_HOME: options.directories.cache,
    XDG_CONFIG_HOME: options.directories.config,
    XDG_DATA_HOME: options.directories.data,
    XDG_STATE_HOME: options.directories.state,
    CODEX_HOME: options.directories.codexHome,
    TILLER_PLANNER_OUTPUT_FILE: options.directories.output,
  };
  if (options.harness === "claude-code") isolated.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  return isolated;
}

export function reviewerChildIdentity(account: ReviewerAccount): { uid?: number; gid?: number } {
  return process.getuid?.() === 0 ? { uid: account.uid, gid: account.gid } : {};
}
