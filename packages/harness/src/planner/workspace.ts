import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);

export interface ExtractTarBufferOptions {
  clean?: boolean;
  stripFirstComponent?: boolean;
}

function isGzipBuffer(buffer: Uint8Array): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function readTarString(decoder: TextDecoder, field: Uint8Array): string {
  const nulIndex = field.indexOf(0);
  return decoder.decode(nulIndex >= 0 ? field.slice(0, nulIndex) : field);
}

function readTarSize(decoder: TextDecoder, field: Uint8Array, entryName: string): number {
  const raw = readTarString(decoder, field).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar entry size for ${entryName || "(unknown entry)"}`);
  }
  return parseInt(raw, 8);
}

function maybeGunzipArchive(buffer: Uint8Array): Uint8Array {
  if (!isGzipBuffer(buffer)) return buffer;
  return gunzipSync(buffer);
}

export function extractTarBuffer(
  tarBuffer: Uint8Array,
  outputDir: string,
  options: ExtractTarBufferOptions = {},
): number {
  if (isGzipBuffer(tarBuffer)) {
    throw new Error("Expected an uncompressed tar archive but received gzip-compressed data.");
  }
  if (options.clean !== false) {
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });
  const decoder = new TextDecoder();
  let buffer = tarBuffer;
  let fileCount = 0;
  const root = resolvePath(outputDir);

  while (buffer.length >= 512) {
    const header = buffer.slice(0, 512);
    if (header.every((byte) => byte === 0)) break;

    const rawName = readTarString(decoder, header.slice(0, 100));
    const typeFlag = readTarString(decoder, header.slice(156, 157));
    const prefix = readTarString(decoder, header.slice(345, 500));
    let fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const size = readTarSize(decoder, header.slice(124, 136), fullName);
    const paddedSize = Math.ceil(size / 512) * 512;
    buffer = buffer.slice(512);
    if (buffer.length < paddedSize) {
      throw new Error(`Tar entry ${fullName || "(unknown entry)"} is truncated`);
    }
    const content = buffer.slice(0, size);
    buffer = buffer.slice(paddedSize);
    if (options.stripFirstComponent) {
      const parts = fullName.split("/").filter(Boolean);
      fullName = parts.length > 1 ? parts.slice(1).join("/") : "";
    }
    if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x" || !fullName || fullName.endsWith("/")) {
      continue;
    }

    const target = resolvePath(outputDir, fullName);
    if (!target.startsWith(`${root}/`) && target !== root) {
      throw new Error(`Refusing to extract path outside checkout: ${fullName}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    fileCount += 1;
  }

  return fileCount;
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function canonicalGitHubRepoFromUrl(repoUrl: string): string {
  const url = new URL(repoUrl);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub archive base materialization requires an https://github.com repository URL.");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("GitHub repository URL must point to github.com/owner/repo.");
  }
  const owner = decodeURIComponent(parts[0]).toLowerCase();
  const repo = stripGitSuffix(decodeURIComponent(parts[1])).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner) || !/^[a-z0-9._-]+$/.test(repo)) {
    throw new Error("GitHub repository URL contains an invalid owner or repository name.");
  }
  return `${owner}/${repo}`;
}

async function readErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown };
    const message = typeof parsed.error === "string"
      ? parsed.error
      : typeof parsed.message === "string"
        ? parsed.message
        : text;
    return typeof parsed.code === "string" ? `${message} (${parsed.code})` : message;
  } catch {
    return text;
  }
}

