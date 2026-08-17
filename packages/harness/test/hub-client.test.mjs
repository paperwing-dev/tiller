import test from "node:test";
import assert from "node:assert/strict";
import { HubClient } from "../dist/hub-client.js";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type, event = {}) {
    if (type === "open") {
      this.readyState = FakeWebSocket.OPEN;
    }
    if (type === "close") {
      this.readyState = FakeWebSocket.CLOSED;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("registers without replay on first open before draining queued messages", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.lastSeq = 3;
  client.pendingMessages.push(JSON.stringify({
    type: "message",
    id: "queued-1",
    sessionId: "session-1",
    content: { type: "queued" },
  }));

  client.openWs();
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, "expected the client to create a websocket");

  ws.emit("open");

  const sent = ws.sent.map((payload) => JSON.parse(payload));
  const { registrationId, ...registration } = sent[0];
  assert.match(registrationId, /^baseline-\d+$/);
  assert.deepEqual(registration, {
    type: "reconnect",
    lastSeq: 3,
    sessionId: "session-1",
    revive: true,
    replay: false,
    terminalOperationProtocol: 1,
  });
  assert.deepEqual(sent[1], {
    type: "message",
    id: "queued-1",
    sessionId: "session-1",
    content: { type: "queued" },
  });
});

test("keeps replay disabled until Hub acknowledges a canonical baseline", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const first = FakeWebSocket.instances.at(-1);
  first.emit("open");

  client.openWs();
  const second = FakeWebSocket.instances.at(-1);
  second.emit("open");
  const secondRegistration = JSON.parse(second.sent[0]);

  second.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 7,
      sessionId: "session-1",
      registrationId: secondRegistration.registrationId,
    }),
  });

  client.openWs();
  const third = FakeWebSocket.instances.at(-1);
  third.emit("open");

  const { registrationId: firstRegistrationId, ...firstRegistration } = JSON.parse(first.sent[0]);
  assert.match(firstRegistrationId, /^baseline-\d+$/);
  assert.deepEqual(firstRegistration, {
    type: "reconnect",
    lastSeq: 0,
    sessionId: "session-1",
    revive: true,
    replay: false,
    terminalOperationProtocol: 1,
  });
  const { registrationId: secondRegistrationId, ...secondRegistrationWithoutId } = secondRegistration;
  assert.match(secondRegistrationId, /^baseline-\d+$/);
  assert.notEqual(secondRegistrationId, firstRegistrationId);
  assert.deepEqual(secondRegistrationWithoutId, {
    type: "reconnect",
    lastSeq: 0,
    sessionId: "session-1",
    revive: true,
    replay: false,
    terminalOperationProtocol: 1,
  });
  const { registrationId: replayRegistrationId, ...replayRegistration } = JSON.parse(third.sent[0]);
  assert.match(replayRegistrationId, /^replay-\d+$/);
  assert.deepEqual(replayRegistration, {
    type: "reconnect",
    lastSeq: 7,
    sessionId: "session-1",
    revive: true,
    replay: true,
    terminalOperationProtocol: 1,
  });
});

test("ignores message events for other sessions", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");

  const seen = [];
  client.on("message-received", (msg) => {
    seen.push(msg);
  });

  client.openWs();
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, "expected the client to create a websocket");

  ws.emit("message", {
    data: JSON.stringify({
      type: "message-received",
      id: "wrong-session",
      sessionId: "session-2",
      seq: 9,
      content: { type: "user-input", data: "wrong-session" },
    }),
  });

  ws.emit("message", {
    data: JSON.stringify({
      type: "message-received",
      id: "right-session",
      sessionId: "session-1",
      seq: 10,
      content: { type: "user-input", data: "right-session" },
    }),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, "session-1");
  assert.equal(client.lastSeq, 10);
});

test("ignores unacknowledged replay and accepts only a correlated replay page", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");

  const seen = [];
  client.on("message-received", (msg) => {
    seen.push(msg);
  });

  client.openWs();
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, "expected the client to create a websocket");
  ws.emit("open");
  const registration = JSON.parse(ws.sent[0]);

  ws.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [
        {
          type: "message-received",
          sessionId: "session-2",
          seq: 9,
          content: { type: "user-input", data: "wrong-session" },
        },
        {
          type: "message-received",
          sessionId: "session-1",
          seq: 10,
          content: { type: "user-input", data: "right-session" },
        },
      ],
    }),
  });

  assert.equal(seen.length, 0);
  assert.equal(client.lastSeq, 0);

  ws.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 7,
      sessionId: "session-1",
      registrationId: registration.registrationId,
    }),
  });

  client.openWs();
  const replaySocket = FakeWebSocket.instances.at(-1);
  replaySocket.emit("open");
  const replayRegistration = JSON.parse(replaySocket.sent[0]);

  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      sessionId: "session-1",
      registrationId: replayRegistration.registrationId,
      events: [
        {
          type: "message-received",
          sessionId: "session-1",
          id: "right-session",
          seq: 8,
          content: { type: "user-input", data: "right-session" },
        },
      ],
    }),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, "session-1");
  assert.equal(client.lastSeq, 8);
});

