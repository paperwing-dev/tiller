import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";

const HELPER = path.resolve(import.meta.dirname, "..", "git-credential-tiller.mjs");

function runHelper(input: string, env: Record<string, string> = {}) {
  return spawnSync("node", [HELPER, "get"], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      HUB_URL: "https://hub.example.com",
      TILLER_GITHUB_BRIDGE_ID: "bridge-id",
      TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
      TILLER_GITHUB_ALLOWED_REPO: "example/repo",
      ...env,
    },
  });
}

function runHelperAsync(input: string, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", [HELPER, "get"], {
      env: {
        ...process.env,
        HUB_URL: "https://hub.example.com",
        TILLER_GITHUB_BRIDGE_ID: "bridge-id",
        TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
        TILLER_GITHUB_ALLOWED_REPO: "example/repo",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function withTokenServer<T>(fn: (url: string, seen: { url: string; headers: Record<string, string | string[] | undefined> }[]) => T | Promise<T>): Promise<T> {
  const seen: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ token: "installation-token" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Token server did not bind to a TCP port.");
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("git-credential-tiller", () => {
  it("fails when Git does not provide an HTTP path", () => {
    const result = runHelper("protocol=https\nhost=github.com\n\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("useHttpPath=true");
  });

  it("fails when the requested repo does not match the bridge repo", () => {
    const result = runHelper("protocol=https\nhost=github.com\npath=other/repo.git\n\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not allowed");
  });

  it("passes when Git provides a repo path and the bridge returns a token", async () => {
    await withTokenServer(async (hubUrl, seen) => {
      const result = await runHelperAsync(
        "protocol=https\nhost=github.com\npath=example/repo.git\n\n",
        { HUB_URL: hubUrl },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("username=x-access-token");
      expect(result.stdout).toContain("password=installation-token");
      expect(seen[0]?.url).toBe("/api/github/token?repo=example%2Frepo");
      expect(seen[0]?.headers.authorization).toBe("Bearer bridge-secret");
      expect(seen[0]?.headers["x-tiller-github-bridge-id"]).toBe("bridge-id");
    });
  });

  it("retries while a fresh bridge record has not propagated", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (seen.length < 3) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "GitHub bridge was not found.",
          code: "github_bridge_not_found",
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "installation-token" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Token server did not bind to a TCP port.");
    }

    try {
      const result = await runHelperAsync(
        "protocol=https\nhost=github.com\npath=example/repo.git\n\n",
        {
          HUB_URL: `http://127.0.0.1:${address.port}`,
          TILLER_GITHUB_BRIDGE_TOKEN_RETRY_SECONDS: "5",
          TILLER_GITHUB_BRIDGE_TOKEN_RETRY_INTERVAL_MS: "1",
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("password=installation-token");
      expect(seen).toHaveLength(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
