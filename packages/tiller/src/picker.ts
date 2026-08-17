/**
 * Interactive environment + session picker for `tiller`.
 *
 * Two-level navigation:
 *   1. Pick an environment (shows status: running/stopped)
 *   2. Pick a session on that environment
 *
 * If the selected environment is stopped, starts it and waits for a session.
 * Uses raw stdin + ANSI escape codes — no external dependencies.
 */

import { spawnSync } from "node:child_process";
import { HubClient } from "./hub-client.js";
import { ansi, ESC } from "./ansi.js";

// ── Types (mirror hub API shapes) ────────────────────────────────────

export interface EnvMeta {
  slug: string;
  displayName?: string;
  repoId: string;
  repoUrl: string;
  backend: "cf" | "host";
  runnerId?: string;
  harness: "claude-code" | "codex" | "opencode";
  harnessPresentation?: {
    modelLabel: string;
    credentialRequirement: string;
    providerKind: string;
    providerLabel: string;
  };
  resolvedAuthMode?: "subscription" | "api";
  codexAuthMode?: "subscription" | "api-key";
  createdAt: string;
  updatedAt: string;
  status: EnvDisplayStatus;
  bootMessage?: string;
}

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  envCount?: number;
  createdAt: string;
  updatedAt: string;
  gitStatus: "pending" | "ready" | "repair-required";
}