test("ignores a stale baseline acknowledgement after a session change", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit("open");
  const firstRegistration = JSON.parse(ws.sent[0]);

  client.setSessionId("session-2");
  const secondRegistration = JSON.parse(ws.sent[1]);
  ws.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 99,
      sessionId: "session-1",
      registrationId: firstRegistration.registrationId,
    }),
  });

  assert.equal(client.lastSeq, 0);
  ws.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 4,
      sessionId: "session-2",
      registrationId: secondRegistration.registrationId,
    }),
  });

  client.openWs();
  const reconnected = FakeWebSocket.instances.at(-1);
  reconnected.emit("open");
  const { registrationId, ...reconnectRegistration } = JSON.parse(reconnected.sent[0]);
  assert.match(registrationId, /^replay-\d+$/);
  assert.deepEqual(reconnectRegistration, {
    type: "reconnect",
    lastSeq: 4,
    sessionId: "session-2",
    revive: true,
    replay: true,
    terminalOperationProtocol: 1,
  });
});

test("merges a racing live event with correlated replay and dispatches it once", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const baselineSocket = FakeWebSocket.instances.at(-1);
  baselineSocket.emit("open");
  const baselineRegistration = JSON.parse(baselineSocket.sent[0]);
  baselineSocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 5,
      sessionId: "session-1",
      registrationId: baselineRegistration.registrationId,
    }),
  });

  const seen = [];
  client.on("message-received", (message) => seen.push(message));
  client.openWs();
  const replaySocket = FakeWebSocket.instances.at(-1);
  replaySocket.emit("open");
  const replayRegistration = JSON.parse(replaySocket.sent[0]);
  const racing = {
    type: "message-received",
    id: "action-7",
    sessionId: "session-1",
    seq: 7,
    content: { type: "user-input", data: "once" },
  };

  replaySocket.emit("message", { data: JSON.stringify(racing) });
  assert.equal(seen.length, 0);
  assert.equal(client.lastSeq, 5);

  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      sessionId: "session-1",
      registrationId: replayRegistration.registrationId,
      events: [
        {
          type: "message-received",
          id: "output-6",
          sessionId: "session-1",
          seq: 6,
          content: { type: "terminal-output", data: "ignored by action handler" },
        },
        racing,
      ],
    }),
  });
  replaySocket.emit("message", { data: JSON.stringify(racing) });

  assert.deepEqual(seen.map((message) => message.id), ["output-6", "action-7"]);
  assert.equal(client.lastSeq, 7);
});

test("does not advance past a queued live event when reconnect drops before replay", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const baselineSocket = FakeWebSocket.instances.at(-1);
  baselineSocket.emit("open");
  const baselineRegistration = JSON.parse(baselineSocket.sent[0]);
  baselineSocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 5,
      sessionId: "session-1",
      registrationId: baselineRegistration.registrationId,
    }),
  });

  client.openWs();
  const interrupted = FakeWebSocket.instances.at(-1);
  interrupted.emit("open");
  interrupted.emit("message", {
    data: JSON.stringify({
      type: "message-received",
      id: "action-7",
      sessionId: "session-1",
      seq: 7,
      content: { type: "sync" },
    }),
  });
  interrupted.emit("close", { code: 1006, wasClean: false });

  assert.equal(client.lastSeq, 5);
  client.openWs();
  const retry = FakeWebSocket.instances.at(-1);
  retry.emit("open");
  const retryRegistration = JSON.parse(retry.sent[0]);
  assert.equal(retryRegistration.lastSeq, 5);
  assert.equal(retryRegistration.replay, true);
  assert.match(retryRegistration.registrationId, /^replay-\d+$/);
});

