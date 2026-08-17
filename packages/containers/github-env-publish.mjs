#!/usr/bin/env node
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const env = process.env;
const required = [
  "HUB_URL",
  "REPO_URL",
  "TILLER_ENV_SLUG",
  "TILLER_REPO_ID",
  "TILLER_GITHUB_PUBLISH_OPERATION_ID",
  "TILLER_GITHUB_BASE_COMMIT_SHA",
  "TILLER_GITHUB_BRANCH",
  "TILLER_GITHUB_WORKSPACE_HASH",
  "TILLER_GITHUB_ADOPTION_HMAC",
  "TILLER_GITHUB_CALLBACK_TOKEN",
  "TILLER_GITHUB_COMMIT_TITLE",
  "TILLER_GITHUB_COMMIT_AUTHOR_NAME",
  "TILLER_GITHUB_COMMIT_AUTHOR_EMAIL",
  "TILLER_GITHUB_PUBLISH_RESULT_URL",
  "TILLER_ENV_WORKSPACE_API_BASE",
];

function fail(message, code = "github_env_publish_failed") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

for (const name of required) {
  if (!env[name]?.trim())
    fail(`Missing required environment variable ${name}.`, "missing_env");
}

const HUB_URL = env.HUB_URL.replace(/\/+$/, "");
const WORKSPACE_API_BASE = env.TILLER_ENV_WORKSPACE_API_BASE.replace(
  /\/+$/,
  "",
);
const REPO_URL = env.REPO_URL;
const ENV_SLUG = env.TILLER_ENV_SLUG;
const REPO_ID = env.TILLER_REPO_ID;
const OPERATION_ID = env.TILLER_GITHUB_PUBLISH_OPERATION_ID;
const BASE_COMMIT = env.TILLER_GITHUB_BASE_COMMIT_SHA;
const BRANCH = env.TILLER_GITHUB_BRANCH;
const EXPECTED_HEAD = env.TILLER_GITHUB_EXPECTED_HEAD?.trim() || null;
const WORKSPACE_HASH = env.TILLER_GITHUB_WORKSPACE_HASH;
const ADOPTION_HMAC = env.TILLER_GITHUB_ADOPTION_HMAC;
const CALLBACK_TOKEN = env.TILLER_GITHUB_CALLBACK_TOKEN;
const COMMIT_TITLE = env.TILLER_GITHUB_COMMIT_TITLE.replace(/[\r\n]+/g, " ")
  .trim()
  .slice(0, 240);
const COMMIT_AUTHOR_NAME = env.TILLER_GITHUB_COMMIT_AUTHOR_NAME.replace(
  /[\r\n]+/g,
  " ",
)
  .trim()
  .slice(0, 240);
const COMMIT_AUTHOR_EMAIL = env.TILLER_GITHUB_COMMIT_AUTHOR_EMAIL.trim();
const RESULT_URL = env.TILLER_GITHUB_PUBLISH_RESULT_URL;
const EXCLUDED_PREFIXES = (env.TILLER_ENV_ONLY_PATHS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function publishRuntimeHeaders() {
  const headers = {};
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  headers["X-Tiller-GitHub-Publish-Operation-Id"] = OPERATION_ID;
  headers["X-Tiller-GitHub-Publish-Token"] = CALLBACK_TOKEN;
  return headers;
}

function authHeaders() {
  return { "Content-Type": "application/json", ...publishRuntimeHeaders() };
}

async function postResult(payload) {
  const response = await fetch(RESULT_URL, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      operationId: OPERATION_ID,
      envSlug: ENV_SLUG,
      repoId: REPO_ID,
      branch: BRANCH,
      baseCommitSha: BASE_COMMIT,
      workspaceHash: WORKSPACE_HASH,
      expectedPriorHead: EXPECTED_HEAD,
      callbackToken: CALLBACK_TOKEN,
      ...payload,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(
      `Publish callback failed: HTTP ${response.status} ${text}`,
      "callback_failed",
    );
  }
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    maxBuffer: 100 * 1024 * 1024,
  });
}

function matchesPrefix(path) {
  return EXCLUDED_PREFIXES.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}