export interface StoredSession {
  id: string;
  tag: string;
  machine_id: string | null;
  metadata: string; // JSON
  active: number;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PickResult {
  session: StoredSession;
  env: EnvMeta;
}

interface SessionSummary {
  session: StoredSession;
  cwdLabel: string;
  ago: string;
}

type EnvDisplayStatus =
  | "creating"
  | "running"
  | "starting"
  | "saving"
  | "stopping"
  | "stopped"
  | "deleting"
  | "destroyed"
  | "failed"
  | "unknown"
  | "created"
  | "waiting";

const autoStartedEnvSlugs = new Set<string>();

export function envDisplayLabel(
  env: Pick<EnvMeta, "slug" | "displayName">,
  includeDistinctSlug = false,
): string {
  const normalized = typeof env.displayName === "string"
    ? env.displayName
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
    : "";
  const codePoints = Array.from(normalized);
  const displayName = codePoints.length > 80
    ? `${codePoints.slice(0, 79).join("")}…`
    : normalized;
  const primary = displayName || env.slug;
  return includeDistinctSlug && primary !== env.slug
    ? `${primary} (slug: ${env.slug})`
    : primary;
}

function pickerLog(message: string): void {
  process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${message}\n`);
}

// ── Status helpers ───────────────────────────────────────────────────

function statusIcon(status?: EnvDisplayStatus): string {
  switch (status) {
    case "running":
      return `${ansi.green}\u25cf${ansi.reset}`;
    case "creating":
    case "starting":
    case "saving":
    case "created":
    case "waiting":
      return `${ansi.yellow}\u25cf${ansi.reset}`;
    case "deleting":
    case "stopping":
      return `${ansi.yellow}\u25cb${ansi.reset}`;
    case "stopped":
    case "destroyed":
      return `${ansi.dim}\u25cb${ansi.reset}`;
    case "failed":
      return `${ansi.red}\u2715${ansi.reset}`;
    case "unknown":
      return `${ansi.yellow}?${ansi.reset}`;
    default:
      return `${ansi.dim}?${ansi.reset}`;
  }
}

function backendBadge(backend: "cf" | "host"): string {
  return backend === "host"
    ? `${ansi.cyan}[machine]${ansi.reset}`
    : `${ansi.blue}[cloudflare]${ansi.reset}`;
}

function harnessPresentation(env: EnvMeta): NonNullable<EnvMeta["harnessPresentation"]> | null {
  const presentation = env.harnessPresentation;
  if (
    !presentation
    || typeof presentation.modelLabel !== "string"
    || typeof presentation.credentialRequirement !== "string"
    || typeof presentation.providerKind !== "string"
    || typeof presentation.providerLabel !== "string"
  ) {
    return null;
  }
  return presentation;
}

export function authLabel(env: EnvMeta): string | null {
  if (env.harness === "codex") {
    if (env.codexAuthMode === "subscription") return "subscription";
    if (env.codexAuthMode === "api-key") return "api key";
    return null;
  }
  if (env.harness === "opencode") {
    const requirement = harnessPresentation(env)?.credentialRequirement;
    if (requirement === "workers-ai") return "workers ai";
    if (requirement === "openai-api-key") return "openai api key";
    if (requirement === "anthropic-api-key") return "anthropic api key";
    return null;
  }
  if (env.resolvedAuthMode === "subscription") return "claude subscription";
  if (env.resolvedAuthMode === "api") return "anthropic api key";
  return null;
}

export function authBadge(env: EnvMeta): string {
  const label = authLabel(env);
  if (!label) return "";
  const color = env.harness === "opencode"
    && harnessPresentation(env)?.providerKind === "cloudflare-workers-ai"
    ? ansi.cyan
    : label.includes("subscription")
      ? ansi.green
      : ansi.yellow;
  return `${color}[${label}]${ansi.reset}`;
}

export function authDetailLabel(env: EnvMeta): string | null {
  if (env.harness === "codex") {
    if (!env.codexAuthMode) return null;
    return env.codexAuthMode === "subscription" ? "Subscription" : "API key";
  }
  if (env.harness === "opencode") {
    const presentation = harnessPresentation(env);
    if (!presentation) return null;
    return `${presentation.providerLabel} · ${presentation.modelLabel}`;
  }
  if (!env.resolvedAuthMode) return null;
  const mode = env.resolvedAuthMode === "subscription" ? "Claude subscription" : "Anthropic API key";
  return mode;
}

function timeAgo(dateStr: string): string {
  const diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusRank(status?: EnvDisplayStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "creating":
    case "starting":
    case "saving":
    case "created":
    case "waiting":
      return 1;
    case "deleting":
    case "unknown":
      return 2;
    case "failed":
      return 3;
    case "stopping":
      return 4;
    case "stopped":
    case "destroyed":
      return 5;
    default:
      return 6;
  }
}

function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

function detectCurrentRepoUrl(): string | null {
  try {
    const result = spawnSync("git", ["remote", "get-url", "origin"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout) {
      return normalizeRepoUrl(result.stdout.toString().trim());
    }
  } catch { /* not in a git repo */ }
  return null;
}

function repoLabel(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    return `${url.hostname}${url.pathname.replace(/\.git$/, "")}`;
  } catch {
    return repoUrl;
  }
}

function truncate(value: string, max = 72): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeStatus(status?: string): EnvDisplayStatus {
  switch (status) {
    case "running":
    case "creating":
    case "starting":
    case "saving":
    case "stopping":
    case "stopped":
    case "deleting":
    case "destroyed":
    case "failed":
    case "created":
    case "waiting":
    case "unknown":
      return status;
    default:
      return "unknown";
  }
}

// ── Fetch helpers ────────────────────────────────────────────────────

async function fetchEnvs(hubUrl: string, headers: Record<string, string>): Promise<EnvMeta[]> {
  const res = await fetch(`${hubUrl}/api/envs`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch envs: ${res.status}`);
  return res.json() as Promise<EnvMeta[]>;
}

async function fetchSessions(hubUrl: string, headers: Record<string, string>): Promise<StoredSession[]> {
  const res = await fetch(`${hubUrl}/api/sessions`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json() as Promise<StoredSession[]>;
}

async function fetchEnv(hubUrl: string, slug: string, headers: Record<string, string>): Promise<EnvMeta | null> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch env ${slug}: ${res.status}`);
  return res.json() as Promise<EnvMeta>;
}

async function startEnv(hubUrl: string, slug: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/start`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(`Failed to start env: ${res.status}`);
}

