import test from "node:test";
import assert from "node:assert/strict";
import { TerminalResizeHandoff } from "../dist/terminal-resize-handoff.js";

function resizeTarget(events) {
  return {
    async resize(cols, rows) {
      events.push([cols, rows]);
    },
  };
}

test("startup resizes are acknowledged and the latest size reaches the attached PTY", async () => {
  const events = [];
  const handoff = new TerminalResizeHandoff();

  await handoff.resize(80, 24);
  await handoff.resize(120, 40);
  await handoff.attach(resizeTarget(events));

  assert.deepEqual(events, [[120, 40]]);
});

test("resizes go directly to the active PTY and defer again between generations", async () => {
  const firstEvents = [];
  const secondEvents = [];
  const first = resizeTarget(firstEvents);
  const second = resizeTarget(secondEvents);
  const handoff = new TerminalResizeHandoff();

  await handoff.attach(first);
  await handoff.resize(100, 30);
  handoff.detach(first);
  await handoff.resize(140, 50);
  await handoff.attach(second);

  assert.deepEqual(firstEvents, [[100, 30]]);
  assert.deepEqual(secondEvents, [[140, 50]]);
});

test("detaching a stale PTY does not displace its replacement", async () => {
  const first = resizeTarget([]);
  const secondEvents = [];
  const second = resizeTarget(secondEvents);
  const handoff = new TerminalResizeHandoff();

  await handoff.attach(first);
  await handoff.attach(second);
  handoff.detach(first);
  await handoff.resize(132, 44);

  assert.deepEqual(secondEvents, [[132, 44]]);
});
