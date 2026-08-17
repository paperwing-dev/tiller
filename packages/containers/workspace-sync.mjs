#!/usr/bin/env node
// workspace-sync.mjs — Container ↔ Workspace DO sync via public API
// Replaces rclone. Uses manifest-diff for incremental sync, tar for initial download.
//
// Usage:
//   node /workspace-sync.mjs down   — sync DO → local /workspace
//   node /workspace-sync.mjs up     — sync local /workspace → DO

// Fix Node.js 22 undici IPv6/Happy Eyeballs hang (nodejs/node#56204).
// Reduces auto-select family timeout so IPv4 fallback happens quickly.
import { setDefaultAutoSelectFamilyAttemptTimeout, getDefaultAutoSelectFamily, getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
setDefaultAutoSelectFamilyAttemptTimeout(100);

import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, unlinkSync, utimesSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isExcluded } from "./workspace-policy.mjs";

// ── Config ────────────────────────────────────────────────────────────

const WORKSPACE = process.env.TILLER_WORKSPACE_SYNC_WORKSPACE || "/workspace";
const MANIFEST_CACHE = process.env.TILLER_WORKSPACE_SYNC_MANIFEST_CACHE || "/tmp/.workspace-manifest.json";
const LAST_SYNC = process.env.TILLER_WORKSPACE_SYNC_LAST_SYNC || "/tmp/.last-sync";
const CURL_TMP = process.env.TILLER_WORKSPACE_SYNC_CURL_TMP || "/tmp/.sync-curl-body";
const RESULT_FILE = process.env.TILLER_WORKSPACE_SYNC_RESULT_FILE || "";
const SYNC_OP_ID = process.env.TILLER_WORKSPACE_SYNC_OP_ID || "";
const COMMAND = process.argv[2];
const MAX_CONVERGENCE_PASSES = 5;

const HUB_URL = process.env.HUB_URL;
const SLUG = process.env.REPO_SLUG;
const CF_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;
const RUNTIME_CAPABILITY = process.env.TILLER_RUNTIME_CAPABILITY;
const BOOT_PROGRESS_URL = `${HUB_URL}/api/envs/${SLUG}/boot-progress`;

const FETCH_TIMEOUT_MS = 30_000;

if (!HUB_URL || !SLUG) {
  console.error("[sync] HUB_URL and REPO_SLUG are required");
  process.exit(1);
}

const API_BASE = `${HUB_URL}/api/workspace/${SLUG}`;
const GITHUB_BASE_COMMIT_SHA = process.env.TILLER_GITHUB_BASE_COMMIT_SHA?.trim() || "";
const GITHUB_BASE_MODE = Boolean(GITHUB_BASE_COMMIT_SHA);
const GITHUB_DRAFT_FULL = process.env.TILLER_GITHUB_WORKSPACE_DRAFT_FULL === "1";
const STARTUP_DEADLINE_AT_MS = COMMAND === "down"
  ? Number.parseInt(process.env.TILLER_STARTUP_DEADLINE_AT_MS || "", 10)
  : Number.NaN;

function syncResult(status, values = {}) {
  return {
    status,
    opId: SYNC_OP_ID,
    changedCount: values.changedCount ?? 0,
    deletedCount: values.deletedCount ?? 0,
    uploadedBytes: values.uploadedBytes ?? 0,
    completedAt: new Date().toISOString(),
    ...(values.error ? { error: values.error } : {}),
  };
}

