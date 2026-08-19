#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReleaseDescriptor } from "../packages/hub/scripts/generate-release-descriptor.mjs";
import { parseReleaseDescriptor } from "../packages/installer/src/release-contract.ts";
import {
  RELEASE_WORKSPACE_KEYS,
  RELEASE_WORKSPACES,
  inferReleaseBump,
  normalizeReleaseBump,
  resolveReleasePlan,
} from "./release-plan.mjs";
import {
  canonicalReleaseBundleUrl,
  releaseBundleName,
  verifyPublishedRelease,
} from "./verify-release-artifacts.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseRoot = path.join(
  process.env.RUNNER_TEMP?.trim() || tmpdir(),
  "tiller-release",
);
const publicDirectory = path.join(releaseRoot, "public");
const artifactsDirectory = path.join(releaseRoot, "artifacts");
const publicRepository = "paperwing-dev/tiller";
const stableRef = "refs/heads/tiller-release/stable";
const installerVerificationUrl =
  "https://paperwing-tiller-installer.personal-infrastructure.workers.dev/stable";
const descriptorAssetName = "release-descriptor.json";
const releaseCandidateImageTag = "release-candidate";
const releaseCandidateNpmTag = "release-candidate";
const sandboxRepository = "docker.io/jamieatlason/tiller-sandbox";
const sandboxBaseRepository = "docker.io/jamieatlason/tiller-sandbox-base";
const scmRepository = "docker.io/jamieatlason/tiller-scm";
const gitleaksImage =
  "docker.io/zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854";
const sha40 = /^[0-9a-f]{40}$/;

export const PUBLIC_EXPORT_ROOTS = Object.freeze([
  ".github",
  ".gitignore",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "configs",
  "lerna.json",
  "package-lock.json",
  "package.json",
  "packages",
  "public",
  "scripts",
]);
const privateRepositorySlug =
  /(?<!@)\b(?:jamieatlason\/tiller|paperwing-dev\/tiller-private-source-network)(?:\.git)?(?=$|[\s"'`/])/;
const sandboxBaseBuildInputs = new Set([
  ".github/workflows/container-image.yml",
  "packages/containers/Dockerfile.base",
  "packages/containers/verify-codex-reviewer-contract.sh",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function publicGitEnvironment() {
  const token = process.env.TILLER_PUBLIC_PUSH_TOKEN?.trim();
  assert(token, "Public repository push token is missing.");
  return { ...process.env, GH_TOKEN: token };
}

export function parseReleaseBump(args = []) {
  if (args.length === 0) return "patch";
  assert(
    args.length === 2 && args[0] === "--bump",
    "Usage: node scripts/release.mjs [--bump patch|minor]",
  );
  return normalizeReleaseBump(args[1]);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", options.stderr ?? "inherit"],
    });
    let value = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      value += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(value.trim());
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
          ),
        );
      }
    });
  });
}

async function result(command, args, options = {}) {
  try {
    return {
      ok: true,
      output: await output(command, args, { ...options, stderr: "ignore" }),
    };
  } catch (error) {
    return { ok: false, output: "", error };
  }
}

async function remoteRefSha(cwd, remote, ref, options = {}) {
  const value = await output("git", ["ls-remote", "--refs", remote, ref], {
    cwd,
    env: options.env,
  });
  const sha = value.split(/\s+/)[0] ?? "";
  return sha40.test(sha) ? sha : null;
}

async function publishedNpmMetadata(packageName, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    { headers: { Accept: "application/json", "Cache-Control": "no-cache" } },
  );
  if (response.status === 404) return null;
  assert(
    response.ok,
    `npm lookup for ${packageName}@${version} returned HTTP ${response.status}.`,
  );
  const metadata = await response.json();
  assert(
    metadata?.version === version,
    `npm returned unexpected metadata for ${packageName}@${version}.`,
  );
  return metadata;
}

export function githubRepositoryFromRemoteUrl(value) {
  const remote = String(value ?? "").trim();
  if (!remote) return null;

  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (scpMatch) return scpMatch[1].toLowerCase();

  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const repository = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function githubResourceExists(url, label, fetchImpl, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tiller-release",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) return false;
  assert(response.ok, `${label} lookup returned HTTP ${response.status}.`);
  return true;
}

export async function lookupGitHubReleaseCoordinate({
  repository,
  tag,
  fetchImpl = fetch,
  token = process.env.GH_TOKEN,
}) {
  const baseUrl = `https://api.github.com/repos/${repository}`;
  const encodedTag = encodeURIComponent(tag);
  const [release, tagRef] = await Promise.all([
    githubResourceExists(
      `${baseUrl}/releases/tags/${encodedTag}`,
      `GitHub release ${tag}`,
      fetchImpl,
      token,
    ),
    githubResourceExists(
      `${baseUrl}/git/ref/tags/${encodedTag}`,
      `Git tag ${tag}`,
      fetchImpl,
      token,
    ),
  ]);
  return { release, tag: tagRef };
}

function readJson(filePath) {
  return readFile(filePath, "utf8").then((value) => JSON.parse(value));
}

async function readWorkspaceVersions(cwd) {
  return Object.fromEntries(
    await Promise.all(
      RELEASE_WORKSPACE_KEYS.map(async (workspace) => {
        const pkg = await readJson(
          path.join(
            cwd,
            RELEASE_WORKSPACES[workspace].workspace,
            "package.json",
          ),
        );
        return [workspace, String(pkg.version ?? "").trim()];
      }),
    ),
  );
}

async function readWorkspaceVersionsAtRef(cwd, ref) {
  return Object.fromEntries(
    await Promise.all(
      RELEASE_WORKSPACE_KEYS.map(async (workspace) => {
        const pathname = `${RELEASE_WORKSPACES[workspace].workspace}/package.json`;
        const pkg = JSON.parse(
          await output("git", ["show", `${ref}:${pathname}`], { cwd }),
        );
        return [workspace, String(pkg.version ?? "").trim()];
      }),
    ),
  );
}

function sameVersions(left, right) {
  return RELEASE_WORKSPACE_KEYS.every(
    (workspace) => left?.[workspace] === right?.[workspace],
  );
}

export function parsePendingReleaseLog(value) {
  const candidates = String(value ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      const commit = separator === -1 ? "" : line.slice(0, separator);
      const subject = separator === -1 ? line : line.slice(separator + 1);
      const match = /^chore\(release\): monorepo v(\d+\.\d+\.\d+)$/.exec(
        subject,
      );
      return match && sha40.test(commit)
        ? { commit, releaseVersion: match[1] }
        : null;
    })
    .filter(Boolean);
  assert(
    candidates.length <= 1,
    "Multiple unfinished release commits exist after tiller-release/stable.",
  );
  return candidates[0] ?? null;
}