async function stopEnv(hubUrl: string, slug: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/stop`, {
    method: "POST",
    headers,
  });
  if (!res.ok && res.status !== 404) throw new Error(`Failed to stop env: ${res.status}`);
}

async function deleteEnv(hubUrl: string, slug: string, headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 404) throw new Error(`Failed to delete env: ${res.status}`);
}

async function fetchRepos(hubUrl: string, headers: Record<string, string>): Promise<RepoMeta[]> {
  const res = await fetch(`${hubUrl}/api/repos`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return res.json() as Promise<RepoMeta[]>;
}

async function createEnv(
  hubUrl: string,
  headers: Record<string, string>,
  params: { repoId: string; slug?: string; harness: EnvMeta["harness"] },
): Promise<EnvMeta> {
  const res = await fetch(`${hubUrl}/api/envs`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `Failed to create env: ${res.status}`);
  }
  return res.json() as Promise<EnvMeta>;
}

// ── Correlate sessions to envs ───────────────────────────────────────

function sessionsForEnv(env: EnvMeta, sessions: StoredSession[]): StoredSession[] {
  return sessions.filter((s) => {
    if (!s.active || s.ended_at) return false;

    try {
      const meta = JSON.parse(s.metadata || "{}");
      if (meta.envSlug) return meta.envSlug === env.slug;
      if (meta.runnerId && env.runnerId) return meta.runnerId === env.runnerId;
      if (meta.repoId) return meta.repoId === env.repoId;
    } catch { /* ignore */ }

    return false;
  });
}

// ── Raw key reader ───────────────────────────────────────────────────
// Uses an input queue so rapid keystrokes between readKey() calls are
// not dropped. When data arrives and a caller is waiting, it resolves
// immediately; otherwise the keystrokes are buffered for the next call.

const keyBuffer: string[] = [];
let keyWaiter: ((key: string) => void) | null = null;

function parseKey(str: string): string {
  if (str === `${ESC}[A`) return "up";
  if (str === `${ESC}[B`) return "down";
  if (str === "\r" || str === "\n") return "enter";
  if (str === "q" || str === "Q") return "quit";
  if (str === "b" || str === "B") return "back";
  if (str === "s" || str === "S") return "toggle-start-stop";
  if (str === "d" || str === "D") return "delete";
  if (str === "n" || str === "N") return "new";
  if (str === "\x03") return "ctrl-c";
  return str;
}

function createKeyListener(): (data: Buffer) => void {
  return (data: Buffer) => {
    const key = parseKey(data.toString());
    if (keyWaiter) {
      const resolve = keyWaiter;
      keyWaiter = null;
      resolve(key);
    } else {
      keyBuffer.push(key);
    }
  };
}

function clearKeyState(): void {
  keyBuffer.length = 0;
  keyWaiter = null;
}

function readKey(): Promise<string> {
  if (keyBuffer.length > 0) {
    return Promise.resolve(keyBuffer.shift()!);
  }
  return new Promise((resolve) => {
    keyWaiter = resolve;
  });
}

// ── Render a selectable list ─────────────────────────────────────────

function renderList(
  title: string,
  items: string[],
  selectedIndex: number,
  footer: string,
  detailLines: string[] = [],
  skippable?: Set<number>,
): void {
  let output = `${ansi.eraseLine}${ansi.bold}${title}${ansi.reset}\n`;
  for (let i = 0; i < items.length; i++) {
    if (skippable?.has(i)) {
      output += `${ansi.eraseLine}${items[i]}\n`;
    } else if (i === selectedIndex) {
      output += `${ansi.eraseLine}  ${ansi.inverse} ${items[i]} ${ansi.reset}\n`;
    } else {
      output += `${ansi.eraseLine}   ${items[i]}\n`;
    }
  }
  if (detailLines.length > 0) {
    output += `${ansi.eraseLine}\n${ansi.bold}${ansi.magenta}Details${ansi.reset}\n`;
    for (const line of detailLines) {
      output += `${ansi.eraseLine}  ${line}\n`;
    }
  }
  output += `${ansi.eraseLine}\n${ansi.dim}${footer}${ansi.reset}`;
  process.stderr.write(`${ansi.clearScreen}${output}`);
}

// ── List selector ────────────────────────────────────────────────────

interface SelectOptions {
  allowToggleStartStop?: boolean;
  allowDelete?: boolean;
  allowNew?: boolean;
  skippable?: Set<number>;
}

type ListChoice =
  | { kind: "select"; index: number }
  | { kind: "back" }
  | { kind: "quit" }
  | { kind: "toggle-start-stop"; index: number }
  | { kind: "delete"; index: number }
  | { kind: "new"; index: number };

function nextSelectable(from: number, dir: 1 | -1, count: number, skippable?: Set<number>): number {
  if (!skippable || skippable.size === 0) return (from + dir + count) % count;
  let pos = from;
  for (let i = 0; i < count; i++) {
    pos = (pos + dir + count) % count;
    if (!skippable.has(pos)) return pos;
  }
  return from;
}

function firstSelectable(count: number, skippable?: Set<number>): number {
  for (let i = 0; i < count; i++) {
    if (!skippable?.has(i)) return i;
  }
  return 0;
}

async function selectFromList(
  title: string,
  items: string[],
  footer: string,
  renderDetails?: (selectedIndex: number) => string[],
  options?: SelectOptions,
): Promise<ListChoice> {
  if (items.length === 0) return { kind: "back" };

  const skip = options?.skippable;
  let selected = firstSelectable(items.length, skip);
  const render = () => renderList(title, items, selected, footer, renderDetails?.(selected) ?? [], skip);
  render();

  while (true) {
    const key = await readKey();
    switch (key) {
      case "up":
        selected = nextSelectable(selected, -1, items.length, skip);
        render();
        break;
      case "down":
        selected = nextSelectable(selected, 1, items.length, skip);
        render();
        break;
      case "enter":
        return { kind: "select", index: selected };
      case "back":
        return { kind: "back" };
      case "toggle-start-stop":
        if (options?.allowToggleStartStop) {
          return { kind: "toggle-start-stop", index: selected };
        }
        break;
      case "delete":
        if (options?.allowDelete) {
          return { kind: "delete", index: selected };
        }
        break;
      case "new":
        if (options?.allowNew) {
          return { kind: "new", index: selected };
        }
        break;
      case "quit":
      case "ctrl-c":
        return { kind: "quit" };
    }
  }
}

function summarizeSession(session: StoredSession): SessionSummary {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(session.metadata || "{}");
  } catch {
    meta = {};
  }

  return {
    session,
    cwdLabel: (meta.cwd as string) || "",
    ago: timeAgo(session.updated_at),
  };
}

function envDetailLines(env: EnvMeta): string[] {
  const status = normalizeStatus(env.status);
  let action = "Press s to start";
  if (status === "running") action = "Press s to stop";
  else if (status === "creating" || status === "starting" || status === "created") action = "Press s to stop";
  else if (status === "saving" || status === "stopping" || status === "deleting") action = "Waiting for stop to finish";
  else if (status === "failed") action = "Press s to retry start";
  const lines = [
    `${ansi.bold}Name:${ansi.reset} ${envDisplayLabel(env)}`,
    `${ansi.bold}Repo:${ansi.reset} ${truncate(repoLabel(env.repoUrl))}`,
    `${ansi.bold}Execution backend:${ansi.reset} ${env.backend === "host" ? "Your machine" : "Cloudflare"}`,
  ];

  const auth = authDetailLabel(env);
  if (auth) {
    lines.push(`${ansi.bold}Auth:${ansi.reset} ${auth}`);
  }

  lines.push(
    `${ansi.bold}Status:${ansi.reset} ${status}`,
    `${ansi.bold}Slug:${ansi.reset} ${env.slug}`,
    `${ansi.bold}Action:${ansi.reset} ${action}`,
  );

  if (env.bootMessage) {
    lines.push(`${ansi.bold}Boot:${ansi.reset} ${truncate(env.bootMessage)}`);
  }

  return lines;
}

function sessionDetailLines(summary: SessionSummary): string[] {
  const lines = [
    `${ansi.bold}Tag:${ansi.reset} ${summary.session.tag}`,
    `${ansi.bold}Updated:${ansi.reset} ${summary.ago}`,
    `${ansi.bold}Session:${ansi.reset} ${summary.session.id}`,
  ];

  if (summary.cwdLabel) {
    lines.push(`${ansi.bold}Cwd:${ansi.reset} ${truncate(summary.cwdLabel)}`);
  }

  return lines;
}

// ── Boot-wait flow ───────────────────────────────────────────────────

async function waitForSession(
  hubUrl: string,
  env: EnvMeta,
  headers: Record<string, string>,
  opts: { skipStart?: boolean } = {},
): Promise<StoredSession | null> {
  const label = envDisplayLabel(env, true);
  if (opts.skipStart) {
    process.stderr.write(`\n${ansi.bold}[tiller]${ansi.reset} ${ansi.cyan}${label}${ansi.reset} is starting, waiting for session...\n`);
  } else {
    process.stderr.write(`\n${ansi.bold}[tiller]${ansi.reset} Starting ${ansi.cyan}${label}${ansi.reset}...\n`);
    await startEnv(hubUrl, env.slug, headers);
    autoStartedEnvSlugs.add(env.slug);
  }

  // Connect WS to receive boot progress
  const hub = new HubClient({ hubUrl, cfAccessHeaders: headers });

  hub.on("env-status-changed", (_slug, _status, message) => {
    if (message) {
      process.stderr.write(`${ansi.eraseLine}${ansi.dim}[tiller] ${message}${ansi.reset}\n`);
    }
  });

  hub.connect();

  // Poll for sessions until one appears on this env
  const POLL_INTERVAL = 2000;
  const MAX_WAIT = 300_000; // 5 minutes
  const start = Date.now();

  try {
    while (Date.now() - start < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      const sessions = await fetchSessions(hubUrl, headers);
      const matching = sessionsForEnv(env, sessions);
      if (matching.length > 0) {
        process.stderr.write(`${ansi.eraseLine}${ansi.bold}[tiller]${ansi.reset} ${ansi.green}Session ready.${ansi.reset}\n`);
        return matching[0];
      }
    }
    process.stderr.write(`\n${ansi.red}[tiller] Timed out waiting for session.${ansi.reset}\n`);
    return null;
  } finally {
    hub.close();
  }
}

function shouldStartEnv(status?: string): boolean {
  return status === "stopped" || status === "destroyed" || status === "failed" || status === "unknown";
}

function canStopEnv(status?: string): boolean {
  return status === "running" || status === "creating" || status === "starting" || status === "created" || status === "waiting";
}

async function waitForEnvStatus(
  hubUrl: string,
  slug: string,
  headers: Record<string, string>,
  isComplete: (status: string) => boolean,
  timeoutMs = 30_000,
): Promise<string | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const env = await fetchEnv(hubUrl, slug, headers);
    const status = normalizeStatus(env?.status);
    if (isComplete(status)) return status;
    await new Promise((r) => setTimeout(r, 1000));
  }

  return null;
}

async function toggleEnvLifecycle(
  hubUrl: string,
  env: EnvMeta,
  headers: Record<string, string>,
): Promise<"refresh"> {
  const label = envDisplayLabel(env, true);
  if (shouldStartEnv(env.status || "unknown")) {
    process.stderr.write(`\n${ansi.bold}[tiller]${ansi.reset} Starting ${ansi.cyan}${label}${ansi.reset}...\n`);
    await startEnv(hubUrl, env.slug, headers);
    autoStartedEnvSlugs.add(env.slug);
    await waitForSession(
      hubUrl,
      { ...env, status: "starting" },
      headers,
      { skipStart: true },
    );
    return "refresh";
  }

  if (env.status === "starting" || env.status === "created") {
    process.stderr.write(`\n${ansi.bold}[tiller]${ansi.reset} Stopping ${ansi.cyan}${label}${ansi.reset}...\n`);
    await stopEnv(hubUrl, env.slug, headers);
    autoStartedEnvSlugs.delete(env.slug);
    const status = await waitForEnvStatus(
      hubUrl,
      env.slug,
      headers,
      (nextStatus) => nextStatus === "stopped" || nextStatus === "failed",
    );
    if (status) {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${ansi.cyan}${label}${ansi.reset} is ${status}.\n`);
    }
    return "refresh";
  }

  if (canStopEnv(env.status)) {
    process.stderr.write(`\n${ansi.bold}[tiller]${ansi.reset} Stopping ${ansi.cyan}${label}${ansi.reset}...\n`);
    await stopEnv(hubUrl, env.slug, headers);
    autoStartedEnvSlugs.delete(env.slug);
    const status = await waitForEnvStatus(
      hubUrl,
      env.slug,
      headers,
      (nextStatus) => nextStatus === "stopped" || nextStatus === "failed",
    );
    if (status) {
      process.stderr.write(`${ansi.bold}[tiller]${ansi.reset} ${ansi.cyan}${label}${ansi.reset} is ${status}.\n`);
    }
    return "refresh";
  }

  process.stderr.write(`\n${ansi.yellow}[tiller] No lifecycle action available for ${label}.${ansi.reset}\n`);
  await new Promise((r) => setTimeout(r, 800));
  return "refresh";
}