test("pages replay without allowing a queued later event to overtake", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const baselineSocket = FakeWebSocket.instances.at(-1);
  baselineSocket.emit("open");
  const baselineRegistration = JSON.parse(baselineSocket.sent[0]);
  baselineSocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 0,
      sessionId: "session-1",
      registrationId: baselineRegistration.registrationId,
    }),
  });

  const seen = [];
  client.on("message-received", (message) => seen.push(message.seq));
  client.openWs();
  const replaySocket = FakeWebSocket.instances.at(-1);
  replaySocket.emit("open");
  const firstPageRegistration = JSON.parse(replaySocket.sent[0]);
  const later = {
    type: "message-received",
    id: "message-1001",
    sessionId: "session-1",
    seq: 1001,
    content: { type: "sync" },
  };
  replaySocket.emit("message", { data: JSON.stringify(later) });

  const firstPage = Array.from({ length: 1000 }, (_, index) => ({
    type: "message-received",
    id: `message-${index + 1}`,
    sessionId: "session-1",
    seq: index + 1,
    content: { type: "terminal-output", data: "x" },
  }));
  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      sessionId: "session-1",
      registrationId: firstPageRegistration.registrationId,
      events: firstPage,
    }),
  });

  assert.equal(seen.length, 1000);
  assert.equal(client.lastSeq, 1000);
  const secondPageRegistration = JSON.parse(replaySocket.sent.at(-1));
  assert.equal(secondPageRegistration.lastSeq, 1000);
  assert.notEqual(secondPageRegistration.registrationId, firstPageRegistration.registrationId);

  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      sessionId: "session-1",
      registrationId: secondPageRegistration.registrationId,
      events: [later],
    }),
  });

  assert.equal(seen.length, 1001);
  assert.equal(seen.at(-1), 1001);
  assert.equal(client.lastSeq, 1001);
});

test("fails closed when live and replay payloads conflict", (t) => {
  const realWebSocket = globalThis.WebSocket;
  const realConsoleError = console.error;
  globalThis.WebSocket = FakeWebSocket;
  console.error = () => undefined;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    console.error = realConsoleError;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  client.openWs();
  const baselineSocket = FakeWebSocket.instances.at(-1);
  baselineSocket.emit("open");
  const baselineRegistration = JSON.parse(baselineSocket.sent[0]);
  baselineSocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      events: [],
      baselineSeq: 5,
      sessionId: "session-1",
      registrationId: baselineRegistration.registrationId,
    }),
  });

  const seen = [];
  client.on("message-received", (message) => seen.push(message));
  client.openWs();
  const replaySocket = FakeWebSocket.instances.at(-1);
  replaySocket.emit("open");
  const replayRegistration = JSON.parse(replaySocket.sent[0]);
  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "message-received",
      id: "action-6",
      sessionId: "session-1",
      seq: 6,
      content: { type: "user-input", data: "live" },
    }),
  });
  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "replay",
      sessionId: "session-1",
      registrationId: replayRegistration.registrationId,
      events: [{
        type: "message-received",
        id: "action-6",
        sessionId: "session-1",
        seq: 6,
        content: { type: "user-input", data: "conflict" },
      }],
    }),
  });
  replaySocket.emit("message", {
    data: JSON.stringify({
      type: "message-received",
      id: "late-action-6",
      sessionId: "session-1",
      seq: 6,
      content: { type: "sync" },
    }),
  });

  assert.equal(replaySocket.readyState, FakeWebSocket.CLOSED);
  assert.equal(seen.length, 0);
  assert.equal(client.lastSeq, 5);
});

test("emits terminal fast-lane events for the current session and sends ACKs live", (t) => {
  const realWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.instances.length = 0;

  const client = new HubClient({
    hubUrl: "https://hub.example.com",
    namespace: "demo",
    cfAccessHeaders: {},
  });

  t.after(() => {
    client.close();
    globalThis.WebSocket = realWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  client.setSessionId("session-1");
  const inputs = [];
  const controls = [];
  client.on("terminal-input", (msg) => inputs.push(msg));
  client.on("terminal-control", (msg) => controls.push(msg));

  client.openWs();
  const ws = FakeWebSocket.instances.at(-1);
  assert.ok(ws, "expected the client to create a websocket");
  ws.emit("open");

  ws.emit("message", {
    data: JSON.stringify({
      type: "terminal-input",
      sessionId: "session-2",
      clientId: "client-1",
      inputSeq: 1,
      data: "wrong",
    }),
  });
  ws.emit("message", {
    data: JSON.stringify({
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 2,
      data: "right",
    }),
  });
  ws.emit("message", {
    data: JSON.stringify({
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "abort",
    }),
  });

  assert.deepEqual(inputs, [
    {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 2,
      data: "right",
    },
  ]);
  assert.deepEqual(controls, [
    {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "abort",
    },
  ]);
  assert.equal(client.sendTerminalInputAck("session-1", "client-1", 2, true), true);
  assert.equal(client.sendTerminalControlAck("session-1", "client-1", 1, false, "bad"), true);
  assert.deepEqual(
    ws.sent.slice(-2).map((payload) => JSON.parse(payload)),
    [
      {
        type: "terminal-input-ack",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 2,
        ok: true,
      },
      {
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        ok: false,
        error: "bad",
      },
    ],
  );

  ws.readyState = FakeWebSocket.CLOSED;
  assert.equal(client.sendTerminalInputAck("session-1", "client-1", 3, true), false);
});