async function pendingReleaseAtHead(head, stable) {
  if (head === stable) return null;
  const log = await output(
    "git",
    stable
      ? ["log", "--first-parent", "--format=%H%x09%s", `${stable}..${head}`]
      : ["show", "-s", "--format=%H%x09%s", head],
  );
  const candidate = parsePendingReleaseLog(log);
  if (!candidate) return null;
  const parents = (
    await output("git", ["show", "-s", "--format=%P", candidate.commit])
  )
    .split(/\s+/)
    .filter(Boolean);
  assert(parents.length === 1, "Pending release commit must have one parent.");
  const changed = (
    await output("git", [
      "diff",
      "--name-only",
      `${parents[0]}..${candidate.commit}`,
    ])
  )
    .split("\n")
    .filter(Boolean);
  const allowed = new Set([
    "package-lock.json",
    "packages/hub/package-lock.json",
    ...RELEASE_WORKSPACE_KEYS.map(
      (workspace) => `${RELEASE_WORKSPACES[workspace].workspace}/package.json`,
    ),
  ]);
  assert(
    changed.every((pathname) => allowed.has(pathname)),
    "Pending release commit contains changes outside release version files.",
  );
  return {
    privateBase: parents[0],
    privateRelease: candidate.commit,
    releaseVersion: candidate.releaseVersion,
  };
}

async function writeWorkspaceVersions(targetVersions) {
  await Promise.all(
    RELEASE_WORKSPACE_KEYS.map(async (workspace) => {
      const filePath = path.join(
        repoRoot,
        RELEASE_WORKSPACES[workspace].workspace,
        "package.json",
      );
      const pkg = await readJson(filePath);
      pkg.version = targetVersions[workspace];
      await writeFile(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }),
  );
  const lockArgs = [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  await run("npm", lockArgs, { cwd: repoRoot });
  await run("npm", [...lockArgs, "--workspaces=false"], {
    cwd: path.join(repoRoot, "packages", "hub"),
  });
}

async function trackedFiles(cwd, ref = "HEAD") {
  return (await output("git", ["ls-tree", "-r", "--name-only", ref], { cwd }))
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function listFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(entry.name)) continue;
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile()) files.push(filePath);
    }
  }
  await visit(directory);
  return files;
}

export function isApprovedPublicPath(pathname) {
  const normalized = String(pathname ?? "").replace(/^\.\//, "");
  if (!normalized || normalized.includes("\0")) return false;
  const segments = normalized.split("/");
  if (segments.includes("..")) return false;
  return PUBLIC_EXPORT_ROOTS.includes(segments[0]);
}

export function publicSnapshotCommitArgs({
  desiredTree,
  publicBase,
  resetPublicHistory = false,
}) {
  const args = ["commit-tree", desiredTree];
  if (!resetPublicHistory) args.push("-p", publicBase);
  args.push("-m", "chore(release): publish generated snapshot");
  return args;
}

export function containsPrivateRepositorySlug(value) {
  return privateRepositorySlug.test(String(value ?? ""));
}

export async function scanExportedSnapshot({ directory, forbiddenShas = [] }) {
  const findings = [];
  const sensitiveName =
    /(^|\/)(?:\.env(?:\.|$)|id_(?:rsa|ed25519)$)|\.(?:pem|p12|pfx)$/i;
  for (const filePath of await listFiles(directory)) {
    const relative = path
      .relative(directory, filePath)
      .split(path.sep)
      .join("/");
    if (sensitiveName.test(relative)) {
      findings.push(`${relative}: sensitive filename`);
    }
    const metadata = await stat(filePath);
    if (metadata.size > 2 * 1024 * 1024) continue;
    const bytes = await readFile(filePath);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const sha of forbiddenShas.filter(Boolean)) {
      if (text.includes(sha)) findings.push(`${relative}: private commit SHA`);
    }
    if (containsPrivateRepositorySlug(text)) {
      findings.push(`${relative}: private repository slug`);
    }
  }
  assert(
    findings.length === 0,
    `Public snapshot safety scan failed:\n${findings.map((entry) => `- ${entry}`).join("\n")}`,
  );
  await run("docker", [
    "run",
    "--rm",
    "--mount",
    `type=bind,src=${path.resolve(directory)},dst=/scan,readonly`,
    gitleaksImage,
    "dir",
    "--no-banner",
    "--redact",
    "--exit-code",
    "1",
    "/scan",
  ]);
}

