#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  process.getuid?.() === 0,
  "planner entrypoint must retain root for the isolation supervisor",
);
assert(
  process.env.TILLER_REVIEWER_ISOLATION_PROTOCOL === "1",
  "planner entrypoint did not preserve the validated isolation protocol",
);

const globalRoot = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
}).trim();
const isolationModule = join(
  globalRoot,
  "@paperwing-dev/tiller-harness",
  "dist",
  "planner",
  "reviewer-isolation.js",
);
const {
  buildReviewerProviderEnvironment,
  fingerprintReviewerCheckout,
  prepareReviewerRuntimeDirectories,
  protectReviewerCheckout,
  reviewerChildIdentity,
  seedOpenCodeReviewerRuntime,
} = await import(pathToFileURL(isolationModule).href);

const workspaceRoot = join(tmpdir(), "tiller-planner");
const symlinkTarget = join(tmpdir(), "tiller-planner-symlink-target");
const unrelatedRoot = join(tmpdir(), "tiller-reviewer-unrelated");
const checkout = join(workspaceRoot, "checkout");
const sourcePath = join(checkout, "source.ts");
const originalUmask = process.umask(0o077);
const subprocessTimeoutMs = 30_000;
let appServer = null;
let appServerClose = null;
let appServerClosed = true;

async function stopAppServer() {
  if (!appServer || !appServerClose || appServerClosed) return;
  appServer.kill("SIGTERM");
  await Promise.race([appServerClose, delay(2_000)]);
  if (!appServerClosed) {
    appServer.kill("SIGKILL");
    await appServerClose;
  }
}

