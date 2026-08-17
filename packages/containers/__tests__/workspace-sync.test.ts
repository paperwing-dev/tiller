import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const CONTAINER_DIR = path.resolve(import.meta.dirname, "..");
const WORKSPACE_SYNC_SOURCE = path.join(CONTAINER_DIR, "workspace-sync.mjs");

const tempDirs: string[] = [];

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  json: unknown;
}

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeWorkspaceFile(workspace: string, relPath: string, content: string): void {
  const filePath = path.join(workspace, relPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function workspaceManifestEntry(workspace: string, relPath: string): { path: string; size: number; mtime: number } {
  const filePath = path.join(workspace, relPath);
  const stats = statSync(filePath);
  return {
    path: `/${relPath}`,
    size: stats.size,
    mtime: stats.mtimeMs,
  };
}

function setMtime(filePath: string, timestampMs: number): void {
  const date = new Date(timestampMs);
  utimesSync(filePath, date, date);
}

function writeLastSync(filePath: string, timestampMs: number): void {
  writeFileSync(filePath, String(timestampMs));
  setMtime(filePath, timestampMs);
}

function initGitWorkspace(workspace: string): string {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tiller Test"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tiller-test@example.com"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: workspace, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function withWorkspaceServer(
  run: (hubUrl: string, requests: RecordedRequest[]) => Promise<void>,
  respond?: (request: RecordedRequest) => MockResponse | Promise<MockResponse>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readRequestBody(req);
    let json: unknown = null;
    if (body) {
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
    }
    requests.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      body,
      json,
    });
    const response = await respond?.(requests[requests.length - 1]) ?? {
      body: req.url?.endsWith("/manifest") ? [] : {},
    };
    res.statusCode = response.status ?? 200;
    const responseBody = response.body ?? {};
    if (responseBody instanceof Uint8Array || Buffer.isBuffer(responseBody)) {
      for (const [key, value] of Object.entries(response.headers ?? {})) {
        res.setHeader(key, value);
      }
      res.end(responseBody);
      return;
    }
    if (typeof responseBody === "string") {
      res.setHeader("Content-Type", response.headers?.["Content-Type"] ?? "text/plain");
      res.end(responseBody);
      return;
    }
    res.setHeader("Content-Type", response.headers?.["Content-Type"] ?? "application/json");
    res.end(JSON.stringify(responseBody));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind to a TCP port");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function runWorkspaceSync(
  command: "down" | "up",
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKSPACE_SYNC_SOURCE, command], {
      cwd: CONTAINER_DIR,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`workspace-sync timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function runWorkspaceSyncUp(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runWorkspaceSync("up", env);
}

function runWorkspaceSyncDown(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return runWorkspaceSync("down", env);
}

function syncEnv(hubUrl: string, tempRoot: string): NodeJS.ProcessEnv {
  return {
    HUB_URL: hubUrl,
    REPO_SLUG: "demo-env",
    TILLER_WORKSPACE_SYNC_WORKSPACE: path.join(tempRoot, "workspace"),
    TILLER_WORKSPACE_SYNC_MANIFEST_CACHE: path.join(tempRoot, "manifest-cache.json"),
    TILLER_WORKSPACE_SYNC_LAST_SYNC: path.join(tempRoot, "last-sync"),
    TILLER_WORKSPACE_SYNC_CURL_TMP: path.join(tempRoot, "curl-body"),
  };
}

describe("workspace-sync up", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends delete requests when only a local file was removed", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/keep.txt", "keep\n");
    writeWorkspaceFile(workspace, "src/remove.txt", "remove\n");

    const fileTime = Date.now() - 20_000;
    const lastSyncTime = Date.now() - 10_000;
    setMtime(path.join(workspace, "src/keep.txt"), fileTime);
    setMtime(path.join(workspace, "src/remove.txt"), fileTime);
    setMtime(path.join(workspace, "src"), fileTime);
    setMtime(workspace, fileTime);

    const remoteManifest = [
      workspaceManifestEntry(workspace, "src/keep.txt"),
      workspaceManifestEntry(workspace, "src/remove.txt"),
    ];
    writeFileSync(manifestCache, JSON.stringify(remoteManifest));
    writeLastSync(lastSync, lastSyncTime);

    unlinkSync(path.join(workspace, "src/remove.txt"));

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));

        expect(result.status, result.stderr || result.stdout).toBe(0);

        const workspaceRequests = requests.filter((request) => request.url.startsWith("/api/workspace/"));
        expect(workspaceRequests).toHaveLength(2);
        expect(workspaceRequests[0]).toMatchObject({
          method: "GET",
          url: "/api/workspace/demo-env/manifest",
        });
        expect(workspaceRequests[1]).toMatchObject({
          method: "POST",
          url: "/api/workspace/demo-env/delete",
          json: { paths: ["/src/remove.txt"] },
        });
      },
      (request) => request.url === "/api/workspace/demo-env/manifest"
        ? { body: remoteManifest }
        : { body: {} },
    );
  });

  it("confirms remote convergence when visible files are unchanged", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/keep.txt", "keep\n");

    const fileTime = Date.now() - 20_000;
    const lastSyncTime = Date.now() - 10_000;
    setMtime(path.join(workspace, "src/keep.txt"), fileTime);
    setMtime(path.join(workspace, "src"), fileTime);
    setMtime(workspace, fileTime);
    writeFileSync(manifestCache, JSON.stringify([workspaceManifestEntry(workspace, "src/keep.txt")]));
    writeLastSync(lastSync, lastSyncTime);

    const remoteManifest = [workspaceManifestEntry(workspace, "src/keep.txt")];
    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain("Workspace already converged with remote storage");
        expect(requests.filter((request) => request.url.startsWith("/api/workspace/"))).toEqual([
          expect.objectContaining({ method: "GET", url: "/api/workspace/demo-env/manifest" }),
        ]);
      },
      (request) => request.url === "/api/workspace/demo-env/manifest"
        ? { body: remoteManifest }
        : { body: {} },
    );
  });

  it("writes a machine-readable result for review sync uploads", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    const resultFile = path.join(tempRoot, "review-sync-result.json");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(manifestCache, "[]");
    writeLastSync(lastSync, Date.now() - 20_000);

    writeWorkspaceFile(workspace, "src/new.txt", "new file\n");

    await withWorkspaceServer(async (hubUrl, requests) => {
      const result = await runWorkspaceSyncUp({
        ...syncEnv(hubUrl, tempRoot),
        TILLER_WORKSPACE_SYNC_OP_ID: "review-op-1",
        TILLER_WORKSPACE_SYNC_RESULT_FILE: resultFile,
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(requests.find((request) => request.url === "/api/workspace/demo-env/write")).toMatchObject({
        method: "POST",
        json: { files: [{ path: "/src/new.txt", content: "new file\n" }] },
      });
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual(expect.objectContaining({
        status: "succeeded",
        opId: "review-op-1",
        changedCount: 1,
        deletedCount: 0,
        uploadedBytes: 9,
      }));
    });
  });

  it("does not upload unchanged checkout files in GitHub base mode", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/base.txt", "base\n");
    writeWorkspaceFile(workspace, "src/other.txt", "other\n");
    const baseCommit = initGitWorkspace(workspace);

    const fileTime = Date.now() - 20_000;
    const lastSyncTime = Date.now() - 10_000;
    setMtime(path.join(workspace, "src/base.txt"), fileTime);
    setMtime(path.join(workspace, "src/other.txt"), fileTime);
    setMtime(path.join(workspace, "src"), fileTime);
    setMtime(workspace, fileTime);
    writeFileSync(
      manifestCache,
      JSON.stringify([
        workspaceManifestEntry(workspace, "src/base.txt"),
        workspaceManifestEntry(workspace, "src/other.txt"),
      ]),
    );
    writeLastSync(lastSync, lastSyncTime);

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: baseCommit,
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).not.toContain("Fast path: no visible filesystem mutations since last sync");
        expect(result.stdout).toContain("No git changes to sync up");

        expect(requests.filter((request) => request.url === "/api/workspace/demo-env/write")).toHaveLength(0);
        expect(requests.filter((request) => request.url === "/api/workspace/demo-env/delete")).toHaveLength(0);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: [] } };
        }
        return { body: {} };
      },
    );
  });

  it("marks a GitHub base workspace safe before reading git changes", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const fakeBin = path.join(tempRoot, "bin");
    const gitArgsFile = path.join(tempRoot, "git-args.txt");
    const gitSafeMarker = path.join(tempRoot, "git-safe");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      path.join(fakeBin, "git"),
      `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "${gitArgsFile}"
if [ "$1" = "config" ] && [ "$2" = "--global" ] && [ "$3" = "--get-all" ]; then
  if [ -f "${gitSafeMarker}" ]; then
    printf '%s\\n' "${workspace}"
    exit 0
  fi
  exit 1
fi
if [ "$1" = "config" ] && [ "$2" = "--global" ] && [ "$3" = "--add" ] && [ "$4" = "safe.directory" ]; then
  touch "${gitSafeMarker}"
  exit 0
fi
if [ "$1" = "-C" ]; then
  if [ ! -f "${gitSafeMarker}" ]; then
    exit 128
  fi
  exit 0
fi
exit 0
`,
      { mode: 0o755 },
    );

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncUp({
          ...syncEnv(hubUrl, tempRoot),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TILLER_GITHUB_BASE_COMMIT_SHA: "abc123",
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        const gitArgs = readFileSync(gitArgsFile, "utf8").trim().split("\n");
        const safeIndex = gitArgs.indexOf(`config --global --add safe.directory ${workspace}`);
        const diffIndex = gitArgs.findIndex((line) => line.startsWith("diff "));
        expect(safeIndex).toBeGreaterThanOrEqual(0);
        expect(diffIndex).toBeGreaterThanOrEqual(0);
        expect(safeIndex).toBeLessThan(diffIndex);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: [] } };
        }
        return { body: {} };
      },
    );
  });

  it("caches the full checkout for GitHub base mode when the sparse remote draft is empty", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/base.txt", "base\n");
    writeWorkspaceFile(workspace, "src/other.txt", "other\n");

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncDown({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: "abc123",
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(readFileSync(manifestCache, "utf8"))).toEqual([
          expect.objectContaining({ path: "/src/base.txt", size: 5 }),
          expect.objectContaining({ path: "/src/other.txt", size: 6 }),
        ]);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        return { body: {} };
      },
    );
  });

  it("hydrates a durable startup plan over a GitHub base checkout", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeWorkspaceFile(workspace, "src/base.txt", "base\n");
    const planDocument = "# Implement the approved plan\n";
    const remoteManifest = [{
      path: "/.tiller/plan.md",
      size: Buffer.byteLength(planDocument),
      mtime: Date.now(),
    }];

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncDown({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: "abc123",
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(readFileSync(path.join(workspace, ".tiller/plan.md"), "utf8"))
          .toBe(planDocument);
        expect(readFileSync(path.join(workspace, "src/base.txt"), "utf8")).toBe("base\n");
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/files"))
          .toMatchObject({
            method: "POST",
            json: { paths: ["/.tiller/plan.md"] },
          });
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: remoteManifest };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: [] } };
        }
        if (request.url === "/api/workspace/demo-env/files") {
          return {
            body: {
              files: [{ path: "/.tiller/plan.md", content: planDocument }],
            },
          };
        }
        return { body: {} };
      },
    );
  });

  it("applies GitHub draft deletions while syncing down", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/keep.txt", "keep\n");
    writeWorkspaceFile(workspace, "src/remove.txt", "remove\n");

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncDown({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: "abc123",
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(existsSync(path.join(workspace, "src/keep.txt"))).toBe(true);
        expect(existsSync(path.join(workspace, "src/remove.txt"))).toBe(false);
        expect(JSON.parse(readFileSync(manifestCache, "utf8"))).toEqual([
          expect.objectContaining({ path: "/src/keep.txt", size: 5 }),
        ]);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: ["/src/remove.txt"] } };
        }
        return { body: {} };
      },
    );
  });

  it("tracks GitHub base mode deletes without uploading unchanged checkout files", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/keep.txt", "keep\n");
    writeWorkspaceFile(workspace, "src/remove.txt", "remove\n");
    const baseCommit = initGitWorkspace(workspace);

    const fileTime = Date.now() - 20_000;
    const lastSyncTime = Date.now() - 10_000;
    setMtime(path.join(workspace, "src/keep.txt"), fileTime);
    setMtime(path.join(workspace, "src/remove.txt"), fileTime);
    setMtime(path.join(workspace, "src"), fileTime);
    setMtime(workspace, fileTime);
    writeFileSync(
      manifestCache,
      JSON.stringify([
        workspaceManifestEntry(workspace, "src/keep.txt"),
        workspaceManifestEntry(workspace, "src/remove.txt"),
      ]),
    );
    writeLastSync(lastSync, lastSyncTime);
    unlinkSync(path.join(workspace, "src/remove.txt"));

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: baseCommit,
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(requests.filter((request) => request.url === "/api/workspace/demo-env/write")).toHaveLength(0);
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/delete")).toMatchObject({
          method: "POST",
          json: { paths: ["/src/remove.txt"] },
        });
        expect(requests.find((request) => request.method === "PUT" && request.url === "/api/workspace/demo-env/deletions")).toMatchObject({
          json: { paths: ["/src/remove.txt"] },
        });
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: [] } };
        }
        return { body: {} };
      },
    );
  });

  it("does not fail GitHub sync after upload when shared state files are read-only", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });

    writeWorkspaceFile(workspace, "src/base.txt", "base\n");
    const baseCommit = initGitWorkspace(workspace);
    writeWorkspaceFile(workspace, "src/new.txt", "new file\n");
    writeFileSync(manifestCache, "[]");
    writeFileSync(lastSync, String(Date.now() - 10_000));
    chmodSync(manifestCache, 0o400);
    chmodSync(lastSync, 0o400);

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: baseCommit,
        });

        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/write")).toMatchObject({
          method: "POST",
          json: { files: [{ path: "/src/new.txt", content: "new file\n" }] },
        });
        expect(statSync(manifestCache).mode & 0o222).not.toBe(0);
        expect(statSync(lastSync).mode & 0o222).not.toBe(0);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [] };
        }
        if (request.url === "/api/workspace/demo-env/deletions") {
          return { body: { paths: [] } };
        }
        return { body: {} };
      },
    );
  });

  it("does not advance sync bookkeeping after a failed routine write", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(manifestCache, "[]");
    writeLastSync(lastSync, Date.now() - 20_000);
    const markerBefore = readFileSync(lastSync, "utf8");
    const markerMtimeBefore = statSync(lastSync).mtimeMs;
    writeWorkspaceFile(workspace, "src/new.txt", "not saved\n");

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
        expect(result.status).toBe(1);
        expect(readFileSync(manifestCache, "utf8")).toBe("[]");
        expect(readFileSync(lastSync, "utf8")).toBe(markerBefore);
        expect(statSync(lastSync).mtimeMs).toBe(markerMtimeBefore);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") return { body: [] };
        return request.url === "/api/workspace/demo-env/write"
          ? { status: 503, body: "temporary failure" }
          : { body: {} };
      },
    );
  });

  it("does not advance sync bookkeeping after a failed routine deletion", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    const manifestCache = path.join(tempRoot, "manifest-cache.json");
    const lastSync = path.join(tempRoot, "last-sync");
    mkdirSync(workspace, { recursive: true });
    writeWorkspaceFile(workspace, "src/remove.txt", "remove\n");
    const cached = JSON.stringify([workspaceManifestEntry(workspace, "src/remove.txt")]);
    writeFileSync(manifestCache, cached);
    writeLastSync(lastSync, Date.now() - 20_000);
    const markerBefore = readFileSync(lastSync, "utf8");
    unlinkSync(path.join(workspace, "src/remove.txt"));

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
        expect(result.status).toBe(1);
        expect(readFileSync(manifestCache, "utf8")).toBe(cached);
        expect(readFileSync(lastSync, "utf8")).toBe(markerBefore);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: JSON.parse(cached) };
        }
        return request.url === "/api/workspace/demo-env/delete"
          ? { status: 503, body: "temporary failure" }
          : { body: {} };
      },
    );
  });

  it("reruns the save when a file changes during upload", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(tempRoot, "manifest-cache.json"), "[]");
    writeLastSync(path.join(tempRoot, "last-sync"), Date.now() - 20_000);
    writeWorkspaceFile(workspace, "src/live.txt", "first\n");
    let writes = 0;

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stdout).toContain("Workspace changed during save; rerunning convergence pass 2");
        const writeRequests = requests.filter((request) => request.url === "/api/workspace/demo-env/write");
        expect(writeRequests).toHaveLength(2);
        expect(writeRequests[0]?.json).toEqual({ files: [{ path: "/src/live.txt", content: "first\n" }] });
        expect(writeRequests[1]?.json).toEqual({ files: [{ path: "/src/live.txt", content: "second\n" }] });
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") return { body: [] };
        if (request.url === "/api/workspace/demo-env/write" && writes++ === 0) {
          writeWorkspaceFile(workspace, "src/live.txt", "second\n");
        }
        return { body: {} };
      },
    );
  });

  it("removes a partially uploaded remote-only file on the next save", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(tempRoot, "manifest-cache.json"), "[]");
    writeLastSync(path.join(tempRoot, "last-sync"), Date.now() - 20_000);
    writeWorkspaceFile(workspace, "src/transient.txt", "partial\n");
    let failFirstWrite = true;
    const remoteFiles = new Map<string, string>();

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const first = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
        expect(first.status).toBe(1);
        expect(remoteFiles.get("/src/transient.txt")).toBe("partial\n");
        unlinkSync(path.join(workspace, "src/transient.txt"));

        const second = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
        expect(second.status, second.stderr || second.stdout).toBe(0);
        expect(remoteFiles.has("/src/transient.txt")).toBe(false);
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/delete")?.json)
          .toEqual({ paths: ["/src/transient.txt"] });
        expect(JSON.parse(readFileSync(path.join(tempRoot, "manifest-cache.json"), "utf8"))).toEqual([]);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return {
            body: Array.from(remoteFiles, ([path, content]) => ({
              path,
              size: Buffer.byteLength(content),
              mtime: Date.now(),
            })),
          };
        }
        if (request.url === "/api/workspace/demo-env/write") {
          for (const file of (request.json as { files: Array<{ path: string; content: string }> }).files) {
            remoteFiles.set(file.path, file.content);
          }
          if (failFirstWrite) {
            failFirstWrite = false;
            return { status: 503, body: "response lost after partial commit" };
          }
        }
        if (request.url === "/api/workspace/demo-env/delete") {
          for (const path of (request.json as { paths: string[] }).paths) remoteFiles.delete(path);
        }
        return { body: {} };
      },
    );
  });

  it("includes committed, staged, unstaged, untracked, and deleted changes from the immutable GitHub base", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeWorkspaceFile(workspace, "src/committed.txt", "base\n");
    writeWorkspaceFile(workspace, "src/staged.txt", "base\n");
    writeWorkspaceFile(workspace, "src/unstaged.txt", "base\n");
    writeWorkspaceFile(workspace, "src/deleted.txt", "base\n");
    const baseCommit = initGitWorkspace(workspace);
    writeWorkspaceFile(workspace, "src/committed.txt", "local commit\n");
    execFileSync("git", ["add", "src/committed.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "local change"], { cwd: workspace, stdio: "ignore" });
    writeWorkspaceFile(workspace, "src/staged.txt", "staged\n");
    execFileSync("git", ["add", "src/staged.txt"], { cwd: workspace, stdio: "ignore" });
    writeWorkspaceFile(workspace, "src/unstaged.txt", "unstaged\n");
    writeWorkspaceFile(workspace, "src/untracked.txt", "untracked\n");
    unlinkSync(path.join(workspace, "src/deleted.txt"));

    await withWorkspaceServer(
      async (hubUrl, requests) => {
        const result = await runWorkspaceSyncUp({
          ...syncEnv(hubUrl, tempRoot),
          TILLER_GITHUB_BASE_COMMIT_SHA: baseCommit,
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/write")?.json).toEqual({
          files: [
            { path: "/src/committed.txt", content: "local commit\n" },
            { path: "/src/staged.txt", content: "staged\n" },
            { path: "/src/unstaged.txt", content: "unstaged\n" },
            { path: "/src/untracked.txt", content: "untracked\n" },
          ],
        });
        expect(requests.find((request) => request.url === "/api/workspace/demo-env/delete")?.json)
          .toEqual({ paths: ["/src/deleted.txt"] });
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") return { body: [] };
        if (request.url === "/api/workspace/demo-env/deletions") return { body: { paths: [] } };
        return { body: {} };
      },
    );
  });

  it("uploads large change sets in bounded batches", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(tempRoot, "manifest-cache.json"), "[]");
    writeLastSync(path.join(tempRoot, "last-sync"), Date.now() - 20_000);
    for (let index = 0; index < 55; index += 1) {
      writeWorkspaceFile(workspace, `src/file-${String(index).padStart(2, "0")}.txt`, `${index}\n`);
    }

    await withWorkspaceServer(async (hubUrl, requests) => {
      const result = await runWorkspaceSyncUp(syncEnv(hubUrl, tempRoot));
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const writes = requests.filter((request) => request.url === "/api/workspace/demo-env/write");
      expect(writes.map((request) => (request.json as { files: unknown[] }).files.length))
        .toEqual([50, 5]);
    });
  });

  it("fails startup hydration when a requested batch is incomplete", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    const workspace = path.join(tempRoot, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeWorkspaceFile(workspace, "existing.txt", "existing\n");

    await withWorkspaceServer(
      async (hubUrl) => {
        const result = await runWorkspaceSyncDown(syncEnv(hubUrl, tempRoot));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Workspace hydration batch omitted 1 requested file");
        expect(existsSync(path.join(tempRoot, "manifest-cache.json"))).toBe(false);
        expect(existsSync(path.join(tempRoot, "last-sync"))).toBe(false);
      },
      (request) => {
        if (request.url === "/api/workspace/demo-env/manifest") {
          return { body: [{ path: "/remote.txt", size: 7, mtime: Date.now() }] };
        }
        if (request.url === "/api/workspace/demo-env/files") return { body: { files: [] } };
        return { body: {} };
      },
    );
  });

  it("honors one absolute deadline across startup hydration requests", async () => {
    const tempRoot = makeTempDir("tiller-workspace-sync-test-");
    mkdirSync(path.join(tempRoot, "workspace"), { recursive: true });

    await withWorkspaceServer(async (hubUrl) => {
      const result = await runWorkspaceSyncDown({
        ...syncEnv(hubUrl, tempRoot),
        TILLER_STARTUP_DEADLINE_AT_MS: String(Date.now() - 1),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Workspace hydration exceeded the startup deadline");
    });
  });
});