export async function assertNoForbiddenText({ directory, forbidden = [] }) {
  const values = forbidden.filter(Boolean).map((value) => Buffer.from(value));
  if (values.length === 0) return;
  const findings = [];
  for (const filePath of await listFiles(directory)) {
    const bytes = await readFile(filePath);
    if (values.some((value) => bytes.includes(value))) {
      findings.push(
        path.relative(directory, filePath).split(path.sep).join("/"),
      );
    }
  }
  assert(
    findings.length === 0,
    `Release output contains private commit identifiers: ${findings.join(", ")}.`,
  );
}

async function requireCleanPrivateMain() {
  const originRepository = githubRepositoryFromRemoteUrl(
    await output("git", ["remote", "get-url", "origin"]),
  );
  assert(originRepository, "origin must be a GitHub repository.");
  assert(
    originRepository !== publicRepository.toLowerCase() &&
      process.env.GITHUB_REPOSITORY?.toLowerCase() !==
        publicRepository.toLowerCase(),
    `${publicRepository} is a generated mirror and cannot run releases.`,
  );
  const dirty = await output("git", [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  assert(!dirty, "Release requires a clean private worktree.");
  const branch = await output("git", ["branch", "--show-current"]);
  assert(branch === "main", "Release must run from private main.");
  await run("git", [
    "fetch",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  const [head, remoteMain] = await Promise.all([
    output("git", ["rev-parse", "HEAD"]),
    output("git", ["rev-parse", "refs/remotes/origin/main"]),
  ]);
  assert(head === remoteMain, "Private main must exactly match origin/main.");
  return head;
}

async function fetchStableBase() {
  const stable = await remoteRefSha(repoRoot, "origin", stableRef);
  if (!stable) return null;
  await run("git", [
    "fetch",
    "origin",
    `+${stableRef}:refs/remotes/origin/tiller-release/stable`,
  ]);
  const ancestor = await result("git", [
    "merge-base",
    "--is-ancestor",
    stable,
    "HEAD",
  ]);
  assert(ancestor.ok, "tiller-release/stable is not an ancestor of main.");
  return stable;
}

async function changedFilesSinceStable(stable, head) {
  if (!stable) return trackedFiles(repoRoot, head);
  return (await output("git", ["diff", "--name-only", `${stable}..${head}`]))
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function npmReleaseWorkspaces(plan) {
  return plan.publishCli ? ["harness", "tiller"] : ["harness"];
}

async function assertTargetsAvailable(plan, { allowExisting = false } = {}) {
  const hubTag = `tiller-hub-v${plan.targetVersions.hub}`;
  const existing = await lookupGitHubReleaseCoordinate({
    repository: publicRepository,
    tag: hubTag,
  });
  if (!allowExisting) {
    assert(!existing.release, `GitHub release ${hubTag} already exists.`);
    assert(!existing.tag, `Git tag ${hubTag} already exists.`);
  }
  for (const workspace of npmReleaseWorkspaces(plan)) {
    const { packageName } = RELEASE_WORKSPACES[workspace];
    const version = plan.targetVersions[workspace];
    if (!allowExisting) {
      assert(
        !(await publishedNpmMetadata(packageName, version)),
        `${packageName}@${version} already exists on npm.`,
      );
    }
  }
}

async function readInstallerStable(url = installerVerificationUrl) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": "tiller-release-verifier",
    },
  });
  const body = await response.text();
  const ray = response.headers.get("cf-ray")?.trim();
  assert(
    response.ok,
    `Installer release verification returned HTTP ${response.status}${ray ? ` (cf-ray ${ray})` : ""}: ${body
      .replace(/\s+/g, " ")
      .slice(0, 200)}`,
  );
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("Installer release verification did not return JSON.");
  }
  assert(
    sha40.test(String(value?.releaseId ?? "")) &&
      /^\d+\.\d+\.\d+$/.test(String(value?.version ?? "")),
    "Installer release verification returned invalid release coordinates.",
  );
  return value;
}

async function assertCanPushPublicRepository() {
  const probeDirectory = path.join(releaseRoot, "public-push-probe");
  await rm(probeDirectory, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });
  try {
    await run("git", [
      "clone",
      "--depth=1",
      "--branch",
      "main",
      "--single-branch",
      "--no-tags",
      `https://github.com/${publicRepository}.git`,
      probeDirectory,
    ]);
    await run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "--dry-run",
        "origin",
        "HEAD:refs/heads/main",
      ],
      { cwd: probeDirectory, env: publicGitEnvironment() },
    );
  } finally {
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

async function preflightReleaseAccess() {
  await readInstallerStable();
  await assertCanPushPublicRepository();
  await run("gh", [
    "workflow",
    "view",
    "container-image.yml",
    "--repo",
    publicRepository,
  ]);
  await run("git", ["push", "--dry-run", "origin", "HEAD:refs/heads/main"]);
  await run("npm", ["whoami", "--registry=https://registry.npmjs.org"]);
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!accountId) {
    const checkpoint = await readJson(
      path.join(repoRoot, ".tiller-dev-bootstrap.json"),
    );
    accountId = String(checkpoint?.accountId ?? "").trim();
  }
  assert(
    /^[0-9a-f]{32}$/.test(accountId),
    "Cloudflare account ID is missing from the environment and maintainer checkpoint.",
  );
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  const installerDirectory = path.join(repoRoot, "packages", "installer");
  await run("npx", ["wrangler", "whoami", "--account", accountId], {
    cwd: installerDirectory,
  });
  parseInstallerDeploymentTraffic(
    JSON.parse(
      await output("npx", ["wrangler", "deployments", "status", "--json"], {
        cwd: installerDirectory,
      }),
    ),
  );
}