try {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(symlinkTarget, { recursive: true, force: true });
  rmSync(unrelatedRoot, { recursive: true, force: true });
  let broadRootRejected = false;
  try {
    prepareReviewerRuntimeDirectories(
      join(tmpdir(), "checkout"),
      "broad-root-smoke",
    );
  } catch (error) {
    broadRootRejected = /dedicated directory/u.test(String(error));
  }
  assert(
    broadRootRejected,
    "reviewer workspace accepted the operating-system temporary root",
  );

  mkdirSync(unrelatedRoot, { recursive: true });
  chmodSync(unrelatedRoot, 0o755);
  const unrelatedBefore = statSync(unrelatedRoot);
  let unrelatedRootRejected = false;
  try {
    prepareReviewerRuntimeDirectories(
      join(unrelatedRoot, "checkout"),
      "unrelated-root-smoke",
    );
  } catch (error) {
    unrelatedRootRejected = /must use/u.test(String(error));
  }
  const unrelatedAfter = statSync(unrelatedRoot);
  assert(
    unrelatedRootRejected,
    "reviewer workspace accepted an unrelated configured parent",
  );
  assert(
    unrelatedAfter.uid === unrelatedBefore.uid &&
      unrelatedAfter.gid === unrelatedBefore.gid,
    "reviewer workspace changed ownership of an unrelated parent",
  );
  assert(
    (unrelatedAfter.mode & 0o7777) === (unrelatedBefore.mode & 0o7777),
    "reviewer workspace changed permissions of an unrelated parent",
  );

  prepareReviewerRuntimeDirectories(checkout, "restrictive-umask-smoke");
  let workspaceStat = statSync(workspaceRoot);
  assert(
    workspaceStat.uid === 0 && workspaceStat.gid === 0,
    "reviewer workspace root is not supervisor-owned",
  );
  assert(
    (workspaceStat.mode & 0o7777) === 0o711,
    "reviewer workspace root is not traversal-only after a restrictive umask",
  );

  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const tillerHomeStat = statSync("/home/tiller");
  chownSync(workspaceRoot, tillerHomeStat.uid, tillerHomeStat.gid);
  let nonSupervisorRootRejected = false;
  try {
    prepareReviewerRuntimeDirectories(checkout, "non-supervisor-root-smoke");
  } catch (error) {
    nonSupervisorRootRejected = /privileged supervisor/u.test(String(error));
  }
  assert(
    nonSupervisorRootRejected,
    "reviewer workspace accepted a root owned by the provider user",
  );

  rmSync(workspaceRoot, { recursive: true, force: true });
  mkdirSync(symlinkTarget, { recursive: true });
  symlinkSync(symlinkTarget, workspaceRoot, "dir");
  let symlinkRejected = false;
  try {
    prepareReviewerRuntimeDirectories(checkout, "symlink-smoke");
  } catch (error) {
    symlinkRejected = /must be a directory/u.test(String(error));
  }
  assert(symlinkRejected, "reviewer workspace accepted a symbolic-link parent");

  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(symlinkTarget, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });
  chmodSync(workspaceRoot, 0o7777);
  const { account, directories } = prepareReviewerRuntimeDirectories(
    checkout,
    "image-smoke",
  );
  workspaceStat = statSync(workspaceRoot);
  assert(
    (workspaceStat.mode & 0o7777) === 0o711,
    "permissive reviewer workspace root was not clamped",
  );

  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(sourcePath, "export const protectedCheckout = true;\n");
  seedOpenCodeReviewerRuntime(directories, account);
  protectReviewerCheckout(checkout);
  const before = fingerprintReviewerCheckout(checkout);
  const identity = reviewerChildIdentity(account);
  const harnesses = [
    {
      harness: "claude-code",
      command: "claude",
      source: {
        ...process.env,
        TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
        CLAUDE_CODE_OAUTH_TOKEN: "image-smoke-token",
      },
    },
    {
      harness: "codex",
      command: "codex",
      source: {
        ...process.env,
        RUNNER_BACKEND: "cf",
        TILLER_CODEX_AUTH_MODE: "api-key",
        OPENAI_API_KEY: "image-smoke-key",
      },
    },
    {
      harness: "opencode",
      command: "opencode",
      source: {
        ...process.env,
        TILLER_OPENCODE_BASE_URL: "https://example.invalid/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "image-smoke-token",
      },
    },
  ];
  const requestedHarness = process.env.TILLER_HARNESS;
  const activeHarnesses = harnesses.filter(
    ({ harness }) => harness === requestedHarness,
  );
  assert(
    activeHarnesses.length === 1,
    `unsupported reviewer smoke harness: ${requestedHarness ?? "missing"}`,
  );
  const environments = new Map();

  for (const harness of activeHarnesses) {
    const env = buildReviewerProviderEnvironment({
      harness: harness.harness,
      source: {
        ...harness.source,
        TILLER_GITHUB_BRIDGE_SECRET: "must-not-reach-reviewer",
      },
      directories,
    });
    environments.set(harness.harness, env);
    assert(
      !("TILLER_GITHUB_BRIDGE_SECRET" in env),
      `${harness.harness} environment leaked a Hub credential`,
    );

    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import { readFileSync, statSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        const [sourcePath, outputPath, expectedUid, harness] = process.argv.slice(1);
        if (String(process.getuid?.()) !== expectedUid) process.exit(10);
        if (!readFileSync(sourcePath, "utf8").includes("protectedCheckout")) process.exit(11);
        for (const path of [process.env.HOME, process.env.CODEX_HOME, process.env.XDG_CONFIG_HOME]) {
          if (!path || statSync(path).uid !== process.getuid()) process.exit(12);
        }
        try {
          writeFileSync(sourcePath, "mutated");
          process.exit(13);
        } catch (error) {
          if (error?.code !== "EACCES" && error?.code !== "EPERM") process.exit(14);
        }
        if (process.env.TILLER_GITHUB_BRIDGE_SECRET) process.exit(15);
        writeFileSync(join(process.env.HOME, harness + ".txt"), "writable\\n");
        writeFileSync(outputPath, harness + " reviewer smoke passed\\n");
      `,
        sourcePath,
        directories.output,
        String(account.uid),
        harness.harness,
      ],
      {
        env,
        ...identity,
        encoding: "utf8",
        timeout: subprocessTimeoutMs,
      },
    );
    assert(
      child.status === 0,
      `${harness.harness} isolated child failed (${child.status}): ${child.error?.message ?? child.stderr}`,
    );
    assert(
      readFileSync(directories.output, "utf8") ===
        `${harness.harness} reviewer smoke passed\n`,
      `${harness.harness} review output was not writable`,
    );

    const version = spawnSync(harness.command, ["--version"], {
      env,
      ...identity,
      encoding: "utf8",
      timeout: subprocessTimeoutMs,
    });
    assert(
      version.status === 0,
      `${harness.harness} CLI failed as the reviewer user: ${version.error?.message ?? version.stderr}`,
    );
  }

  if (requestedHarness === "codex") {
    const codexEnv = environments.get("codex");
    const socketPath = join(
      directories.temporary,
      "codex-app-server-smoke.sock",
    );
    appServer = spawn(
      "codex",
      [
        "app-server",
        "--listen",
        `unix://${socketPath}`,
        "--strict-config",
        "-c",
        "mcp_servers={}",
      ],
      {
        cwd: checkout,
        env: codexEnv,
        ...identity,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    appServerClosed = false;
    let appServerStderr = "";
    let appServerError = null;
    appServer.stderr.on("data", (chunk) => {
      appServerStderr += String(chunk);
    });
    appServer.on("error", (error) => {
      appServerError = error;
    });
    appServerClose = new Promise((resolve) => {
      appServer.on("close", () => {
        appServerClosed = true;
        resolve();
      });
    });
    for (
      let attempt = 0;
      attempt < 100 && !existsSync(socketPath) && !appServerClosed;
      attempt += 1
    ) {
      await delay(50);
    }
    assert(
      !appServerError,
      `Codex app-server failed to spawn: ${appServerError?.message}`,
    );
    assert(
      existsSync(socketPath),
      `Codex app-server failed during startup: ${appServerStderr.trim()}`,
    );
    await stopAppServer();
  }

  assert(
    fingerprintReviewerCheckout(checkout) === before,
    "reviewer child changed the protected checkout",
  );
  console.log(
    `planner entrypoint reviewer isolation smoke passed for ${requestedHarness}`,
  );
} finally {
  await stopAppServer();
  process.umask(originalUmask);
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(symlinkTarget, { recursive: true, force: true });
  rmSync(unrelatedRoot, { recursive: true, force: true });
}