export async function shutdownAutoStartedLocalEnvs(
  hubUrl: string,
  headers: Record<string, string>,
): Promise<void> {
  if (autoStartedEnvSlugs.size === 0) return;

  for (const slug of [...autoStartedEnvSlugs]) {
    pickerLog(`Stopping env ${ansi.cyan}${slug}${ansi.reset}...`);
    try {
      await stopEnv(hubUrl, slug, headers);
      pickerLog(`Stopped env ${ansi.cyan}${slug}${ansi.reset}.`);
    } catch (error) {
      pickerLog(`${ansi.yellow}Failed to stop env ${slug}: ${error instanceof Error ? error.message : String(error)}${ansi.reset}`);
    } finally {
      autoStartedEnvSlugs.delete(slug);
    }
  }
}

// ── Main picker entry point ──────────────────────────────────────────

export async function pickAndConnect(
  hubUrl: string,
  cfHeaders: Record<string, string>,
): Promise<PickResult | null> {
  // Set raw mode for interactive selection
  const wasTTY = process.stdin.isTTY;
  clearKeyState();
  const onKeyData = createKeyListener();
  if (wasTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKeyData);
  process.stderr.write(ansi.hideCursor);

  try {
    return await pickerLoop(hubUrl, cfHeaders);
  } finally {
    process.stdin.removeListener("data", onKeyData);
    clearKeyState();
    process.stderr.write(ansi.showCursor);
    if (wasTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

// ── Prompt helpers (used by create/delete flows) ────────────────────

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(ansi.showCursor);
    process.stderr.write(`${question} `);
    // Temporarily exit raw mode for readline-style input
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    let buf = "";
    const onData = (data: Buffer) => {
      const str = data.toString();
      if (str.includes("\n") || str.includes("\r")) {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stderr.write(ansi.hideCursor);
        resolve(buf.trim());
      } else {
        buf += str;
        process.stderr.write(str);
      }
    };
    process.stdin.on("data", onData);
  });
}