async function commitPrivateRelease(plan) {
  await writeWorkspaceVersions(plan.targetVersions);
  await run("git", [
    "config",
    "user.name",
    process.env.GIT_AUTHOR_NAME || "github-actions[bot]",
  ]);
  await run("git", [
    "config",
    "user.email",
    process.env.GIT_AUTHOR_EMAIL ||
      "github-actions[bot]@users.noreply.github.com",
  ]);
  await run("git", [
    "add",
    "--",
    "package-lock.json",
    "packages/hub/package-lock.json",
    ...RELEASE_WORKSPACE_KEYS.map(
      (workspace) => `${RELEASE_WORKSPACES[workspace].workspace}/package.json`,
    ),
  ]);
  const staged = await result("git", ["diff", "--cached", "--quiet"]);
  assert(!staged.ok, "Release version update produced no staged changes.");
  await run("git", [
    "commit",
    "-m",
    `chore(release): monorepo v${plan.releaseVersion}`,
  ]);
  return output("git", ["rev-parse", "HEAD"]);
}

async function exportPublicSnapshot({
  privateBase,
  privateRelease,
  resetPublicHistory = false,
}) {
  await run("git", [
    "clone",
    "--depth=1",
    "--branch",
    "main",
    "--single-branch",
    "--no-tags",
    `https://github.com/${publicRepository}.git`,
    publicDirectory,
  ]);
  const publicBase = await output("git", ["rev-parse", "HEAD"], {
    cwd: publicDirectory,
  });
  const approved = (await trackedFiles(repoRoot, privateRelease)).filter(
    isApprovedPublicPath,
  );
  assert(approved.length > 0, "Public export is empty.");
  const archivePath = path.join(releaseRoot, "public-snapshot.tar");
  await run("git", [
    "archive",
    "--format=tar",
    `--output=${archivePath}`,
    privateRelease,
    "--",
    ...approved,
  ]);
  await run("git", ["rm", "-r", "--ignore-unmatch", "."], {
    cwd: publicDirectory,
  });
  await run("git", ["clean", "-fdx"], { cwd: publicDirectory });
  await run("tar", ["-xf", archivePath, "-C", publicDirectory]);
  await scanExportedSnapshot({
    directory: publicDirectory,
    forbiddenShas: [privateBase, privateRelease],
  });
  await run("git", ["add", "-A"], { cwd: publicDirectory });
  await run(
    "git",
    [
      "config",
      "user.name",
      process.env.GIT_AUTHOR_NAME || "tiller-release[bot]",
    ],
    { cwd: publicDirectory },
  );
  await run(
    "git",
    [
      "config",
      "user.email",
      process.env.GIT_AUTHOR_EMAIL ||
        "tiller-release[bot]@users.noreply.github.com",
    ],
    { cwd: publicDirectory },
  );
  const desiredTree = await output("git", ["write-tree"], {
    cwd: publicDirectory,
  });
  const currentTree = await output(
    "git",
    ["rev-parse", `${publicBase}^{tree}`],
    {
      cwd: publicDirectory,
    },
  );
  const currentMatchesSnapshot = desiredTree === currentTree;
  const commitArgs = publicSnapshotCommitArgs({
    desiredTree,
    publicBase,
    resetPublicHistory,
  });
  const releaseId = currentMatchesSnapshot
    ? publicBase
    : await output("git", commitArgs, { cwd: publicDirectory });
  if (releaseId !== publicBase) {
    await run("git", ["update-ref", "refs/heads/main", releaseId, publicBase], {
      cwd: publicDirectory,
    });
  }
  const commitLine = await output(
    "git",
    ["rev-list", "--parents", "-n", "1", releaseId],
    {
      cwd: publicDirectory,
    },
  );
  if (releaseId !== publicBase) {
    const [, ...parents] = commitLine.split(/\s+/);
    const expectedParents = resetPublicHistory ? [] : [publicBase];
    assert(
      parents.length === expectedParents.length &&
        parents.every((parent, index) => parent === expectedParents[index]),
      resetPublicHistory
        ? "Reset public snapshot must be a root commit."
        : "Public snapshot must descend from the previous public release.",
    );
  }
  const commitBody = await output("git", ["cat-file", "commit", releaseId], {
    cwd: publicDirectory,
  });
  assert(
    !commitBody.includes(privateBase) && !commitBody.includes(privateRelease),
    "Public snapshot commit leaks private history.",
  );
  return { releaseId, publicBase };
}

async function buildAndTestPublicTree() {
  await run("npm", ["ci"], { cwd: publicDirectory });
  await run("npm", ["run", "build"], { cwd: publicDirectory });
  await run("npm", ["run", "test"], { cwd: publicDirectory });
}