function writeSyncResult(result) {
  if (!RESULT_FILE) return;
  try {
    writeFileSync(RESULT_FILE, JSON.stringify(result));
  } catch (error) {
    console.error(`[sync] Failed to write result file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isPermissionError(error) {
  return error && typeof error === "object" && (error.code === "EACCES" || error.code === "EPERM");
}

function makeSharedStateFileWritable(filePath) {
  try {
    chmodSync(filePath, 0o666);
  } catch {
    // Best effort: sync state files are local caches and should not block persistence.
  }
}

function prepareSharedStateOutputFile(filePath, label) {
  if (!existsSync(filePath)) return;
  try {
    chmodSync(filePath, 0o666);
    return;
  } catch {
    // Try replacing the file below.
  }
  try {
    unlinkSync(filePath);
  } catch (error) {
    console.warn(`[sync] Failed to prepare ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeSharedStateFile(filePath, content, label) {
  try {
    prepareSharedStateOutputFile(filePath, label);
    writeFileSync(filePath, content);
    makeSharedStateFileWritable(filePath);
    return true;
  } catch (error) {
    if (isPermissionError(error)) {
      try {
        unlinkSync(filePath);
        writeFileSync(filePath, content);
        makeSharedStateFileWritable(filePath);
        return true;
      } catch (retryError) {
        console.warn(`[sync] Failed to write ${label}: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        return false;
      }
    }
    console.warn(`[sync] Failed to write ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ── Networking ───────────────────────────────────────────────────────

function authHeaders() {
  return {
    ...(CF_ID && CF_SECRET
      ? { "CF-Access-Client-Id": CF_ID, "CF-Access-Client-Secret": CF_SECRET }
      : {}),
    ...(RUNTIME_CAPABILITY ? { "X-Tiller-Capability": RUNTIME_CAPABILITY } : {}),
  };
}

async function postProgress(message, stepId = "workspace-sync") {
  try {
    await fetch(BOOT_PROGRESS_URL, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, stepId }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Best effort only — save progress should not block persistence.
  }
}

/** Log network diagnostics — called once on first fetch failure */
let _diagRan = false;
async function logDiagnostics(fetchErr) {
  if (_diagRan) return;
  _diagRan = true;

  const hostname = new URL(HUB_URL).hostname;
  console.error(`[diag] fetch failed: ${fetchErr.name}: ${fetchErr.message}`);
  console.error(`[diag] Node.js ${process.version}, autoSelectFamily=${getDefaultAutoSelectFamily()}, timeout=${getDefaultAutoSelectFamilyAttemptTimeout()}ms`);
  console.error(`[diag] NODE_OPTIONS=${process.env.NODE_OPTIONS || "(unset)"}`);

  try {
    const result = await lookup(hostname, { all: true });
    console.error(`[diag] DNS ${hostname} →`, result.map(r => `${r.address} (IPv${r.family})`).join(", "));
  } catch (err) {
    console.error(`[diag] DNS lookup failed:`, err.message);
  }
}

function remainingRequestTimeoutMs(requestedTimeoutMs = FETCH_TIMEOUT_MS) {
  if (!Number.isFinite(STARTUP_DEADLINE_AT_MS)) return requestedTimeoutMs;
  const remainingMs = STARTUP_DEADLINE_AT_MS - Date.now();
  if (remainingMs <= 0) throw new Error("Workspace hydration exceeded the startup deadline.");
  return Math.max(1, Math.min(requestedTimeoutMs, remainingMs));
}

/** curl fallback — returns a fetch-like response object */
function curlFetch(url, opts = {}) {
  const method = opts.method || "GET";
  const timeoutMs = remainingRequestTimeoutMs(opts.timeoutMs || FETCH_TIMEOUT_MS);
  const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));

  const args = ["-s", "--max-time", String(timeout), "--retry", "3", "--retry-max-time", String(timeout), "-o", CURL_TMP, "-w", "%{http_code}"];
  if (method !== "GET") args.push("-X", method);

  const headers = opts.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    args.push("-H", `${k}: ${v}`);
  }

  if (opts.body) args.push("--data-raw", opts.body);
  args.push(url);

  prepareSharedStateOutputFile(CURL_TMP, "curl response cache");
  const statusStr = execFileSync("curl", args, {
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
    timeout: timeoutMs + 1_000,
  }).trim();

  const status = parseInt(statusStr, 10);
  const bodyBuffer = readFileSync(CURL_TMP);
  makeSharedStateFileWritable(CURL_TMP);

  return {
    ok: status >= 200 && status < 300,
    status,
    json() { return JSON.parse(bodyBuffer.toString("utf-8")); },
    text() { return bodyBuffer.toString("utf-8"); },
    get body() {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(bodyBuffer));
          controller.close();
        },
      });
    },
  };
}

/**
 * Resilient HTTP fetch: try native fetch first, on failure log diagnostics
 * once and fall back to curl so the container always boots.
 */
async function safeFetch(url, opts = {}) {
  const label = `${opts.method || "GET"} ${url.replace(API_BASE, "")}`;
  const start = Date.now();
  console.log(`[sync] → ${label}`);

  // Try native fetch
  try {
    const { timeoutMs: requestedTimeoutMs, ...fetchOpts } = opts;
    const timeoutMs = remainingRequestTimeoutMs(requestedTimeoutMs || FETCH_TIMEOUT_MS);
    const resp = await fetch(url, {
      ...fetchOpts,
      signal: AbortSignal.timeout(timeoutMs),
    });
    console.log(`[sync] ← ${label} ${resp.status} (${Date.now() - start}ms)`);
    return resp;
  } catch (fetchErr) {
    const elapsed = Date.now() - start;
    console.error(`[sync] ✗ ${label} fetch failed after ${elapsed}ms: ${fetchErr.name}: ${fetchErr.message}`);
    await logDiagnostics(fetchErr);
  }

  // Fallback to curl
  try {
    remainingRequestTimeoutMs(opts.timeoutMs || FETCH_TIMEOUT_MS);
    console.log(`[sync] ↻ ${label} retrying with curl...`);
    const resp = curlFetch(url, opts);
    console.log(`[sync] ← ${label} ${resp.status} via curl (${Date.now() - start}ms)`);
    return resp;
  } catch (curlErr) {
    console.error(`[sync] ✗ ${label} curl also failed: ${curlErr.message}`);
    throw curlErr;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function filterRuntimeEntries(entries) {
  return entries.filter((entry) => !isExcluded(entry.path));
}

function normalizeWorkspacePath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function isGitHubDeletionMetadataPath(path) {
  return normalizeWorkspacePath(path) === "/.tiller/github-deleted-paths.json";
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function readCachedManifest() {
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_CACHE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function manifestEntriesFromLocal(local) {
  return Object.entries(local)
    .map(([path, info]) => ({
      path,
      size: info.size,
      mtime: info.mtimeMs,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function localFromManifest(entries) {
  const result = {};
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string") continue;
    result[normalizeWorkspacePath(entry.path)] = {
      size: Number(entry.size) || 0,
      mtimeMs: Number(entry.mtime ?? entry.mtimeMs) || 0,
    };
  }
  return result;
}

function sameLocalSnapshot(left, right) {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  if (!sameStringSet(leftPaths, rightPaths)) return false;
  return leftPaths.every((path) => left[path].size === right[path].size && left[path].mtimeMs === right[path].mtimeMs);
}

function changedPathsFromBaseline(local, baseline) {
  return Object.entries(local)
    .filter(([path, info]) => !baseline[path] || baseline[path].size !== info.size || baseline[path].mtimeMs !== info.mtimeMs)
    .map(([path]) => path)
    .sort((left, right) => left.localeCompare(right));
}

function deletedPathsFromBaseline(local, baseline) {
  return Object.keys(baseline).filter((path) => !local[path]).sort((left, right) => left.localeCompare(right));
}

/** Walk local workspace and return { path → { size, mtimeMs } } */
function walkLocal(dir, base = dir) {
  const result = {};
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = "/" + relative(base, full);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      Object.assign(result, walkLocal(full, base));
    } else if (entry.isFile()) {
      const st = statSync(full);
      result[rel] = { size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return result;
}

function splitNulList(value) {
  return value.split("\0").map((path) => path.trim()).filter(Boolean);
}

function gitPathToWorkspacePath(path) {
  return normalizeWorkspacePath(path.replace(/^\/+/, ""));
}

function readGitPathList(args) {
  try {
    return splitNulList(execFileSync("git", args, {
      cwd: WORKSPACE,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function ensureGitSafeWorkspace() {
  let safeDirectories = [];
  try {
    safeDirectories = execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).filter(Boolean);
  } catch {
    safeDirectories = [];
  }
  if (safeDirectories.includes(WORKSPACE)) {
    return;
  }
  try {
    execFileSync("git", ["config", "--global", "--add", "safe.directory", WORKSPACE], {
      stdio: "ignore",
    });
  } catch (error) {
    console.warn(`[sync] Failed to mark ${WORKSPACE} as a safe Git directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readGitChangeSet() {
  ensureGitSafeWorkspace();
  if (!GITHUB_BASE_COMMIT_SHA) throw new Error("TILLER_GITHUB_BASE_COMMIT_SHA is required for GitHub workspace persistence.");
  const diffArgs = ["diff", "--no-renames", "--name-only", "-z"];
  const changed = new Set([
    ...readGitPathList([...diffArgs, "--diff-filter=ACMRT", GITHUB_BASE_COMMIT_SHA, "--", "."]),
    ...readGitPathList(["ls-files", "--others", "--exclude-standard", "-z"]),
  ].map(gitPathToWorkspacePath));
  const deleted = new Set(
    readGitPathList([...diffArgs, "--diff-filter=D", GITHUB_BASE_COMMIT_SHA, "--", "."])
      .map(gitPathToWorkspacePath),
  );

  const changedFiles = [];
  for (const path of changed) {
    if (isExcluded(path) || deleted.has(path)) continue;
    try {
      if (statSync(join(WORKSPACE, path)).isFile()) {
        changedFiles.push(path);
      }
    } catch {
      // The file disappeared while scanning; ignore and let a later sync retry.
    }
  }

  return {
    changed: changedFiles.sort((left, right) => left.localeCompare(right)),
    deleted: Array.from(deleted)
      .filter((path) => !isExcluded(path))
      .sort((left, right) => left.localeCompare(right)),
  };
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return right.every((value) => leftSet.has(value));
}

// ── Tar extraction (same approach as DO-side initFromTarball) ─────────

async function extractTar(stream) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  let fileCount = 0;
  const decoder = new TextDecoder();

  function append(existing, chunk) {
    const merged = new Uint8Array(existing.length + chunk.length);
    merged.set(existing);
    merged.set(chunk, existing.length);
    return merged;
  }

  while (true) {
    // Read at least 512 bytes for header
    while (buffer.length < 512) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = append(buffer, value);
    }
    if (buffer.length < 512) break;

    const header = buffer.slice(0, 512);
    if (header.every((b) => b === 0)) break;

    const rawName = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, "");
    const sizeOctal = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, "").trim();
    const typeFlag = decoder.decode(header.slice(156, 157));
    const prefix = decoder.decode(header.slice(345, 500)).replace(/\0.*$/, "");

    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    const paddedSize = Math.ceil(size / 512) * 512;

    buffer = buffer.slice(512);

    // Read content
    while (buffer.length < paddedSize) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = append(buffer, value);
    }

    const content = buffer.slice(0, size);
    buffer = buffer.slice(paddedSize);

    // Skip directories and special entries
    if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x") continue;
    if (size === 0 && rawName.endsWith("/")) continue;

    // Path from tar is workspace-relative (no leading prefix to strip)
    const wsPath = fullName.startsWith("/") ? fullName : "/" + fullName;
    if (isExcluded(wsPath)) continue;

    const localPath = join(WORKSPACE, wsPath);

    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, content);
    fileCount++;
  }

  return fileCount;
}

async function downloadFiles(paths) {
  if (paths.length === 0) {
    return;
  }
  console.log(`[sync] Downloading ${paths.length} changed files...`);
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50);
    console.log(`[sync] Batch ${Math.floor(i / 50) + 1}: ${batch.length} files`);
    const resp = await safeFetch(`${API_BASE}/files`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ paths: batch }),
    });
    if (!resp.ok) throw new Error(`Workspace hydration batch failed: ${resp.status} ${await resp.text().catch(() => "")}`);
    const body = await resp.json().catch(() => null);
    if (!Array.isArray(body?.files)) throw new Error("Workspace hydration batch response did not contain files.");
    const filesByPath = new Map(body.files.map((file) => [normalizeWorkspacePath(file?.path ?? ""), file]));
    const missing = batch.filter((path) => !filesByPath.has(normalizeWorkspacePath(path)));
    if (missing.length > 0) throw new Error(`Workspace hydration batch omitted ${missing.length} requested file${missing.length === 1 ? "" : "s"}.`);
    for (const requestedPath of batch) {
      const file = filesByPath.get(normalizeWorkspacePath(requestedPath));
      if (!file || typeof file.content !== "string" || isExcluded(file.path)) throw new Error(`Workspace hydration returned invalid content for ${requestedPath}.`);
      const localPath = join(WORKSPACE, file.path);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, file.content, "utf-8");
    }
  }
}

async function deleteRemotePaths(paths) {
  if (paths.length === 0) {
    return 0;
  }

  let deleted = 0;
  for (let i = 0; i < paths.length; i += 50) {
    const batch = paths.slice(i, i + 50);
    const resp = await safeFetch(`${API_BASE}/delete`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ paths: batch }),
    });
    if (!resp.ok) throw new Error(`Failed to delete remote paths: ${resp.status} ${await resp.text().catch(() => "")}`);
    deleted += batch.length;
  }

  return deleted;
}

async function fetchRemoteManifest() {
  const manifestResp = await safeFetch(`${API_BASE}/manifest`, { headers: authHeaders() });
  if (!manifestResp.ok) {
    throw new Error(`Failed to fetch manifest: ${manifestResp.status} ${await manifestResp.text().catch(() => "")}`);
  }
  const body = await manifestResp.json();
  if (!Array.isArray(body)) {
    throw new Error("Workspace manifest response was not an array.");
  }
  return body;
}

async function fetchDeletedPaths() {
  const response = await safeFetch(`${API_BASE}/deletions`, { headers: authHeaders() });
  if (!response.ok) {
    throw new Error(`Failed to fetch deletion list: ${response.status} ${await response.text().catch(() => "")}`);
  }
  const body = await response.json().catch(() => null);
  return Array.isArray(body?.paths)
    ? body.paths.filter((path) => typeof path === "string").map(normalizeWorkspacePath)
    : [];
}

async function replaceDeletedPaths(paths) {
  const response = await safeFetch(`${API_BASE}/deletions`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!response.ok) {
    throw new Error(`Failed to replace deletion list: ${response.status} ${await response.text().catch(() => "")}`);
  }
}

function applyDeletedPaths(paths) {
  let deletedCount = 0;
  for (const path of paths) {
    if (isExcluded(path)) continue;
    const localPath = join(WORKSPACE, path);
    try {
      unlinkSync(localPath);
      deletedCount++;
    } catch {
      // Already absent.
    }
  }
  if (deletedCount > 0) {
    console.log(`[sync] Applied ${deletedCount} GitHub draft deletion${deletedCount === 1 ? "" : "s"}`);
  }
}

function verifyHydratedManifest(remoteManifest) {
  const local = walkLocal(WORKSPACE);
  const incomplete = remoteManifest.filter((entry) => {
    const localEntry = local[normalizeWorkspacePath(entry.path)];
    return !localEntry || localEntry.size !== Number(entry.size);
  });
  if (incomplete.length > 0) throw new Error(`Workspace hydration incomplete: ${incomplete.length} file${incomplete.length === 1 ? "" : "s"} missing or truncated.`);
}

// ── sync_down ─────────────────────────────────────────────────────────

async function syncDown() {
  console.log(`[sync] syncDown starting — API_BASE=${API_BASE}`);

  // Fetch remote manifest
  const [remoteManifest, githubDeletedPaths] = await Promise.all([
    fetchRemoteManifest(),
    GITHUB_BASE_MODE ? fetchDeletedPaths() : Promise.resolve([]),
  ]);
  const visibleRemoteManifest = filterRuntimeEntries(remoteManifest);
  const excludedRemotePaths = GITHUB_BASE_MODE
    ? []
    : remoteManifest
        .map((entry) => entry.path)
        .filter((path) => isExcluded(path) && !isGitHubDeletionMetadataPath(path));
  const filteredRemoteCount = excludedRemotePaths.length;
  console.log(`[sync] Manifest: ${remoteManifest.length} remote files`);
  if (filteredRemoteCount > 0) {
    const deletedCount = await deleteRemotePaths(excludedRemotePaths);
    if (deletedCount > 0) {
      console.log(`[sync] Removed ${deletedCount} runtime-only remote files`);
    } else {
      console.log(`[sync] Skipping ${filteredRemoteCount} runtime-only remote files`);
    }
  }

  // Check if local workspace is empty
  const localFiles = walkLocal(WORKSPACE);
  const localCount = Object.keys(localFiles).length;
  console.log(`[sync] Local workspace: ${localCount} files`);

  if (visibleRemoteManifest.length === 0) {
    console.log("[sync] Remote workspace is empty, nothing to sync down");
    if (GITHUB_BASE_MODE) applyDeletedPaths(githubDeletedPaths);
    if (GITHUB_BASE_MODE) console.log("[sync] GitHub base mode: caching checkout files for future delete detection");
    commitSyncState(walkLocal(WORKSPACE), Date.now());
    return;
  }

  if (localCount === 0) {
    // First boot: download tar
    console.log(`[sync] Initial sync: downloading ${visibleRemoteManifest.length} visible files as tar...`);
    const tarResp = await safeFetch(`${API_BASE}/download`, {
      headers: authHeaders(),
      timeoutMs: 60_000, // tar can be large
    });
    if (!tarResp.ok || !tarResp.body) {
      throw new Error(`Failed to download workspace: ${tarResp.status} ${await tarResp.text().catch(() => "")}`);
    }
    const count = await extractTar(tarResp.body);
    console.log(`[sync] Extracted ${count} files to ${WORKSPACE}`);
  } else {
    // Restart: diff and download only changed files
    console.log(`[sync] Incremental sync: ${localCount} local, ${visibleRemoteManifest.length} visible remote`);

    const toDownload = [];
    const remoteByPath = new Map(visibleRemoteManifest.map((f) => [f.path, f]));

    for (const [path, remote] of remoteByPath) {
      const local = localFiles[path];
      if (!local || local.size !== remote.size || local.mtimeMs < remote.mtime) {
        toDownload.push(path);
      }
    }

    if (!GITHUB_BASE_MODE || GITHUB_DRAFT_FULL) {
      // Delete local files not in remote manifest once WorkspaceDO represents a
      // full stopped draft. First GitHub starts overlay plan/draft files only.
      let deletedCount = 0;
      for (const path of Object.keys(localFiles)) {
        if (!remoteByPath.has(path)) {
          const localPath = join(WORKSPACE, path);
          try { unlinkSync(localPath); deletedCount++; } catch { /* ignore */ }
        }
      }
      if (deletedCount > 0) console.log(`[sync] Deleted ${deletedCount} stale local files`);
    } else {
      console.log("[sync] GitHub base mode: overlaying remote draft without deleting checkout files");
    }

    if (toDownload.length > 0) {
      await downloadFiles(toDownload);
    } else {
      console.log("[sync] No changed files to download");
    }
  }

  if (GITHUB_BASE_MODE) applyDeletedPaths(githubDeletedPaths);
  verifyHydratedManifest(visibleRemoteManifest);

  // In GitHub base mode WorkspaceDO is a sparse draft overlay. Cache the full
  // checkout after overlay so sync_up can detect explicit deletes without
  // rewriting every unchanged file.
  commitSyncState(walkLocal(WORKSPACE), Date.now());
  console.log("[sync] syncDown complete");
}

// ── sync_up ───────────────────────────────────────────────────────────

async function uploadChangedFilesStrict(changed) {
  let uploadedBytes = 0;
  for (let i = 0; i < changed.length; i += 50) {
    const batch = changed.slice(i, i + 50);
    const files = batch.map((path) => {
      const content = readFileSync(join(WORKSPACE, path), "utf-8");
      uploadedBytes += Buffer.byteLength(content);
      return { path, content };
    });
    const resp = await safeFetch(`${API_BASE}/write`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!resp.ok) throw new Error(`Batch write failed: ${resp.status} ${await resp.text().catch(() => "")}`);
  }
  return uploadedBytes;
}

function sameGitChangeSet(left, right) {
  return sameStringSet(left.changed, right.changed) && sameStringSet(left.deleted, right.deleted);
}

async function syncUpGitHubReliable() {
  await postProgress("Checking git changes...");
  const affectedChanged = new Set();
  const affectedDeleted = new Set();
  let uploadedBytes = 0;

  for (let pass = 1; pass <= MAX_CONVERGENCE_PASSES; pass++) {
    const scanStartedAt = Date.now();
    const beforeSnapshot = walkLocal(WORKSPACE);
    const beforeChanges = readGitChangeSet();
    const { changed, deleted } = beforeChanges;
    const [remoteManifest, remoteDeletedPaths] = await Promise.all([fetchRemoteManifest(), fetchDeletedPaths()]);
    const changedSet = new Set(changed);
    const deletedSet = new Set(deleted);
    const staleRemotePaths = filterRuntimeEntries(remoteManifest)
      .map((entry) => normalizeWorkspacePath(entry.path))
      .filter((path) => !changedSet.has(path) && !deletedSet.has(path))
      .sort((left, right) => left.localeCompare(right));
    const deletionsDiffer = !sameStringSet(remoteDeletedPaths.sort((a, b) => a.localeCompare(b)), deleted);

    if (changed.length === 0 && deleted.length === 0 && staleRemotePaths.length === 0 && !deletionsDiffer) {
      console.log("[sync] No git changes to sync up");
    } else {
      if (changed.length > 0) {
        const bytes = changed.reduce((total, path) => total + (beforeSnapshot[path]?.size ?? 0), 0);
        const message = `Uploading ${changed.length} git-changed file${changed.length === 1 ? "" : "s"} (${formatBytes(bytes)})...`;
        console.log(`[sync] ${message}`);
        await postProgress(message);
        uploadedBytes += await uploadChangedFilesStrict(changed);
        changed.forEach((path) => affectedChanged.add(path));
      }
      const pathsToDelete = Array.from(new Set([...deleted, ...staleRemotePaths])).sort((a, b) => a.localeCompare(b));
      if (pathsToDelete.length > 0) {
        await deleteRemotePaths(pathsToDelete);
        pathsToDelete.forEach((path) => affectedDeleted.add(path));
      }
      if (deleted.length > 0 || deletionsDiffer || staleRemotePaths.length > 0) await replaceDeletedPaths(deleted);
    }

    const afterSnapshot = walkLocal(WORKSPACE);
    const afterChanges = readGitChangeSet();
    if (sameLocalSnapshot(beforeSnapshot, afterSnapshot) && sameGitChangeSet(beforeChanges, afterChanges)) {
      commitSyncState(afterSnapshot, scanStartedAt);
      await postProgress(affectedChanged.size === 0 && affectedDeleted.size === 0
        ? "No workspace changes to save."
        : `Workspace save ready: ${affectedChanged.size} file${affectedChanged.size === 1 ? "" : "s"} uploaded (${formatBytes(uploadedBytes)}), ${affectedDeleted.size} deleted.`);
      return syncResult("succeeded", { changedCount: affectedChanged.size, deletedCount: affectedDeleted.size, uploadedBytes });
    }
    console.log(`[sync] Workspace changed during save; rerunning convergence pass ${pass + 1}`);
  }
  throw new Error(`Workspace did not converge after ${MAX_CONVERGENCE_PASSES} save passes.`);
}

async function syncUpReliable() {
  if (GITHUB_BASE_MODE) return syncUpGitHubReliable();

  let baseline = localFromManifest(readCachedManifest());
  await postProgress("Checking workspace for changes...");
  const affectedChanged = new Set();
  const affectedDeleted = new Set();
  let uploadedBytes = 0;
  for (let pass = 1; pass <= MAX_CONVERGENCE_PASSES; pass++) {
    const scanStartedAt = Date.now();
    const beforeSnapshot = walkLocal(WORKSPACE);
    const remoteManifest = await fetchRemoteManifest();
    const remotePaths = new Set(
      filterRuntimeEntries(remoteManifest).map((entry) => normalizeWorkspacePath(entry.path)),
    );
    const changed = Array.from(new Set([
      ...changedPathsFromBaseline(beforeSnapshot, baseline),
      ...Object.keys(beforeSnapshot).filter((path) => !remotePaths.has(path)),
    ])).sort((left, right) => left.localeCompare(right));
    const deleted = Array.from(new Set([
      ...deletedPathsFromBaseline(beforeSnapshot, baseline),
      ...Array.from(remotePaths).filter((path) => !beforeSnapshot[path]),
    ])).sort((left, right) => left.localeCompare(right));
    if (changed.length > 0) {
      uploadedBytes += await uploadChangedFilesStrict(changed);
      changed.forEach((path) => affectedChanged.add(path));
    }
    if (deleted.length > 0) {
      await deleteRemotePaths(deleted);
      deleted.forEach((path) => affectedDeleted.add(path));
    }
    const afterSnapshot = walkLocal(WORKSPACE);
    baseline = beforeSnapshot;
    if (sameLocalSnapshot(beforeSnapshot, afterSnapshot)) {
      if (affectedChanged.size === 0 && affectedDeleted.size === 0) {
        console.log("[sync] Workspace already converged with remote storage");
      }
      commitSyncState(afterSnapshot, scanStartedAt);
      await postProgress(affectedChanged.size === 0 && affectedDeleted.size === 0
        ? "No workspace changes to save."
        : `Workspace save ready: ${affectedChanged.size} file${affectedChanged.size === 1 ? "" : "s"} uploaded (${formatBytes(uploadedBytes)}), ${affectedDeleted.size} deleted.`);
      return syncResult("succeeded", { changedCount: affectedChanged.size, deletedCount: affectedDeleted.size, uploadedBytes });
    }
    console.log(`[sync] Workspace changed during save; rerunning convergence pass ${pass + 1}`);
  }
  throw new Error(`Workspace did not converge after ${MAX_CONVERGENCE_PASSES} save passes.`);
}

// ── Timestamp helpers ─────────────────────────────────────────────────

function touchLastSync(watermarkMs = Date.now()) {
  if (!writeSharedStateFile(LAST_SYNC, watermarkMs.toString(), "last sync marker")) throw new Error("Failed to update the last sync marker.");
  const watermark = new Date(watermarkMs);
  utimesSync(LAST_SYNC, watermark, watermark);
}

function commitSyncState(local, watermarkMs) {
  if (!writeSharedStateFile(MANIFEST_CACHE, JSON.stringify(manifestEntriesFromLocal(local)), "workspace manifest cache")) {
    throw new Error("Failed to update the workspace manifest cache.");
  }
  touchLastSync(watermarkMs);
}

// ── Main ──────────────────────────────────────────────────────────────

if (COMMAND === "down") {
  await syncDown().catch((err) => {
    console.error("[sync] syncDown crashed:", err);
    process.exit(1);
  });
} else if (COMMAND === "up") {
  await syncUpReliable().then((result) => {
    writeSyncResult(result ?? syncResult("succeeded"));
  }).catch((err) => {
    console.error("[sync] syncUp crashed:", err);
    writeSyncResult(syncResult("failed", {
      error: err instanceof Error ? err.message : String(err),
    }));
    process.exit(1);
  });
} else {
  console.error("Usage: node workspace-sync.mjs <down|up>");
  process.exit(1);
}
