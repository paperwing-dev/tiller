import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_SOURCE = path.resolve(
  import.meta.dirname,
  "../hooks/opencode-activity.mjs",
);

test("OpenCode completes only a successful foreground busy-to-idle turn", async () => {
  const previousBun = globalThis.Bun;
  const previousHookPath = process.env.TILLER_ACTIVITY_HOOK_PATH;
  const reports = [];
  globalThis.Bun = {
    spawn(args) {
      reports.push(args);
      return { exited: Promise.resolve(0) };
    },
  };
  process.env.TILLER_ACTIVITY_HOOK_PATH = "/tmp/activity-hook.mjs";

  try {
    const module = await import(`${pathToFileURL(PLUGIN_SOURCE).href}?test=${Date.now()}`);
    const plugin = await module.TillerActivityPlugin();
    const session = (id, parentID) => plugin.event({
      event: {
        type: "session.created",
        properties: { info: { id, parentID } },
      },
    });
    const status = (sessionID, type) => plugin.event({
      event: {
        type: "session.status",
        properties: { sessionID, status: { type } },
      },
    });

    await status("unseen", "idle");
    await session("lead");
    await session("child", "lead");
    await status("lead", "busy");
    await status("child", "busy");
    await status("child", "idle");
    await status("lead", "idle");
    await status("lead", "idle");

    assert.deepEqual(reports, [
      ["node", "/tmp/activity-hook.mjs", "working"],
      ["node", "/tmp/activity-hook.mjs", "completed"],
    ]);
  } finally {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
    if (previousHookPath === undefined) delete process.env.TILLER_ACTIVITY_HOOK_PATH;
    else process.env.TILLER_ACTIVITY_HOOK_PATH = previousHookPath;
  }
});

test("OpenCode errors and aborts settle foreground turns without completing them", async () => {
  const previousBun = globalThis.Bun;
  const previousHookPath = process.env.TILLER_ACTIVITY_HOOK_PATH;
  const reports = [];
  globalThis.Bun = {
    spawn(args) {
      reports.push(args);
      return { exited: Promise.resolve(0) };
    },
  };
  process.env.TILLER_ACTIVITY_HOOK_PATH = "/tmp/activity-hook.mjs";

  try {
    const module = await import(`${pathToFileURL(PLUGIN_SOURCE).href}?errors=${Date.now()}`);
    const plugin = await module.TillerActivityPlugin();
    const emit = (type, properties) => plugin.event({ event: { type, properties } });

    await emit("session.created", { info: { id: "lead" } });
    await emit("session.status", { sessionID: "lead", status: { type: "busy" } });
    await emit("permission.asked", { sessionID: "lead" });
    await emit("session.error", { sessionID: "lead", error: { name: "ProviderError" } });
    await emit("session.status", { sessionID: "lead", status: { type: "idle" } });

    await emit("session.status", { sessionID: "lead", status: { type: "busy" } });
    await emit("message.updated", {
      info: {
        role: "assistant",
        sessionID: "lead",
        error: { name: "MessageAbortedError" },
      },
    });
    await emit("session.status", { sessionID: "lead", status: { type: "idle" } });

    assert.deepEqual(reports, [
      ["node", "/tmp/activity-hook.mjs", "working"],
      ["node", "/tmp/activity-hook.mjs", "idle"],
      ["node", "/tmp/activity-hook.mjs", "working"],
      ["node", "/tmp/activity-hook.mjs", "idle"],
    ]);
  } finally {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
    if (previousHookPath === undefined) delete process.env.TILLER_ACTIVITY_HOOK_PATH;
    else process.env.TILLER_ACTIVITY_HOOK_PATH = previousHookPath;
  }
});

test("OpenCode follows sequential foreground root sessions", async () => {
  const previousBun = globalThis.Bun;
  const previousHookPath = process.env.TILLER_ACTIVITY_HOOK_PATH;
  const reports = [];
  globalThis.Bun = {
    spawn(args) {
      reports.push(args);
      return { exited: Promise.resolve(0) };
    },
  };
  process.env.TILLER_ACTIVITY_HOOK_PATH = "/tmp/activity-hook.mjs";

  try {
    const module = await import(`${pathToFileURL(PLUGIN_SOURCE).href}?roots=${Date.now()}`);
    const plugin = await module.TillerActivityPlugin();
    const emit = (type, properties) => plugin.event({ event: { type, properties } });

    await emit("session.created", { info: { id: "first-root" } });
    await emit("session.created", { info: { id: "first-child", parentID: "first-root" } });
    await emit("session.created", { info: { id: "second-root" } });
    await emit("session.status", { sessionID: "first-root", status: { type: "busy" } });
    await emit("session.status", { sessionID: "first-root", status: { type: "idle" } });
    await emit("session.status", { sessionID: "first-child", status: { type: "busy" } });
    await emit("session.status", { sessionID: "first-child", status: { type: "idle" } });
    await emit("session.status", { sessionID: "second-root", status: { type: "busy" } });
    await emit("session.status", { sessionID: "second-root", status: { type: "idle" } });

    assert.deepEqual(reports, [
      ["node", "/tmp/activity-hook.mjs", "working"],
      ["node", "/tmp/activity-hook.mjs", "completed"],
      ["node", "/tmp/activity-hook.mjs", "working"],
      ["node", "/tmp/activity-hook.mjs", "completed"],
    ]);
  } finally {
    if (previousBun === undefined) delete globalThis.Bun;
    else globalThis.Bun = previousBun;
    if (previousHookPath === undefined) delete process.env.TILLER_ACTIVITY_HOOK_PATH;
    else process.env.TILLER_ACTIVITY_HOOK_PATH = previousHookPath;
  }
});
