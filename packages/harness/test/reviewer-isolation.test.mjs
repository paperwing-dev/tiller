import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReviewerProviderEnvironment,
  fingerprintReviewerCheckout,
  prepareReviewerRuntimeDirectories,
  protectReviewerCheckout,
  REVIEWER_ISOLATION_PROTOCOL,
  seedOpenCodeReviewerRuntime,
} from "../dist/planner/reviewer-isolation.js";
import { buildOpenCodeProxyConfig } from "../dist/planner/providers/opencode.js";

test("reviewer protocol protects checkout bytes and provides separate writable directories", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-isolation-"));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  writeFileSync(join(checkout, "source.ts"), "export const stable = true;\n");
  writeFileSync(join(checkout, ".git", "HEAD"), "ref: refs/heads/main\n");
  try {
    const { account, directories } = prepareReviewerRuntimeDirectories(checkout, "run-1");
    protectReviewerCheckout(checkout);
    const before = fingerprintReviewerCheckout(checkout);

    assert.equal(REVIEWER_ISOLATION_PROTOCOL, 1);
    assert.equal(statSync(checkout).mode & 0o222, 0);
    assert.equal(statSync(join(checkout, ".git")).mode & 0o222, 0);
    assert.notEqual(directories.home, checkout);
    assert.notEqual(directories.temporary, checkout);
    assert.notEqual(directories.cache, checkout);
    assert.notEqual(directories.output, checkout);
    assert.equal(statSync(directories.codexHome).uid, account.uid);
    assert.equal(statSync(directories.codexHome).gid, account.gid);
    assert.equal(statSync(directories.codexHome).mode & 0o777, 0o700);
    assert.equal(fingerprintReviewerCheckout(checkout), before);
  } finally {
    try { chmodSync(checkout, 0o755); } catch {}
    try { chmodSync(join(checkout, ".git"), 0o755); } catch {}
    try { chmodSync(join(checkout, "source.ts"), 0o644); } catch {}
    try { chmodSync(join(checkout, ".git", "HEAD"), 0o644); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated OpenCode XDG directories are seeded before provider privilege drop", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-opencode-seed-"));
  const checkout = join(root, "checkout");
  const seed = join(root, "seed");
  mkdirSync(checkout);
  for (const area of ["data", "cache", "state"]) {
    mkdirSync(join(seed, area), { recursive: true });
    writeFileSync(join(seed, area, `${area}.txt`), `${area}-seed`);
  }
  try {
    const { account, directories } = prepareReviewerRuntimeDirectories(checkout, "opencode-run");
    seedOpenCodeReviewerRuntime(directories, account, seed);

    for (const [area, destination] of [
      ["data", directories.data],
      ["cache", directories.cache],
      ["state", directories.state],
    ]) {
      const copied = join(destination, "opencode", `${area}.txt`);
      assert.equal(readFileSync(copied, "utf8"), `${area}-seed`);
      assert.equal(statSync(copied).uid, account.uid);
      assert.equal(statSync(copied).gid, account.gid);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider environment allowlists only the selected authentication and excludes infrastructure secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-env-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  try {
    const { directories } = prepareReviewerRuntimeDirectories(checkout, "run-2");
    const source = {
      PATH: "/usr/bin",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: "subscription",
      CLAUDE_CODE_OAUTH_TOKEN: "selected-token",
      ANTHROPIC_API_KEY: "inactive-key",
      TILLER_ENV_REVIEW_RUN_TOKEN: "callback-secret",
      TILLER_GITHUB_BRIDGE_SECRET: "github-secret",
      CF_ACCESS_CLIENT_SECRET: "access-secret",
      TILLER_WORKSPACE_SYNC_TOKEN: "workspace-secret",
    };
    const env = buildReviewerProviderEnvironment({
      harness: "claude-code",
      source,
      directories,
    });

    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "selected-token");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.TILLER_ENV_REVIEW_RUN_TOKEN, undefined);
    assert.equal(env.TILLER_GITHUB_BRIDGE_SECRET, undefined);
    assert.equal(env.CF_ACCESS_CLIENT_SECRET, undefined);
    assert.equal(env.TILLER_WORKSPACE_SYNC_TOKEN, undefined);
    assert.equal(env.HOME, directories.home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated OpenCode keeps the Access transport required by its Hub proxy", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-opencode-env-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  try {
    const { directories } = prepareReviewerRuntimeDirectories(checkout, "opencode-env");
    const env = buildReviewerProviderEnvironment({
      harness: "opencode",
      source: {
        PATH: "/usr/bin",
        CF_ACCESS_CLIENT_ID: "access-id",
        CF_ACCESS_CLIENT_SECRET: "access-secret",
        TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
        TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
        TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
        TILLER_OPENCODE_BASE_URL: "https://hub.test/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "proxy-token",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
        TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
        TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
        TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "262144",
        TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
        TILLER_PLANNER_RUN_TOKEN: "callback-secret",
        TILLER_GITHUB_BRIDGE_SECRET: "github-secret",
      },
      directories,
    });

    assert.equal(env.CF_ACCESS_CLIENT_ID, "access-id");
    assert.equal(env.CF_ACCESS_CLIENT_SECRET, "access-secret");
    assert.equal(env.TILLER_PLANNER_RUN_TOKEN, undefined);
    assert.equal(env.TILLER_GITHUB_BRIDGE_SECRET, undefined);
    const config = JSON.parse(buildOpenCodeProxyConfig(env));
    assert.deepEqual(config.provider["tiller-hub"].options.headers, {
      "CF-Access-Client-Id": "access-id",
      "CF-Access-Client-Secret": "access-secret",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated OpenCode does not expose Access transport to direct providers", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-opencode-direct-env-"));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  try {
    const { directories } = prepareReviewerRuntimeDirectories(checkout, "opencode-direct-env");
    const env = buildReviewerProviderEnvironment({
      harness: "opencode",
      source: {
        CF_ACCESS_CLIENT_ID: "must-not-leak",
        CF_ACCESS_CLIENT_SECRET: "must-not-leak",
        TILLER_OPENCODE_PROVIDER_KIND: "openai",
      },
      directories,
    });

    assert.equal(env.CF_ACCESS_CLIENT_ID, undefined);
    assert.equal(env.CF_ACCESS_CLIENT_SECRET, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
