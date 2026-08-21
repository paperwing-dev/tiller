import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const INDEX_SOURCE = path.resolve(import.meta.dirname, "../src/index.ts");

test("logs websocket connection locally for the container watchdog", () => {
  const source = readFileSync(INDEX_SOURCE, "utf8");

  assert.match(source, /console\.error\("\[tiller\] Hub WebSocket connected"\)/);
});

test("hides generated startup-plan files before consuming the plan", () => {
  const source = readFileSync(INDEX_SOURCE, "utf8");
  const excludeIndex = source.indexOf("ensureStartupPlanGitExcludes(cwd, planFile)");
  const renameIndex = source.indexOf('renameSync(planFile, planFile + ".executed")');

  assert.notEqual(excludeIndex, -1);
  assert.notEqual(renameIndex, -1);
  assert.ok(excludeIndex < renameIndex);
});

test("terminal resize is accepted before the active-PTY guard", () => {
  const source = readFileSync(INDEX_SOURCE, "utf8");
  const handlerIndex = source.indexOf('hub.on("terminal-control"');
  const resizeIndex = source.indexOf('if (msg.action === "resize")', handlerIndex);
  const handoffIndex = source.indexOf("terminalResizeHandoff.resize", resizeIndex);
  const activePtyGuardIndex = source.indexOf("if (!agent)", resizeIndex);

  assert.notEqual(handlerIndex, -1);
  assert.notEqual(resizeIndex, -1);
  assert.notEqual(handoffIndex, -1);
  assert.notEqual(activePtyGuardIndex, -1);
  assert.ok(resizeIndex < handoffIndex);
  assert.ok(handoffIndex < activePtyGuardIndex);
});
