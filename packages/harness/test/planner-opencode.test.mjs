import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildArgs,
  buildOpenCodeProxyConfig,
  OPENCODE_REVIEWER_SESSION_TITLE,
} from "../dist/planner/providers/opencode.js";

const PROXY_ENV = {
  TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
  TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
  TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
  TILLER_OPENCODE_BASE_URL: "http://hub.test/api/opencode/v1",
  TILLER_OPENCODE_AUTH_TOKEN: "proxy-token",
  TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
  TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
  TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
  TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "262144",
  TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
};

test("builds the hub proxy config mirroring the interactive entrypoint", () => {
  const config = JSON.parse(buildOpenCodeProxyConfig({
    ...PROXY_ENV,
    CF_ACCESS_CLIENT_ID: "cf-id",
    CF_ACCESS_CLIENT_SECRET: "cf-secret",
  }));
  assert.equal(config.provider["tiller-hub"].options.baseURL, "http://hub.test/api/opencode/v1");
  assert.equal(config.provider["tiller-hub"].options.apiKey, "proxy-token");
  assert.equal(config.provider["tiller-hub"].options.headers["CF-Access-Client-Id"], "cf-id");
  assert.equal(config.provider["tiller-hub"].models["tiller-kimi-k2-7-code"].id, "@cf/moonshotai/kimi-k2.7-code");
  assert.deepEqual(config.provider["tiller-hub"].models["tiller-kimi-k2-7-code"].limit, {
    context: 262144,
    output: 262144,
  });
  assert.deepEqual(config.enabled_providers, ["tiller-hub"]);
  assert.deepEqual(Object.keys(config.provider), ["tiller-hub"]);
  assert.deepEqual(Object.keys(config.provider["tiller-hub"].models), ["tiller-kimi-k2-7-code"]);
  assert.equal(config.model, "tiller-hub/tiller-kimi-k2-7-code");
  assert.equal(config.default_agent, "tiller-reviewer");
  assert.deepEqual(Object.entries(config.agent["tiller-reviewer"].permission), [
    ["*", "deny"],
    ["read", "allow"],
    ["glob", "allow"],
    ["grep", "allow"],
    ["bash", "allow"],
    ["webfetch", "allow"],
    ["websearch", "allow"],
  ]);
  assert.equal(config.share, "disabled");
});

test("returns null without the proxy env vars", () => {
  assert.equal(buildOpenCodeProxyConfig({}), null);
});

test("fails closed when the selected provider or model metadata is incomplete", () => {
  const { TILLER_OPENCODE_MODEL_ALIAS: _, ...incomplete } = PROXY_ENV;
  assert.throws(
    () => buildOpenCodeProxyConfig(incomplete),
    /TILLER_OPENCODE_MODEL_ALIAS is required/,
  );
  assert.throws(
    () => buildOpenCodeProxyConfig({
      TILLER_OPENCODE_BASE_URL: PROXY_ENV.TILLER_OPENCODE_BASE_URL,
      TILLER_OPENCODE_AUTH_TOKEN: PROXY_ENV.TILLER_OPENCODE_AUTH_TOKEN,
    }),
    /TILLER_OPENCODE_PROVIDER_KIND is required/,
  );
});

test("does not attach Cloudflare Access headers to a direct OpenAI provider", () => {
  const config = JSON.parse(buildOpenCodeProxyConfig({
    ...PROXY_ENV,
    TILLER_OPENCODE_PROVIDER_KIND: "openai",
    TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-openai",
    TILLER_OPENCODE_PROVIDER_LABEL: "OpenAI",
    TILLER_OPENCODE_BASE_URL: "https://api.openai.com/v1",
    TILLER_OPENCODE_AUTH_TOKEN: "openai-key",
    TILLER_OPENCODE_MODEL_ID: "gpt-5.6-sol",
    TILLER_OPENCODE_MODEL_ALIAS: "gpt-5-6-sol",
    TILLER_OPENCODE_MODEL_LABEL: "GPT-5.6 Sol",
    CF_ACCESS_CLIENT_ID: "must-not-leak",
    CF_ACCESS_CLIENT_SECRET: "must-not-leak",
  }));

  assert.deepEqual(config.enabled_providers, ["tiller-openai"]);
  assert.deepEqual(Object.keys(config.provider), ["tiller-openai"]);
  assert.deepEqual(Object.keys(config.provider["tiller-openai"].models), ["gpt-5-6-sol"]);
  assert.equal(config.provider["tiller-openai"].options.headers, undefined);
});

test("buildArgs uses the provider/model alias and writes the config", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-oc-"));
  try {
    const configPath = join(root, "config.json");
    const command = buildArgs({
      prompt: "Plan the work.",
      model: "@cf/moonshotai/kimi-k2.7-code",
      env: PROXY_ENV,
      configPath,
    });
    assert.equal(command.command, "opencode");
    // `-m` must be provider/model format — never the raw model id. The
    // explicit title prevents OpenCode from starting a second model call.
    assert.deepEqual(command.args.slice(0, 7), [
      "run",
      "--format",
      "json",
      "--title",
      OPENCODE_REVIEWER_SESSION_TITLE,
      "--model",
      "tiller-hub/tiller-kimi-k2-7-code",
    ]);
    assert.deepEqual(command.args.slice(7, 9), ["--agent", "tiller-reviewer"]);
    assert.equal(command.args.at(-1), "Plan the work.");
    assert.ok(command.env.OPENCODE_CONFIG_CONTENT.includes("tiller-hub"));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.equal(written.model, "tiller-hub/tiller-kimi-k2-7-code");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildArgs rejects a planner model that disagrees with the selected runtime model", () => {
  assert.throws(
    () => buildArgs({
      prompt: "Plan the work.",
      model: "gpt-5.5",
      env: PROXY_ENV,
    }),
    /does not match the selected runtime model/,
  );
});

test("buildArgs omits the model flag for raw ids without proxy config", () => {
  const command = buildArgs({ prompt: "Plan.", model: "@cf/raw-id", env: {} });
  assert.deepEqual(command.args, [
    "run",
    "--format",
    "json",
    "--title",
    OPENCODE_REVIEWER_SESSION_TITLE,
    "Plan.",
  ]);
});

test("buildArgs can continue the exact reviewer session during recovery", () => {
  const command = buildArgs({
    prompt: "Return the final answer.",
    model: "@cf/moonshotai/kimi-k2.7-code",
    env: PROXY_ENV,
    sessionId: "ses_recovery",
  });
  assert.deepEqual(
    command.args.slice(command.args.indexOf("--session"), command.args.indexOf("--session") + 2),
    ["--session", "ses_recovery"],
  );
  assert.equal(command.args.at(-1), "Return the final answer.");
});

test("buildArgs writes the selected reasoningEffort into the generated model config", () => {
  const root = mkdtempSync(join(tmpdir(), "planner-oc-effort-"));
  try {
    const command = buildArgs({
      prompt: "Review.",
      model: "@cf/moonshotai/kimi-k2.7-code",
      effort: "medium",
      env: PROXY_ENV,
      configPath: join(root, "config.json"),
    });
    const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT);
    assert.equal(
      config.provider["tiller-hub"].models["tiller-kimi-k2-7-code"].options.reasoningEffort,
      "medium",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
