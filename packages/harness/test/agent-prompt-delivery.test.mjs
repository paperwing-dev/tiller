import test from "node:test";
import assert from "node:assert/strict";
import { AgentPromptDeliveryRegistry } from "../dist/agent-prompt-delivery.js";
import { shouldArmScheduledRunIdleTimer } from "../dist/scheduled-run.js";

test("startup-plan delivery is isolated to each spawned agent", () => {
  const deliveries = new AgentPromptDeliveryRegistry();
  const initialAgent = {};
  const replacementAgent = {};

  deliveries.register(initialAgent, "fixed startup plan");
  assert.equal(deliveries.schedule(initialAgent), "fixed startup plan");
  assert.equal(deliveries.isDelivered(initialAgent), false);
  assert.equal(deliveries.schedule(initialAgent), null);

  deliveries.invalidate(initialAgent);
  deliveries.register(replacementAgent, "resume fixed startup plan");

  assert.equal(deliveries.markDelivered(initialAgent), false);
  assert.equal(deliveries.phase(initialAgent), "invalidated");
  assert.equal(deliveries.schedule(replacementAgent), "resume fixed startup plan");
  assert.equal(deliveries.isDelivered(replacementAgent), false);
  assert.equal(deliveries.markDelivered(replacementAgent), true);
  assert.equal(deliveries.isDelivered(replacementAgent), true);
});

test("an agent without a PTY-injected prompt never becomes delivered", () => {
  const deliveries = new AgentPromptDeliveryRegistry();
  const agent = {};

  deliveries.register(agent, undefined);

  assert.equal(deliveries.schedule(agent), null);
  assert.equal(deliveries.isDelivered(agent), false);
  assert.equal(deliveries.phase(agent), null);
});

test("a CLI-injected startup plan is recorded as delivered without PTY submission", () => {
  const deliveries = new AgentPromptDeliveryRegistry();
  const agent = {};

  deliveries.registerDelivered(agent);

  assert.equal(deliveries.schedule(agent), null);
  assert.equal(deliveries.isDelivered(agent), true);
  assert.equal(deliveries.phase(agent), "delivered");
  assert.equal(
    shouldArmScheduledRunIdleTimer("scheduled", deliveries.isDelivered(agent)),
    true,
  );
});

test("startup plans use submitted text and become delivered only after submission succeeds", () => {
  const deliveries = new AgentPromptDeliveryRegistry();
  const agent = {};
  const submissions = [];
  let completeSubmission;
  let deliveredCount = 0;
  const inputWriter = {
    enqueueSubmittedText(prompt, options) {
      submissions.push(prompt);
      completeSubmission = options.onComplete;
    },
  };

  deliveries.register(agent, "line one\nline two");
  assert.equal(deliveries.schedule(agent), "line one\nline two");
  assert.equal(deliveries.submitScheduled(
    agent,
    (prompt, onComplete) => inputWriter.enqueueSubmittedText(prompt, { onComplete }),
    () => true,
    () => { deliveredCount += 1; },
  ), true);

  assert.deepEqual(submissions, ["line one\nline two"]);
  assert.equal(deliveries.isDelivered(agent), false);
  assert.equal(deliveredCount, 0);

  completeSubmission({ ok: true });
  assert.equal(deliveries.isDelivered(agent), true);
  assert.equal(deliveredCount, 1);
});

test("a failed startup-plan Enter acknowledgement invalidates delivery", () => {
  const deliveries = new AgentPromptDeliveryRegistry();
  const agent = {};
  let completeSubmission;

  deliveries.register(agent, "plan");
  deliveries.schedule(agent);
  deliveries.submitScheduled(
    agent,
    (_prompt, onComplete) => { completeSubmission = onComplete; },
    () => true,
  );
  completeSubmission({ ok: false, error: "Enter failed" });

  assert.equal(deliveries.phase(agent), "invalidated");
  assert.equal(deliveries.isDelivered(agent), false);
});
