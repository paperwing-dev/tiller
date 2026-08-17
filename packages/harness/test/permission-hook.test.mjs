import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const hook = readFileSync(join(import.meta.dirname, "../hooks/pre-tool-use.mjs"), "utf8");
const harness = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");

test("Claude permission hooks use the environment-scoped capability route", () => {
  assert.match(hook, /TILLER_ENV_SLUG/);
  assert.match(hook, /TILLER_RUNTIME_CAPABILITY/);
  assert.match(hook, /"X-Tiller-Capability"/);
  assert.match(hook, /\/api\/envs\/\$\{encodeURIComponent\(ENV_SLUG\)\}\/sessions/);
  assert.doesNotMatch(hook, /\$\{HUB_URL\}\/api\/sessions/);
  assert.match(harness, /TILLER_ENV_SLUG: process\.env\.REPO_SLUG/);
  assert.match(harness, /TILLER_RUNTIME_CAPABILITY:/);
  assert.doesNotMatch(hook, /TILLER_CONTROL_SECRET|controlSecret/);
  assert.doesNotMatch(harness, /TILLER_CONTROL_SECRET|controlSecret/);
});
