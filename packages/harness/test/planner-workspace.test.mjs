import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCheckout,
  materializeGitHubArchiveBase,
  prepareGitHubWorkspace,
} from "../dist/planner/workspace.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createRepo(root) {
  const srcDir = join(root, "src-repo");
  execFileSync("git", ["init", "-q", srcDir]);
  git(srcDir, "config", "user.email", "test@example.com");
  git(srcDir, "config", "user.name", "Test");
  writeFileSync(join(srcDir, "README.md"), "hello planner\n");
  git(srcDir, "add", ".");
  git(srcDir, "commit", "-q", "-m", "initial");
  const firstCommit = git(srcDir, "rev-parse", "HEAD");
  writeFileSync(join(srcDir, "README.md"), "hello again\n");
  git(srcDir, "add", ".");
  git(srcDir, "commit", "-q", "-m", "second");
  const secondCommit = git(srcDir, "rev-parse", "HEAD");
  return { srcDir, firstCommit, secondCommit };
}

function tarHeader(name, size, type = "0") {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

function createTar(files) {
  const chunks = [];
  for (const [name, text] of Object.entries(files)) {
    const content = Buffer.from(text, "utf8");
    chunks.push(tarHeader(name, content.length), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function startArchiveStub(tarBytes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      bridgeId: req.headers["x-tiller-github-bridge-id"],
      cfAccessClientId: req.headers["cf-access-client-id"],
    });
    if (req.url === "/api/github/token?repo=example%2Frepo") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "github-token" }));
      return;
    }
    if (req.url === "/repos/example/repo/tarball/abc123") {
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      res.end(tarBytes);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requests, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("prepareGitHubWorkspace fetches and checks out the pinned GitHub base commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ws-"));
  try {
    const { srcDir, firstCommit } = createRepo(root);
    const checkoutDir = join(root, "job", "checkout");
    const prepared = await prepareGitHubWorkspace({
      repoUrl: srcDir,
      checkoutDir,
      baseCommitSha: firstCommit,
    });
    assert.equal(prepared.checkoutDir, checkoutDir);
    assert.equal(readFileSync(join(checkoutDir, "README.md"), "utf-8"), "hello planner\n");
    assert.equal(git(checkoutDir, "rev-parse", "HEAD"), firstCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeGitHubArchiveBase downloads a bridge-authorized GitHub tarball", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ws-"));
  const tarBytes = createTar({
    "example-repo-abc123/README.md": "hello from archive\n",
    "example-repo-abc123/src/app.ts": "export const ok = true;\n",
  });
  const { server, requests, origin } = await startArchiveStub(tarBytes);
  try {
    const checkoutDir = join(root, "job", "checkout");
    const count = await materializeGitHubArchiveBase({
      repoUrl: "https://github.com/example/repo.git",
      checkoutDir,
      baseCommitSha: "abc123",
      hubUrl: origin,
      bridgeId: "bridge-id",
      bridgeSecret: "bridge-secret",
      cfAccessClientId: "access-id",
      cfAccessClientSecret: "access-secret",
      githubApiBaseUrl: origin,
    });

    assert.equal(count, 2);
    assert.equal(readFileSync(join(checkoutDir, "README.md"), "utf-8"), "hello from archive\n");
    assert.equal(readFileSync(join(checkoutDir, "src", "app.ts"), "utf-8"), "export const ok = true;\n");
    assert.equal(requests[0].authorization, "Bearer bridge-secret");
    assert.equal(requests[0].bridgeId, "bridge-id");
    assert.equal(requests[0].cfAccessClientId, "access-id");
    assert.equal(requests[1].authorization, "Bearer github-token");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Warm session containers call createCheckout once per turn with the same
// checkoutDir against the same bare repo. The second call must not trip over
// the previous turn's registered worktree.
test("createCheckout can be called repeatedly with the same checkout dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ws-"));
  try {
    const { srcDir, firstCommit, secondCommit } = createRepo(root);
    const repoGitDir = join(root, "repo.git");
    execFileSync("git", ["clone", "-q", "--bare", srcDir, repoGitDir]);

    const checkoutDir = join(root, "job", "checkout");
    await createCheckout(repoGitDir, checkoutDir, firstCommit);
    assert.equal(git(checkoutDir, "rev-parse", "HEAD"), firstCommit);

    await createCheckout(repoGitDir, checkoutDir, secondCommit);
    assert.equal(git(checkoutDir, "rev-parse", "HEAD"), secondCommit);
    assert.equal(readFileSync(join(checkoutDir, "README.md"), "utf-8"), "hello again\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createCheckout fetches a missing pinned commit for a retried one-shot run", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ws-"));
  try {
    const { srcDir, firstCommit, secondCommit } = createRepo(root);
    const checkoutDir = join(root, "job", "checkout");
    const prepared = await prepareGitHubWorkspace({
      repoUrl: srcDir,
      checkoutDir,
      baseCommitSha: firstCommit,
    });
    assert.equal(git(checkoutDir, "rev-parse", "HEAD"), firstCommit);

    await createCheckout(prepared.repoGitDir, checkoutDir, secondCommit);

    assert.equal(git(checkoutDir, "rev-parse", "HEAD"), secondCommit);
    assert.equal(readFileSync(join(checkoutDir, "README.md"), "utf-8"), "hello again\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareGitHubWorkspace fails cleanly when the pinned commit is missing", async () => {
  const root = mkdtempSync(join(tmpdir(), "planner-ws-"));
  try {
    const { srcDir } = createRepo(root);
    await assert.rejects(
      prepareGitHubWorkspace({
        repoUrl: srcDir,
        checkoutDir: join(root, "job", "checkout"),
        baseCommitSha: "0000000000000000000000000000000000000000",
      }),
      /Failed to fetch GitHub base/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