async function pushReleaseCommits({
  privateBase,
  privateRelease,
  expectedPrivateMain,
  publicBase,
  publicRelease,
}) {
  const currentPrivate = await remoteRefSha(
    repoRoot,
    "origin",
    "refs/heads/main",
  );
  if (currentPrivate !== expectedPrivateMain) {
    assert(
      expectedPrivateMain === privateRelease && currentPrivate === privateBase,
      "Private main moved while preparing the release.",
    );
    await run("git", ["push", "origin", `${privateRelease}:refs/heads/main`]);
  }
  const currentPublic = await remoteRefSha(
    publicDirectory,
    "origin",
    "refs/heads/main",
    { env: publicGitEnvironment() },
  );
  if (currentPublic !== publicRelease) {
    assert(
      currentPublic === publicBase,
      "Public main moved while preparing the release.",
    );
    await run(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        `--force-with-lease=refs/heads/main:${publicBase}`,
        "origin",
        `${publicRelease}:refs/heads/main`,
      ],
      { cwd: publicDirectory, env: publicGitEnvironment() },
    );
  }
  const privateMain = await remoteRefSha(repoRoot, "origin", "refs/heads/main");
  assert(privateMain === expectedPrivateMain, "Private main did not advance.");
  assert(
    (await remoteRefSha(publicDirectory, "origin", "refs/heads/main", {
      env: publicGitEnvironment(),
    })) === publicRelease,
    "Public main did not advance.",
  );
  return publicRelease;
}

export function parseImageDigest(inspectOutput, repository) {
  const digest = String(inspectOutput)
    .split(/\r?\n/)
    .map((line) => line.match(/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/)?.[1])
    .find(Boolean);
  assert(digest, `Could not resolve an immutable digest for ${repository}.`);
  return `${repository}@${digest}`;
}

async function inspectImage(repository, tag) {
  const inspected = await result("docker", [
    "buildx",
    "imagetools",
    "inspect",
    `${repository}:${tag}`,
  ]);
  return inspected.ok ? parseImageDigest(inspected.output, repository) : null;
}

export function canReuseReleaseImages({
  sandboxImage,
  scmImage,
  successfulRun,
}) {
  return Boolean(sandboxImage && scmImage && successfulRun);
}

export function requiresSandboxBaseRebuild(changedFiles = []) {
  return changedFiles.some((pathname) => sandboxBaseBuildInputs.has(pathname));
}

async function hasSuccessfulImageRun(releaseId, requestId) {
  const displayTitle = `Container images ${requestId}`;
  const runs = JSON.parse(
    await output("gh", [
      "run",
      "list",
      "--repo",
      publicRepository,
      "--workflow",
      "container-image.yml",
      "--json",
      "conclusion,displayTitle,headSha",
      "--limit",
      "100",
    ]),
  );
  return runs.some(
    (entry) =>
      entry.headSha === releaseId &&
      entry.displayTitle === displayTitle &&
      entry.conclusion === "success",
  );
}