async function promptConfirm(question: string): Promise<boolean> {
  const answer = await promptLine(`${question} [y/N]`);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

// ── Create environment flow ─────────────────────────────────────────

async function runCreateEnvFlow(
  hubUrl: string,
  headers: Record<string, string>,
  repo: Pick<RepoMeta, "repoId" | "repoUrl">,
): Promise<void> {
  // Pick model
  const modelChoice = await selectFromList(
    "Select model",
    ["  Claude Code", "  Codex", "  OpenCode"],
    "\u2191\u2193 navigate  enter select  b back",
  );
  if (modelChoice.kind !== "select") return;
  const harness = modelChoice.index === 1
    ? "codex"
    : modelChoice.index === 2
      ? "opencode"
      : "claude-code";

  try {
    const env = await createEnv(hubUrl, headers, {
      repoId: repo.repoId,
      harness,
    });
    pickerLog(`Created ${ansi.cyan}${envDisplayLabel(env, true)}${ansi.reset}.`);
  } catch (error) {
    pickerLog(`${ansi.red}${error instanceof Error ? error.message : String(error)}${ansi.reset}`);
  }
  await new Promise((r) => setTimeout(r, 800));
}

// ── Main picker loop ────────────────────────────────────────────────

async function pickerLoop(
  hubUrl: string,
  cfHeaders: Record<string, string>,
): Promise<PickResult | null> {
  while (true) {
    // Fetch envs, sessions, and repos in parallel
    const [rawEnvs, sessions, repos] = await Promise.all([
      fetchEnvs(hubUrl, cfHeaders),
      fetchSessions(hubUrl, cfHeaders),
      fetchRepos(hubUrl, cfHeaders),
    ]);

    // Sort envs: running first, then by creation date
    const envs = [...rawEnvs].sort((a, b) => {
      const rankDelta = statusRank(normalizeStatus(a.status)) - statusRank(normalizeStatus(b.status));
      if (rankDelta !== 0) return rankDelta;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    if (envs.length === 0) {
      if (repos.length === 0) {
        process.stderr.write(`\n${ansi.yellow}[tiller] No environments or repos found.${ansi.reset}\n`);
        return null;
      }
      // No envs but repos exist — let user pick a repo to create an env on
      const repoItems = repos.map((r) => `  ${repoLabel(r.repoUrl)}`);
      process.stderr.write(`\n${ansi.yellow}[tiller] No environments found. Select a repo to create one.${ansi.reset}\n`);
      const repoChoice = await selectFromList(
        "Select repo",
        repoItems,
        "\u2191\u2193 navigate  enter select  q quit",
      );
      if (repoChoice.kind === "select") {
        await runCreateEnvFlow(hubUrl, cfHeaders, repos[repoChoice.index]);
      } else {
        return null;
      }
      continue;
    }

    // Detect current repo from cwd
    const cwdRepoUrl = detectCurrentRepoUrl();

    // Group envs by repo
    const repoMap = new Map<string, RepoMeta>();
    for (const repo of repos) {
      repoMap.set(repo.repoId, repo);
    }
    const groups = new Map<string, EnvMeta[]>();
    for (const env of envs) {
      if (!groups.has(env.repoId)) groups.set(env.repoId, []);
      groups.get(env.repoId)!.push(env);
    }

    // Sort groups: current repo first, then by best env status
    const sortedGroups = [...groups.entries()].sort(([aRepoId, aEnvs], [bRepoId, bEnvs]) => {
      const aUrl = repoMap.get(aRepoId)?.repoUrl ?? aEnvs[0]?.repoUrl ?? aRepoId;
      const bUrl = repoMap.get(bRepoId)?.repoUrl ?? bEnvs[0]?.repoUrl ?? bRepoId;
      const aIsCurrent = cwdRepoUrl ? normalizeRepoUrl(aUrl) === cwdRepoUrl : false;
      const bIsCurrent = cwdRepoUrl ? normalizeRepoUrl(bUrl) === cwdRepoUrl : false;
      if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
      const aMin = Math.min(...aEnvs.map((e) => statusRank(normalizeStatus(e.status))));
      const bMin = Math.min(...bEnvs.map((e) => statusRank(normalizeStatus(e.status))));
      return aMin - bMin;
    });

    // Build grouped display list
    const items: string[] = [];
    const skippable = new Set<number>();
    const indexToEnv = new Map<number, EnvMeta>();

    for (const [repoId, groupEnvs] of sortedGroups) {
      const repo = repoMap.get(repoId);
      const repoUrl = repo?.repoUrl ?? groupEnvs[0]?.repoUrl ?? repoId;
      const isCurrent = cwdRepoUrl ? normalizeRepoUrl(repoUrl) === cwdRepoUrl : false;

      if (isCurrent) {
        // Box around current repo header
        const rl = repoLabel(repoUrl);
        const innerText = `  ${rl}  \u00b7  current repo `;
        const w = innerText.length;
        const topIdx = items.length;
        items.push(`  ${ansi.cyan}\u250c${"\u2500".repeat(w)}\u2510${ansi.reset}`);
        skippable.add(topIdx);

        const midIdx = items.length;
        items.push(`  ${ansi.cyan}\u2502${ansi.reset}  ${ansi.bold}${rl}${ansi.reset}  ${ansi.dim}\u00b7  current repo${ansi.reset} ${ansi.cyan}\u2502${ansi.reset}`);
        skippable.add(midIdx);

        const botIdx = items.length;
        items.push(`  ${ansi.cyan}\u2514${"\u2500".repeat(w)}\u2518${ansi.reset}`);
        skippable.add(botIdx);
      } else {
        const headerIdx = items.length;
        items.push(`\n  ${ansi.bold}${repoLabel(repoUrl)}${ansi.reset}`);
        skippable.add(headerIdx);
      }

      for (const env of groupEnvs) {
        const idx = items.length;
        const statusLabel = normalizeStatus(env.status);
        const auth = authBadge(env);
        const authPart = auth ? ` ${auth}` : "";
        items.push(`${statusIcon(statusLabel)} ${envDisplayLabel(env, true)} ${backendBadge(env.backend)}${authPart} ${ansi.dim}(${statusLabel})${ansi.reset}`);
        indexToEnv.set(idx, env);
      }
    }

    const envChoice = await selectFromList(
      "Environments",
      items,
      "\u2191\u2193 navigate  enter attach  s start/stop  d delete  n new  q quit",
      (selectedIndex) => {
        const env = indexToEnv.get(selectedIndex);
        return env ? envDetailLines(env) : [];
      },
      { allowToggleStartStop: true, allowDelete: true, allowNew: true, skippable },
    );

    if (envChoice.kind === "quit" || envChoice.kind === "back") return null;

    if (envChoice.kind === "new") {
      const nearEnv = indexToEnv.get(envChoice.index);
      if (nearEnv) {
        const repo = repoMap.get(nearEnv.repoId);
        if (repo) {
          await runCreateEnvFlow(hubUrl, cfHeaders, repo);
        } else {
          pickerLog(`${ansi.red}Repository metadata is unavailable for ${repoLabel(nearEnv.repoUrl)}.${ansi.reset}`);
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      continue;
    }

    if (envChoice.kind === "delete") {
      const env = indexToEnv.get(envChoice.index);
      if (env) {
        const label = envDisplayLabel(env, true);
        const canDelete = env.status === "stopped" || env.status === "destroyed" || env.status === "failed";
        if (!canDelete) {
          process.stderr.write(`\n${ansi.yellow}[tiller] Stop ${label} before deleting.${ansi.reset}\n`);
          await new Promise((r) => setTimeout(r, 800));
        } else if (await promptConfirm(`Delete environment ${ansi.cyan}${label}${ansi.reset}?`)) {
          try {
            await deleteEnv(hubUrl, env.slug, cfHeaders);
            pickerLog(`Deleted ${ansi.cyan}${label}${ansi.reset}.`);
          } catch (error) {
            pickerLog(`${ansi.red}${error instanceof Error ? error.message : String(error)}${ansi.reset}`);
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      continue;
    }

    const selectedEnv = indexToEnv.get(envChoice.index);
    if (!selectedEnv) continue;

    if (envChoice.kind === "toggle-start-stop") {
      await toggleEnvLifecycle(hubUrl, selectedEnv, cfHeaders);
      continue;
    }

    const envSessions = sessionsForEnv(selectedEnv, sessions);

    // If env is stopped, start it and wait
    if (shouldStartEnv(selectedEnv.status || "unknown")) {
      const session = await waitForSession(hubUrl, selectedEnv, cfHeaders);
      if (session) {
        return { session, env: selectedEnv };
      }
      continue;
    }

    // If env is already starting, wait for session without re-issuing start
    if (selectedEnv.status === "starting" || selectedEnv.status === "created") {
      const session = await waitForSession(hubUrl, selectedEnv, cfHeaders, { skipStart: true });
      if (session) {
        return { session, env: selectedEnv };
      }
      continue;
    }

    // Running env — auto-attach if single session, otherwise pick
    if (envSessions.length === 0) {
      process.stderr.write(`\n${ansi.yellow}[tiller] No active sessions on ${envDisplayLabel(selectedEnv, true)}.${ansi.reset}\n`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    if (envSessions.length === 1) {
      return { session: envSessions[0], env: selectedEnv };
    }

    // Multiple sessions — show session picker
    const sessionSummaries = envSessions
      .map((s) => summarizeSession(s))
      .sort((a, b) => new Date(b.session.updated_at).getTime() - new Date(a.session.updated_at).getTime());
    const sessionItems = sessionSummaries.map((summary) => {
      const activeIcon = summary.session.active ? `${ansi.green}\u25cf${ansi.reset}` : `${ansi.dim}\u25cb${ansi.reset}`;
      return `${activeIcon} ${summary.session.tag}  ${ansi.dim}${summary.cwdLabel}  ${summary.ago}${ansi.reset}`;
    });

    const sessionChoice = await selectFromList(
      `Sessions on ${envDisplayLabel(selectedEnv, true)}`,
      sessionItems,
      "\u2191\u2193 navigate  enter select  b back  q/Ctrl+C quit",
      (selectedIndex) => {
        const session = sessionSummaries[selectedIndex];
        return session ? sessionDetailLines(session) : [];
      },
    );

    if (sessionChoice.kind === "quit") return null;
    if (sessionChoice.kind !== "select") continue;

    return { session: sessionSummaries[sessionChoice.index].session, env: selectedEnv };
  }
}
