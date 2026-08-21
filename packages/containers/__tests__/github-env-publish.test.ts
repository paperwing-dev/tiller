import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const PUBLISHER = path.resolve(
  import.meta.dirname,
  "..",
  "github-env-publish.mjs",
);
const SOURCE = readFileSync(PUBLISHER, "utf8");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tiller-github-publish-test-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runPublisher(
  env: Record<string, string>,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PUBLISHER], {
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("GitHub environment publisher", () => {
  it("uses the feature-aware PR title as the Git commit subject", () => {
    expect(SOURCE).toContain('"TILLER_GITHUB_COMMIT_TITLE"');
    expect(SOURCE).toContain(
      "const COMMIT_TITLE = env.TILLER_GITHUB_COMMIT_TITLE",
    );
    expect(SOURCE).toMatch(
      /function commitMessage\(\)[\s\S]*?return \[\s*COMMIT_TITLE,/,
    );
    expect(SOURCE).not.toContain("`Publish Tiller env ${ENV_SLUG}`");
  });

  it("uses the configured GitHub App bot as author and committer", () => {
    expect(SOURCE).toContain('"TILLER_GITHUB_COMMIT_AUTHOR_NAME"');
    expect(SOURCE).toContain('"TILLER_GITHUB_COMMIT_AUTHOR_EMAIL"');
    expect(SOURCE).toContain('["config", "user.name", COMMIT_AUTHOR_NAME]');
    expect(SOURCE).toContain('["config", "user.email", COMMIT_AUTHOR_EMAIL]');
    expect(SOURCE).not.toContain('"tiller@users.noreply.github.com"');
  });

  it("keeps push failures retryable unless the remote branch actually moved", () => {
    expect(SOURCE).toContain("observedRemoteHead = readRemoteHead(repoDir)");
    expect(SOURCE).toContain(
      '`GitHub branch ${BRANCH} moved from ${remoteHead ?? "(none)"} to ${observedRemoteHead ?? "(none)"}.`',
    );
    expect(SOURCE).toContain('"github_env_push_failed"');
  });

  it("replaces a stale environment branch with a snapshot directly on its recorded base", async () => {
    const root = makeTempDir();
    const source = path.join(root, "source");
    const remote = path.join(root, "remote.git");
    const draft = path.join(root, "draft");
    const tarPath = path.join(root, "draft.tar");
    mkdirSync(source);
    mkdirSync(draft);

    git(source, ["init", "-q"]);
    git(source, ["config", "user.name", "Tiller Test"]);
    git(source, ["config", "user.email", "tiller-test@example.com"]);
    writeFileSync(path.join(source, "shared.txt"), "shared base\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "shared base"]);
    git(source, ["branch", "env-history"]);

    writeFileSync(path.join(source, "main-only.txt"), "main\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "advance main"]);
    const baseCommit = git(source, ["rev-parse", "HEAD"]);

    git(source, ["checkout", "-q", "env-history"]);
    writeFileSync(path.join(source, "legacy-env.txt"), "legacy\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-q", "-m", "legacy environment publish"]);
    const priorHead = git(source, ["rev-parse", "HEAD"]);

    git(root, ["init", "-q", "--bare", remote]);
    git(source, ["remote", "add", "origin", remote]);
    git(source, [
      "push",
      "-q",
      "origin",
      `${baseCommit}:refs/heads/main`,
      `${priorHead}:refs/heads/tiller/env/demo`,
    ]);

    writeFileSync(path.join(draft, "shared.txt"), "feature change\n");
    execFileSync("tar", ["-cf", tarPath, "-C", draft, "shared.txt"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const draftTar = readFileSync(tarPath);
    let callback: Record<string, unknown> | null = null;
    const receivedHeaders: Array<
      Record<string, string | string[] | undefined>
    > = [];

    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/workspace/download") {
        receivedHeaders.push(req.headers);
        res.writeHead(200, { "Content-Type": "application/x-tar" });
        res.end(draftTar);
        return;
      }
      if (req.method === "GET" && req.url === "/workspace/deletions") {
        receivedHeaders.push(req.headers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paths: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/result") {
        receivedHeaders.push(req.headers);
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          callback = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server did not bind");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    try {
      const result = await runPublisher({
        HUB_URL: serverUrl,
        CF_ACCESS_CLIENT_ID: "service-client.access",
        CF_ACCESS_CLIENT_SECRET: "service-secret",
        TILLER_RUNTIME_CAPABILITY: "runtime-capability-must-not-be-used",
        REPO_URL: remote,
        TILLER_ENV_SLUG: "demo",
        TILLER_REPO_ID: "repo-1",
        TILLER_GITHUB_PUBLISH_OPERATION_ID: "operation-1",
        TILLER_GITHUB_BASE_COMMIT_SHA: baseCommit,
        TILLER_GITHUB_BRANCH: "tiller/env/demo",
        TILLER_GITHUB_EXPECTED_HEAD: priorHead,
        TILLER_GITHUB_WORKSPACE_HASH: "workspace-hash-1",
        TILLER_GITHUB_ADOPTION_HMAC: "adoption-hmac-1",
        TILLER_GITHUB_CALLBACK_TOKEN: "callback-token-1",
        TILLER_GITHUB_COMMIT_TITLE: "Feature change",
        TILLER_GITHUB_COMMIT_AUTHOR_NAME: "Tiller Bot",
        TILLER_GITHUB_COMMIT_AUTHOR_EMAIL: "tiller@example.com",
        TILLER_GITHUB_PUBLISH_RESULT_URL: `${serverUrl}/result`,
        TILLER_ENV_WORKSPACE_API_BASE: `${serverUrl}/workspace`,
        TILLER_ENV_ONLY_PATHS: "",
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const head = git(root, [
      "--git-dir",
      remote,
      "rev-parse",
      "refs/heads/tiller/env/demo",
    ]);
    expect(git(root, ["--git-dir", remote, "rev-parse", `${head}^`])).toBe(
      baseCommit,
    );
    expect(
      git(root, ["--git-dir", remote, "merge-base", "refs/heads/main", head]),
    ).toBe(baseCommit);
    expect(
      git(root, ["--git-dir", remote, "diff", "--name-only", baseCommit, head]),
    ).toBe("shared.txt");
    expect(callback).toMatchObject({
      status: "published",
      branchHeadSha: head,
      expectedPriorHead: priorHead,
    });
    expect(receivedHeaders).toHaveLength(3);
    for (const headers of receivedHeaders) {
      expect(headers["cf-access-client-id"]).toBe("service-client.access");
      expect(headers["cf-access-client-secret"]).toBe("service-secret");
      expect(headers["x-tiller-github-publish-operation-id"]).toBe(
        "operation-1",
      );
      expect(headers["x-tiller-github-publish-token"]).toBe("callback-token-1");
      expect(headers["x-tiller-capability"]).toBeUndefined();
    }
  }, 20_000);
});