async function buildReleaseImages({ releaseId, changedFiles }) {
  const requestId = `release-${releaseId}`;
  const displayTitle = `Container images ${requestId}`;
  const [existingSandbox, existingScm, existingBase] = await Promise.all([
    inspectImage(sandboxRepository, releaseId),
    inspectImage(scmRepository, releaseId),
    inspectImage(sandboxBaseRepository, releaseId),
  ]);
  if (
    canReuseReleaseImages({
      sandboxImage: existingSandbox,
      scmImage: existingScm,
      successfulRun: await hasSuccessfulImageRun(releaseId, requestId),
    })
  ) {
    return {
      sandboxImage: existingSandbox,
      scmImage: existingScm,
      baseImage: existingBase,
      reviewerIsolationProtocol: 1,
    };
  }

  const rebuildBase = requiresSandboxBaseRebuild(changedFiles);
  await run("gh", [
    "workflow",
    "run",
    "container-image.yml",
    "--repo",
    publicRepository,
    "--ref",
    "main",
    "-f",
    `image_tag=${releaseCandidateImageTag}`,
    "-f",
    `rebuild_base=${rebuildBase ? "true" : "false"}`,
    "-f",
    `request_id=${requestId}`,
    "-f",
    `source_revision=${releaseId}`,
    "-f",
    `image_revision=${releaseId}`,
  ]);
  let runId = "";
  for (let attempt = 0; attempt < 60 && !runId; attempt += 1) {
    const runs = JSON.parse(
      await output("gh", [
        "run",
        "list",
        "--repo",
        publicRepository,
        "--workflow",
        "container-image.yml",
        "--json",
        "databaseId,displayTitle,headSha",
        "--limit",
        "20",
      ]),
    );
    runId = String(
      runs.find(
        (entry) =>
          entry.headSha === releaseId && entry.displayTitle === displayTitle,
      )?.databaseId ?? "",
    );
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert(runId, "Container image workflow was not found.");
  await run("gh", [
    "run",
    "watch",
    runId,
    "--repo",
    publicRepository,
    "--exit-status",
  ]);
  const [sandboxImage, scmImage, baseImage] = await Promise.all([
    inspectImage(sandboxRepository, releaseId),
    inspectImage(scmRepository, releaseId),
    inspectImage(sandboxBaseRepository, releaseId),
  ]);
  assert(sandboxImage, "Release sandbox image was not published.");
  assert(scmImage, "Release SCM image was not published.");
  for (const [label, before, after] of [
    ["sandbox", existingSandbox, sandboxImage],
    ["SCM", existingScm, scmImage],
    ["sandbox base", existingBase, baseImage],
  ]) {
    if (before) {
      assert(
        before === after,
        `Release ${label} image digest changed on retry.`,
      );
    }
  }
  return {
    sandboxImage,
    scmImage,
    baseImage,
    reviewerIsolationProtocol: 1,
  };
}

async function promoteStableImages(images) {
  const promotions = [
    [sandboxRepository, images.sandboxImage],
    [scmRepository, images.scmImage],
    ...(images.baseImage ? [[sandboxBaseRepository, images.baseImage]] : []),
  ];
  for (const [repository, source] of promotions) {
    await run("docker", [
      "buildx",
      "imagetools",
      "create",
      "-t",
      `${repository}:stable`,
      source,
    ]);
    assert(
      (await inspectImage(repository, "stable")) === source,
      `${repository}:stable did not resolve to the promoted digest.`,
    );
  }
}

async function packageHubBundle(version, forbiddenShas) {
  const hubDirectory = path.join(publicDirectory, "packages", "hub");
  const staging = path.join(artifactsDirectory, "hub-bundle");
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, "worker"), { recursive: true });
  await mkdir(path.join(staging, "client"), { recursive: true });
  await cp(
    path.join(hubDirectory, "dist", "tiller", "index.js"),
    path.join(staging, "worker", "index.js"),
  );
  await cp(
    path.join(hubDirectory, "dist", "tiller", "assets"),
    path.join(staging, "worker", "assets"),
    { recursive: true },
  );
  await cp(
    path.join(hubDirectory, "dist", "client"),
    path.join(staging, "client"),
    { recursive: true },
  );
  await cp(
    path.join(hubDirectory, "manifest.json"),
    path.join(staging, "manifest.json"),
  );
  await assertNoForbiddenText({ directory: staging, forbidden: forbiddenShas });
  const bundlePath = path.join(artifactsDirectory, releaseBundleName(version));
  await run(
    "tar",
    [
      "--sort=name",
      "--mtime=UTC 1970-01-01",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      bundlePath,
      "-C",
      staging,
      "worker",
      "client",
      "manifest.json",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  return bundlePath;
}

async function packNpmWorkspace(workspace) {
  const workspaceDirectory = RELEASE_WORKSPACES[workspace].workspace;
  const pkg = await readJson(
    path.join(publicDirectory, workspaceDirectory, "package.json"),
  );
  const packed = JSON.parse(
    await output(
      "npm",
      [
        "pack",
        "--workspace",
        workspaceDirectory,
        "--pack-destination",
        artifactsDirectory,
        "--json",
      ],
      { cwd: publicDirectory },
    ),
  );
  assert(
    Array.isArray(packed) && packed.length === 1,
    `npm pack returned unexpected metadata for ${workspace}.`,
  );
  const [metadata] = packed;
  const packedFiles = new Set(
    (metadata.files ?? []).map((entry) => String(entry?.path ?? "")),
  );
  const declaredBins =
    typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  for (const declaredBin of declaredBins) {
    const normalized = String(declaredBin).replace(/^\.\//, "");
    assert(
      packedFiles.has(normalized),
      `${RELEASE_WORKSPACES[workspace].packageName} package is missing declared binary ${normalized}.`,
    );
  }
  const filename = path.basename(String(metadata.filename ?? "").trim());
  assert(filename, `npm pack did not return a tarball for ${workspace}.`);
  return path.join(artifactsDirectory, filename);
}

async function buildReleaseArtifacts({
  plan,
  releaseId,
  images,
  forbiddenShas = [],
}) {
  await mkdir(artifactsDirectory, { recursive: true });
  const version = plan.targetVersions.hub;
  const hubDirectory = path.join(publicDirectory, "packages", "hub");
  const buildEnv = {
    ...process.env,
    GITHUB_REF_NAME: "main",
    GITHUB_SHA: releaseId,
    WORKERS_CI_BRANCH: "main",
    WORKERS_CI_COMMIT_SHA: releaseId,
    TILLER_BUILD_CHANNEL: "release",
    TILLER_BUILD_VERSION: version,
    TILLER_PUBLIC_RELEASE_ID: releaseId,
    TILLER_SELF_HOST_RUNTIME_IMAGE: images.sandboxImage,
    TILLER_REVIEWER_ISOLATION_PROTOCOL: String(
      images.reviewerIsolationProtocol,
    ),
    TILLER_REQUIRE_RELEASE_INFO: "1",
    CONTAINER_IMAGE_TAG: images.sandboxImage,
    GITHUB_JOB_IMAGE_TAG: images.scmImage,
    TILLER_MANIFEST_REQUIRE_PINNED_IMAGES: "1",
  };
  await run("npm", ["run", "build", "--workspace", "packages/hub"], {
    cwd: publicDirectory,
    env: buildEnv,
  });
  await run("node", ["scripts/generate-manifest.mjs"], {
    cwd: hubDirectory,
    env: buildEnv,
  });
  const bundlePath = await packageHubBundle(version, forbiddenShas);
  const descriptorPath = path.join(artifactsDirectory, descriptorAssetName);
  const descriptor = await buildReleaseDescriptor({
    releaseId,
    version,
    configPath: path.join(hubDirectory, "dist", "tiller", "wrangler.json"),
    bundlePath,
    bundleUrl: canonicalReleaseBundleUrl(version, publicRepository),
    releaseNotesUrl: `https://github.com/${publicRepository}/releases/tag/tiller-hub-v${version}`,
    sandboxImage: images.sandboxImage,
    scmImage: images.scmImage,
  });
  await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const npmTarballs = {};
  for (const workspace of npmReleaseWorkspaces(plan)) {
    npmTarballs[workspace] = await packNpmWorkspace(workspace);
  }
  return { bundlePath, descriptorPath, npmTarballs };
}

async function publishHubRelease({ plan, releaseId, artifacts }) {
  const version = plan.targetVersions.hub;
  const tag = `tiller-hub-v${version}`;
  const coordinate = await lookupGitHubReleaseCoordinate({
    repository: publicRepository,
    tag,
  });
  if (coordinate.tag) {
    const target = await output("gh", [
      "api",
      `repos/${publicRepository}/commits/${encodeURIComponent(tag)}`,
      "--jq",
      ".sha",
    ]);
    assert(target === releaseId, `Git tag ${tag} points to another commit.`);
  }
  if (!coordinate.release) {
    await run("gh", [
      "release",
      "create",
      tag,
      "--repo",
      publicRepository,
      "--target",
      releaseId,
      "--title",
      `Tiller Hub v${version}`,
      "--prerelease",
      "--generate-notes",
    ]);
  } else {
    assert(coordinate.tag, `GitHub release ${tag} has no matching Git tag.`);
  }

  const release = JSON.parse(
    await output("gh", [
      "release",
      "view",
      tag,
      "--repo",
      publicRepository,
      "--json",
      "assets",
    ]),
  );
  const assetNames = new Set(
    (release.assets ?? []).map((asset) => String(asset.name ?? "")),
  );
  for (const artifactPath of [artifacts.bundlePath, artifacts.descriptorPath]) {
    if (assetNames.has(path.basename(artifactPath))) continue;
    await run("gh", [
      "release",
      "upload",
      tag,
      artifactPath,
      "--repo",
      publicRepository,
    ]);
  }

  let lastError;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await verifyPublishedRelease({
        descriptorPath: artifacts.descriptorPath,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 10) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  throw lastError;
}

async function promoteHubRelease(plan) {
  const version = plan.targetVersions.hub;
  await run("gh", [
    "release",
    "edit",
    `tiller-hub-v${version}`,
    "--repo",
    publicRepository,
    "--prerelease=false",
    "--latest",
  ]);
}

async function fileDigest(filePath, algorithm) {
  return createHash(algorithm)
    .update(await readFile(filePath))
    .digest("hex");
}

async function publishNpmPackages(plan, npmTarballs) {
  for (const workspace of npmReleaseWorkspaces(plan)) {
    const { packageName } = RELEASE_WORKSPACES[workspace];
    const version = plan.targetVersions[workspace];
    const existing = await publishedNpmMetadata(packageName, version);
    if (existing) {
      const expectedShasum = await fileDigest(npmTarballs[workspace], "sha1");
      assert(
        existing.dist?.shasum === expectedShasum,
        `${packageName}@${version} exists with different package bytes.`,
      );
      process.stdout.write(`Reused ${packageName}@${version} from npm.\n`);
      continue;
    }
    await run("npm", [
      "publish",
      npmTarballs[workspace],
      "--registry=https://registry.npmjs.org",
      "--access",
      "public",
      "--tag",
      releaseCandidateNpmTag,
    ]);
  }
}

async function waitForNpmLatest(packageName, version, attempts = 15) {
  let latest = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latest = JSON.parse(
      await output("npm", [
        "view",
        packageName,
        "dist-tags.latest",
        "--json",
        "--prefer-online",
        "--registry=https://registry.npmjs.org",
      ]),
    );
    if (latest === version) return;
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `${packageName} latest did not advance to ${version}; last observed ${latest ?? "<missing>"}.`,
  );
}

async function promoteNpmPackages(plan) {
  for (const workspace of npmReleaseWorkspaces(plan)) {
    const { packageName } = RELEASE_WORKSPACES[workspace];
    const version = plan.targetVersions[workspace];
    await run("npm", [
      "dist-tag",
      "add",
      `${packageName}@${version}`,
      "latest",
      "--registry=https://registry.npmjs.org",
    ]);
    await waitForNpmLatest(packageName, version);
  }
}

export function parseInstallerDeploymentTraffic(value) {
  const versions = value?.versions;
  assert(
    Array.isArray(versions) && versions.length > 0,
    "Installer deployment status has no rollback traffic.",
  );
  const traffic = versions.map((entry) => {
    const versionId = String(entry?.version_id ?? "").trim();
    const percentage = Number(entry?.percentage);
    assert(
      versionId &&
        Number.isFinite(percentage) &&
        percentage > 0 &&
        percentage <= 100,
      "Installer deployment status has invalid rollback traffic.",
    );
    return { versionId, percentage };
  });
  const total = traffic.reduce((sum, entry) => sum + entry.percentage, 0);
  assert(
    Math.abs(total - 100) < 0.001,
    `Installer rollback traffic must total 100%, not ${total}%.`,
  );
  return traffic;
}

async function verifyInstallerStable(descriptorPath, attempts = 30) {
  const expected = parseReleaseDescriptor(
    JSON.parse(await readFile(descriptorPath, "utf8")),
  );
  let last = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await readInstallerStable();
      if (
        value.releaseId === expected.releaseId &&
        value.version === expected.version
      ) {
        return;
      }
      last = `${value.version ?? "<missing>"} (${value.releaseId ?? "<missing>"})`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new Error(
    `Installer /stable did not report this release; last observation: ${last}.`,
  );
}

async function deployInstaller(descriptorPath) {
  try {
    await verifyInstallerStable(descriptorPath, 1);
    process.stdout.write("Installer already serves this release.\n");
    return;
  } catch {
    // Continue with deployment when stable is older or temporarily unavailable.
  }
  const installerDirectory = path.join(
    publicDirectory,
    "packages",
    "installer",
  );
  const status = JSON.parse(
    await output("npx", ["wrangler", "deployments", "status", "--json"], {
      cwd: installerDirectory,
    }),
  );
  const previousTraffic = parseInstallerDeploymentTraffic(status);
  try {
    await run("npm", ["run", "deploy"], {
      cwd: installerDirectory,
      env: {
        ...process.env,
        TILLER_INSTALLER_DESCRIPTOR_PATH: descriptorPath,
      },
    });
    await verifyInstallerStable(descriptorPath);
  } catch (error) {
    try {
      await run(
        "npx",
        [
          "wrangler",
          "versions",
          "deploy",
          ...previousTraffic.map(
            ({ versionId, percentage }) => `${versionId}@${percentage}`,
          ),
          "--yes",
        ],
        { cwd: installerDirectory },
      );
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Installer release failed and rollback also failed.",
      );
    }
    throw error;
  }
}

async function moveStableRef(privateRelease, expectedStable) {
  const current = await remoteRefSha(repoRoot, "origin", stableRef);
  if (current === privateRelease) return;
  assert(
    current === expectedStable,
    "tiller-release/stable moved during the release.",
  );
  await run("git", ["push", "origin", `${privateRelease}:${stableRef}`]);
  assert(
    (await remoteRefSha(repoRoot, "origin", stableRef)) === privateRelease,
    "tiller-release/stable did not advance.",
  );
}

async function release({ bump = "patch", resetPublicHistory = false } = {}) {
  const privateHead = await requireCleanPrivateMain();
  const stableBase = await fetchStableBase();
  const pending = await pendingReleaseAtHead(privateHead, stableBase);
  const privateBase = pending?.privateBase ?? privateHead;
  const [changedFiles, versions] = await Promise.all([
    changedFilesSinceStable(stableBase, privateBase),
    pending
      ? readWorkspaceVersionsAtRef(repoRoot, privateBase)
      : readWorkspaceVersions(repoRoot),
  ]);
  const releaseBump = pending
    ? inferReleaseBump({
        versions,
        releaseVersion: pending.releaseVersion,
      })
    : normalizeReleaseBump(bump);
  const currentCli = await publishedNpmMetadata(
    RELEASE_WORKSPACES.tiller.packageName,
    versions.tiller,
  );
  const forceCli = Boolean(currentCli?.deprecated);
  const plan = resolveReleasePlan({
    bump: releaseBump,
    changedFiles,
    forceCli,
    versions,
  });
  if (forceCli) {
    process.stdout.write(
      `Current CLI ${versions.tiller} is deprecated; including the CLI in ${plan.releaseVersion}.\n`,
    );
  }
  let privateRelease;
  let expectedPrivateMain = privateHead;
  if (pending) {
    assert(
      pending.releaseVersion === plan.releaseVersion,
      "Pending release version does not match the current release plan.",
    );
    assert(
      sameVersions(await readWorkspaceVersions(repoRoot), plan.targetVersions),
      "Pending release workspace versions do not match the release plan.",
    );
    privateRelease = pending.privateRelease;
  }

  await preflightReleaseAccess();
  await assertTargetsAvailable(plan, { allowExisting: Boolean(pending) });
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(releaseRoot, { recursive: true });

  if (!privateRelease) {
    privateRelease = await commitPrivateRelease(plan);
    expectedPrivateMain = privateRelease;
  }
  const snapshot = await exportPublicSnapshot({
    privateBase,
    privateRelease,
    resetPublicHistory,
  });
  await buildAndTestPublicTree();
  const releaseId = await pushReleaseCommits({
    privateBase,
    privateRelease,
    expectedPrivateMain,
    publicBase: snapshot.publicBase,
    publicRelease: snapshot.releaseId,
  });

  const images = await buildReleaseImages({
    releaseId,
    changedFiles,
  });
  const artifacts = await buildReleaseArtifacts({
    plan,
    releaseId,
    images,
    forbiddenShas: [privateBase, privateRelease],
  });
  await publishHubRelease({ plan, releaseId, artifacts });
  await publishNpmPackages(plan, artifacts.npmTarballs);
  await deployInstaller(artifacts.descriptorPath);
  await promoteStableImages(images);
  await promoteNpmPackages(plan);
  await promoteHubRelease(plan);
  await moveStableRef(privateRelease, stableBase);

  process.stdout.write(
    `Released monorepo v${plan.releaseVersion} from public snapshot ${releaseId}.\n`,
  );
}

async function main() {
  await release({
    bump: parseReleaseBump(process.argv.slice(2)),
    resetPublicHistory:
      process.env.TILLER_RESET_PUBLIC_HISTORY?.trim().toLowerCase() === "true",
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
