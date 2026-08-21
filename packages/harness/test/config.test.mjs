import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const configModuleUrl = pathToFileURL(resolve(import.meta.dirname, "../dist/config.js")).href;

function runConfig(env, expression) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const config = await import(${JSON.stringify(configModuleUrl)}); ${expression}`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TILLER_CONFIG_PATH: resolve(tmpdir(), `tiller-harness-config-${randomUUID()}.json`),
        ...env,
      },
    },
  );
}

test("workers.dev retains the service token headers Cloudflare needs to issue an app JWT", () => {
  const result = runConfig({
    HUB_URL: "https://demo.preview.workers.dev",
    CF_ACCESS_CLIENT_ID: "service-client.access",
    CF_ACCESS_CLIENT_SECRET: "service-secret",
  }, "console.log(JSON.stringify({ workers: config.IS_WORKERS_DEV_HUB, headers: config.cfTransportHeaders, complete: config.HAS_CF_ACCESS_SERVICE_TOKEN }));");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    workers: true,
    complete: true,
    headers: {
      "CF-Access-Client-Id": "service-client.access",
      "CF-Access-Client-Secret": "service-secret",
    },
  });
});

for (const harness of ["claude-code", "codex", "opencode"]) {
  test(`${harness} emits the environment capability only on runtime headers`, () => {
    const result = runConfig({
      TILLER_HARNESS: harness,
      HUB_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CLIENT_ID: "service-client.access",
      CF_ACCESS_CLIENT_SECRET: "service-secret",
      TILLER_RUNTIME_CAPABILITY: "environment-capability",
      TILLER_CONTROL_SECRET: "must-not-cross-container-boundary",
    }, "console.log(JSON.stringify({ transport: config.cfTransportHeaders, runtime: config.environmentRuntimeHeaders }));");

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      transport: {
        "CF-Access-Client-Id": "service-client.access",
        "CF-Access-Client-Secret": "service-secret",
      },
      runtime: {
        "CF-Access-Client-Id": "service-client.access",
        "CF-Access-Client-Secret": "service-secret",
        "X-Tiller-Capability": "environment-capability",
      },
    });
  });
}

test("workers.dev fails closed when the installation service token is absent", () => {
  const result = runConfig({
    HUB_URL: "https://demo.preview.workers.dev",
    CF_ACCESS_CLIENT_ID: "",
    CF_ACCESS_CLIENT_SECRET: "",
  }, "config.ensureAuth();");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /workers\.dev hubs require.*service token/i);
});