export interface MaterializeGitHubArchiveBaseOptions {
  repoUrl: string;
  checkoutDir: string;
  baseCommitSha: string;
  hubUrl: string;
  bridgeId: string;
  bridgeSecret: string;
  cfAccessClientId?: string | null;
  cfAccessClientSecret?: string | null;
  githubApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function materializeGitHubArchiveBase(
  options: MaterializeGitHubArchiveBaseOptions,
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const repo = canonicalGitHubRepoFromUrl(options.repoUrl);
  const hubUrl = options.hubUrl.replace(/\/+$/, "");
  const tokenHeaders: Record<string, string> = {
    Authorization: `Bearer ${options.bridgeSecret}`,
    "X-Tiller-GitHub-Bridge-Id": options.bridgeId,
  };
  if (options.cfAccessClientId?.trim() && options.cfAccessClientSecret?.trim()) {
    tokenHeaders["CF-Access-Client-Id"] = options.cfAccessClientId.trim();
    tokenHeaders["CF-Access-Client-Secret"] = options.cfAccessClientSecret.trim();
  }

  const tokenResponse = await fetchImpl(`${hubUrl}/api/github/token?repo=${encodeURIComponent(repo)}`, {
    headers: tokenHeaders,
  });
  if (!tokenResponse.ok) {
    throw new Error(`Failed to mint GitHub archive token for ${repo}: ${await readErrorBody(tokenResponse)}`);
  }
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { token?: unknown };
  const token = typeof tokenBody.token === "string" ? tokenBody.token.trim() : "";
  if (!token) {
    throw new Error(`Failed to mint GitHub archive token for ${repo}: response did not include a token`);
  }

  const apiBase = (options.githubApiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const archiveResponse = await fetchImpl(
    `${apiBase}/repos/${repo}/tarball/${encodeURIComponent(options.baseCommitSha)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "tiller-harness",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!archiveResponse.ok) {
    throw new Error(`Failed to download GitHub base archive ${options.baseCommitSha}: ${await readErrorBody(archiveResponse)}`);
  }

  const archiveBytes = maybeGunzipArchive(new Uint8Array(await archiveResponse.arrayBuffer()));
  return extractTarBuffer(archiveBytes, options.checkoutDir, {
    stripFirstComponent: true,
  });
}

export interface PreparedWorkspace {
  repoGitDir: string;
  checkoutDir: string;
}

export async function createCheckout(
  repoGitDir: string,
  checkoutDir: string,
  commit?: string | null,
): Promise<void> {
  rmSync(checkoutDir, { recursive: true, force: true });
  // A retried one-shot run may reuse its deterministic checkout path. Prune a
  // stale worktree registration before recreating that checkout.
  await execFileAsync("git", ["--git-dir", repoGitDir, "worktree", "prune"]).catch(() => undefined);
  mkdirSync(dirname(checkoutDir), { recursive: true });
  const trimmedCommit = commit?.trim();
  if (trimmedCommit) {
    await ensureCommitAvailable(repoGitDir, trimmedCommit);
  }
  const args = ["--git-dir", repoGitDir, "worktree", "add", "--detach", checkoutDir];
  if (trimmedCommit) {
    args.push(trimmedCommit);
  }
  try {
    await execFileAsync("git", args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create checkout${commit ? ` at ${commit}` : ""}: ${detail}`);
  }
}

async function ensureCommitAvailable(repoGitDir: string, commit: string): Promise<void> {
  try {
    await execFileAsync("git", ["--git-dir", repoGitDir, "cat-file", "-e", `${commit}^{commit}`]);
    return;
  } catch {
    // Fetch the exact frozen commit on demand when it is absent locally.
  }
  try {
    await execFileAsync("git", ["--git-dir", repoGitDir, "fetch", "--depth", "1", "origin", commit]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch GitHub base ${commit}: ${detail}`);
  }
}

export interface PrepareGitHubWorkspaceOptions {
  repoUrl: string;
  checkoutDir: string;
  baseCommitSha: string;
}

export async function ensureGitHubWorkspaceRepo(options: PrepareGitHubWorkspaceOptions): Promise<PreparedWorkspace> {
  const repoRoot = join(dirname(options.checkoutDir), "repo");
  const repoGitDir = join(repoRoot, "repo.git");
  const initialized = existsSync(join(repoGitDir, "HEAD"));
  if (!initialized) {
    rmSync(repoRoot, { recursive: true, force: true });
    mkdirSync(repoRoot, { recursive: true });
  }
  try {
    if (!initialized) {
      await execFileAsync("git", ["init", "--bare", "-q", repoGitDir]);
      await execFileAsync("git", ["--git-dir", repoGitDir, "remote", "add", "origin", options.repoUrl]);
    }
    await execFileAsync("git", ["--git-dir", repoGitDir, "fetch", "--depth", "1", "origin", options.baseCommitSha]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch GitHub base ${options.baseCommitSha}: ${detail}`);
  }
  return { repoGitDir, checkoutDir: options.checkoutDir };
}

export async function prepareGitHubWorkspace(options: PrepareGitHubWorkspaceOptions): Promise<PreparedWorkspace> {
  const prepared = await ensureGitHubWorkspaceRepo(options);
  const { repoGitDir } = prepared;
  await createCheckout(repoGitDir, options.checkoutDir, options.baseCommitSha);
  return prepared;
}