function workspacePath(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

function relativeWorkspacePath(path) {
  return path.replace(/^\/+/, "");
}

function isExcluded(path) {
  return matchesPrefix(workspacePath(path));
}

function assertSafeTarPath(path) {
  const normalized = normalize(`/${path}`).replace(/\\/g, "/");
  if (
    !normalized.startsWith("/") ||
    normalized.includes("/../") ||
    normalized === "/.."
  ) {
    fail(`Unsafe draft path in workspace tar: ${path}`, "unsafe_path");
  }
  return normalized;
}

function parseTar(buffer) {
  const entries = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = decoder
      .decode(header.subarray(0, 100))
      .replace(/\0.*$/, "");
    const sizeOctal = decoder
      .decode(header.subarray(124, 136))
      .replace(/\0.*$/, "")
      .trim();
    const typeFlag = decoder.decode(header.subarray(156, 157));
    const prefix = decoder
      .decode(header.subarray(345, 500))
      .replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    const paddedSize = Math.ceil(size / 512) * 512;
    offset += 512;
    if (offset + paddedSize > buffer.length)
      fail("Invalid workspace tar: truncated entry.", "invalid_tar");
    const content = buffer.subarray(offset, offset + size);
    offset += paddedSize;
    if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x") continue;
    if (!fullName || (size === 0 && rawName.endsWith("/"))) continue;
    if (typeFlag && typeFlag !== "0" && typeFlag !== "\0") {
      fail(
        `Unsupported workspace tar entry type ${JSON.stringify(typeFlag)} for ${fullName}.`,
        "unsupported_metadata",
      );
    }
    const path = assertSafeTarPath(fullName);
    if (isExcluded(path)) continue;
    entries.push({ path, content });
  }
  return entries;
}

async function downloadWorkspaceTar() {
  const response = await fetch(`${WORKSPACE_API_BASE}/download`, {
    headers: publishRuntimeHeaders(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(
      `Failed to download workspace draft: HTTP ${response.status} ${text}`,
      "workspace_download_failed",
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadDeletedPaths() {
  const response = await fetch(`${WORKSPACE_API_BASE}/deletions`, {
    headers: publishRuntimeHeaders(),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    fail(
      `Failed to download workspace deletion list: HTTP ${response.status} ${text}`,
      "workspace_deletions_failed",
    );
  }
  const body = await response.json().catch(() => null);
  return Array.isArray(body?.paths)
    ? body.paths
        .filter((path) => typeof path === "string")
        .map((path) => workspacePath(path))
    : [];
}

function readRemoteHead(repoDir) {
  const output = git(repoDir, [
    "ls-remote",
    "--heads",
    "origin",
    BRANCH,
  ]).trim();
  if (!output) return null;
  return output.split(/\s+/)[0] || null;
}

function parseTrailers(message) {
  const trailers = new Map();
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (match) trailers.set(match[1].toLowerCase(), match[2]);
  }
  return trailers;
}

function pendingCommitMatches(repoDir, sha) {
  try {
    git(repoDir, ["fetch", "--depth", "1", "origin", sha]);
    const message = git(repoDir, ["show", "-s", "--format=%B", sha]);
    const trailers = parseTrailers(message);
    return (
      trailers.get("tiller-env-slug") === ENV_SLUG &&
      trailers.get("tiller-operation-id") === OPERATION_ID &&
      trailers.get("tiller-workspace-hash") === WORKSPACE_HASH &&
      trailers.get("tiller-expected-prior-head") ===
        (EXPECTED_HEAD ?? "(none)") &&
      trailers.get("tiller-base-commit") === BASE_COMMIT &&
      trailers.get("tiller-adoption-hmac") === ADOPTION_HMAC
    );
  } catch {
    return false;
  }
}

function readIndexModes(repoDir) {
  const output = git(repoDir, ["ls-files", "-s", "-z"], { encoding: "buffer" });
  const text = output.toString("utf8");
  const modes = new Map();
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const mode = meta[0];
    const filePath = workspacePath(record.slice(tab + 1));
    if (isExcluded(filePath)) continue;
    modes.set(filePath, mode);
  }
  return modes;
}

function readTreeModes(repoDir, treeish) {
  const output = git(repoDir, ["ls-tree", "-rz", "-r", treeish], {
    encoding: "buffer",
  });
  const text = output.toString("utf8");
  const modes = new Map();
  for (const record of text.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    const mode = meta[0];
    const filePath = workspacePath(record.slice(tab + 1));
    if (isExcluded(filePath)) continue;
    modes.set(filePath, mode);
  }
  return modes;
}

function assertSupportedModes(modes, label, baseModes = null) {
  for (const [filePath, mode] of modes) {
    if (mode !== "100644" && mode !== "100755") {
      fail(
        `Unsupported ${label} metadata for ${filePath}: git mode ${mode}. Tiller GitHub publish supports regular files only.`,
        "unsupported_metadata",
      );
    }
    if (!baseModes) continue;
    const baseMode = baseModes.get(filePath) ?? null;
    if (!baseMode && mode === "100755") {
      fail(
        `Unsupported ${label} metadata for ${filePath}: new executable files are not supported.`,
        "unsupported_metadata",
      );
    }
    if ((baseMode === "100644" || baseMode === "100755") && mode !== baseMode) {
      fail(
        `Unsupported ${label} metadata change for ${filePath}: git mode changed from ${baseMode} to ${mode}.`,
        "unsupported_metadata",
      );
    }
  }
  return modes;
}

function assertSupportedIndex(repoDir, label, baseModes = null) {
  return assertSupportedModes(readIndexModes(repoDir), label, baseModes);
}

function assertSupportedTree(repoDir, treeish, label) {
  return assertSupportedModes(readTreeModes(repoDir, treeish), label);
}

function pathspecArgs() {
  return [
    ".",
    ...EXCLUDED_PREFIXES.map(
      (prefix) => `:(exclude)${relativeWorkspacePath(prefix)}`,
    ),
  ];
}

function nulList(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function resetManagedPathsToBase(repoDir) {
  const specs = pathspecArgs();
  const added = nulList(
    git(
      repoDir,
      [
        "diff",
        "--name-only",
        "-z",
        "--diff-filter=A",
        BASE_COMMIT,
        "HEAD",
        "--",
        ...specs,
      ],
      { encoding: "buffer" },
    ),
  );
  git(repoDir, [
    "restore",
    "--source",
    BASE_COMMIT,
    "--staged",
    "--worktree",
    "--",
    ...specs,
  ]);
  for (const path of added) {
    const workspaceFile = workspacePath(path);
    if (isExcluded(workspaceFile)) continue;
    const fullPath = join(repoDir, relativeWorkspacePath(workspaceFile));
    const relativeToRepo = relative(repoDir, fullPath);
    if (relativeToRepo.startsWith(".."))
      fail(`Unsafe branch-added path outside repo: ${path}`, "unsafe_path");
    rmSync(fullPath, { force: true, recursive: true });
  }
}

function removeDeletedDraftPaths(repoDir, paths) {
  for (const path of paths) {
    if (isExcluded(path)) continue;
    const relativePath = relativeWorkspacePath(path);
    const fullPath = join(repoDir, relativePath);
    const relativeToRepo = relative(repoDir, fullPath);
    if (relativeToRepo.startsWith(".."))
      fail(`Unsafe deleted draft path outside repo: ${path}`, "unsafe_path");
    rmSync(fullPath, { force: true, recursive: true });
  }
}

function writeDraftEntries(repoDir, entries, baseModes) {
  for (const entry of entries) {
    const relativePath = relativeWorkspacePath(entry.path);
    const fullPath = join(repoDir, relativePath);
    const relativeToRepo = relative(repoDir, fullPath);
    if (relativeToRepo.startsWith(".."))
      fail(`Unsafe draft path outside repo: ${entry.path}`, "unsafe_path");
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, entry.content, { mode: 0o644 });
    if (baseModes.get(workspacePath(entry.path)) === "100755") {
      chmodSync(fullPath, 0o755);
    }
  }
}

function commitMessage() {
  const expected = EXPECTED_HEAD ?? "(none)";
  return [
    COMMIT_TITLE,
    "",
    `Tiller-Env-Slug: ${ENV_SLUG}`,
    `Tiller-Operation-Id: ${OPERATION_ID}`,
    `Tiller-Workspace-Hash: ${WORKSPACE_HASH}`,
    `Tiller-Expected-Prior-Head: ${expected}`,
    `Tiller-Base-Commit: ${BASE_COMMIT}`,
    `Tiller-Adoption-Hmac: ${ADOPTION_HMAC}`,
  ].join("\n");
}

async function run() {
  let pushed = false;
  const root = mkdtempSync(join(tmpdir(), "tiller-github-env-publish-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["remote", "add", "origin", REPO_URL]);
  git(repoDir, ["fetch", "--depth", "1", "origin", BASE_COMMIT]);

  const remoteHead = readRemoteHead(repoDir);
  if (remoteHead) {
    git(repoDir, ["fetch", "--depth", "1", "origin", `refs/heads/${BRANCH}`]);
    if (EXPECTED_HEAD && remoteHead !== EXPECTED_HEAD) {
      if (pendingCommitMatches(repoDir, remoteHead)) {
        await postResult({
          status: "published",
          branchHeadSha: remoteHead,
          commitCreated: false,
          adopted: true,
          message: "Adopted matching pending Tiller publish commit.",
        });
        return;
      }
      fail(
        `GitHub branch ${BRANCH} moved from ${EXPECTED_HEAD} to ${remoteHead}.`,
        "branch_changed_on_github",
      );
    }
    if (!EXPECTED_HEAD) {
      if (pendingCommitMatches(repoDir, remoteHead)) {
        await postResult({
          status: "published",
          branchHeadSha: remoteHead,
          commitCreated: false,
          adopted: true,
          message: "Adopted matching pending Tiller publish commit.",
        });
        return;
      }
      fail(
        `GitHub branch ${BRANCH} already exists.`,
        "branch_changed_on_github",
      );
    }
  } else {
    if (EXPECTED_HEAD) {
      fail(
        `GitHub branch ${BRANCH} no longer exists.`,
        "branch_changed_on_github",
      );
    }
  }

  // A Ship branch is a snapshot of the workspace overlay on its recorded base,
  // not an accumulating line of environment publish commits. Keeping the prior
  // branch head as the parent can move GitHub's merge base behind BASE_COMMIT and
  // make the PR include unrelated changes from earlier Ship operations.
  git(repoDir, ["checkout", "-q", "-B", "tiller-env-publish", BASE_COMMIT]);

  const baseModes = assertSupportedTree(repoDir, BASE_COMMIT, "base");
  resetManagedPathsToBase(repoDir);
  const [draftEntries, deletedPaths] = await Promise.all([
    downloadWorkspaceTar().then(parseTar),
    downloadDeletedPaths(),
  ]);
  removeDeletedDraftPaths(repoDir, deletedPaths);
  writeDraftEntries(repoDir, draftEntries, baseModes);
  git(repoDir, ["add", "-A"]);
  assertSupportedIndex(repoDir, "draft", baseModes);

  try {
    git(repoDir, ["diff", "--cached", "--quiet"]);
    await postResult({
      status: "no_changes",
      branchHeadSha: remoteHead,
      commitCreated: false,
    });
    return;
  } catch {
    // git diff --quiet exits 1 when there is a diff.
  }

  git(repoDir, ["config", "user.name", COMMIT_AUTHOR_NAME]);
  git(repoDir, ["config", "user.email", COMMIT_AUTHOR_EMAIL]);
  git(repoDir, ["commit", "-q", "-m", commitMessage()]);
  const head = git(repoDir, ["rev-parse", "HEAD"]).trim();
  try {
    const lease = `--force-with-lease=refs/heads/${BRANCH}:${remoteHead ?? ""}`;
    git(repoDir, ["push", lease, "origin", `HEAD:refs/heads/${BRANCH}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    pushed = true;
  } catch (error) {
    let remoteMoved = false;
    let observedRemoteHead = remoteHead;
    try {
      observedRemoteHead = readRemoteHead(repoDir);
      remoteMoved = observedRemoteHead !== remoteHead;
    } catch {
      // Authentication and network failures are retryable unless a changed head is confirmed.
    }
    if (remoteMoved) {
      fail(
        `GitHub branch ${BRANCH} moved from ${remoteHead ?? "(none)"} to ${observedRemoteHead ?? "(none)"}.`,
        "branch_changed_on_github",
      );
    }
    fail(
      `Failed to push ${BRANCH}: ${error.stderr?.toString?.() || error.message}`,
      "github_env_push_failed",
    );
  }

  await postResult({
    status: "published",
    branchHeadSha: head,
    commitCreated: true,
  });
  return { pushed };
}

run().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code || "github_env_publish_failed";
  if (code === "callback_failed") {
    console.error(`[github-env-publish] ${message}`);
    process.exit(1);
  }
  try {
    await postResult({
      status: "failed",
      error: message,
      code,
      commitCreated: false,
      branchHeadSha: null,
    });
  } catch (callbackError) {
    console.error(
      `[github-env-publish] failed callback also failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
    );
  }
  console.error(`[github-env-publish] ${message}`);
  process.exit(1);
});
