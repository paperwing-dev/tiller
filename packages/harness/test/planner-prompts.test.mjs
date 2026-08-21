import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewerChatPrompt, buildReviewerPrompt } from "../dist/planner/prompts.js";

const plan = { id: "p1", title: "Ship feature X", version: 3, markdown: "# Ship feature X\n\nSteps." };

test("reviewer prompt includes skill instructions and the output file", () => {
  const prompt = buildReviewerPrompt({
    plan,
    skillInstructions: "Common guidance.\n\nRole guidance.",
    outputFile: "/tmp/out/review.txt",
  });
  assert.equal(prompt, `You are responding in a reviewer run for this repository. Follow the reviewer instructions below.

Rules:
- The repository is checked out read-only in your current working directory. Read any files you need.
- Do not modify, create, or delete any files inside the repository checkout.
- Give brief, user-facing progress updates as you inspect and when your understanding changes. Summarize intent and conclusions; do not expose private chain-of-thought.
- The only file you may write is the output file: /tmp/out/review.txt
- When you are done, write your complete response as plain text to /tmp/out/review.txt.

## Reviewer instructions

Common guidance.

Role guidance.

## Plan under review: Ship feature X

# Ship feature X

Steps.`);
});

test("reviewer follow-up prompt snapshots the composed instructions, history marker, and output transport", () => {
  const prompt = buildReviewerChatPrompt({
    plan,
    skillInstructions: "Common guidance.\n\nRole guidance.",
    threadMessages: [
      { body: { role: "user", text: "Earlier question." } },
      { body: { role: "assistant", text: "Earlier answer." } },
    ],
    threadMessagesTruncated: true,
    instruction: "Check the rollback.",
    outputFile: "/tmp/out/review.txt",
  });
  assert.equal(prompt, `You are responding in a reviewer thread for this repository, continuing a conversation with the user about the plan below.

Rules:
- The repository is checked out read-only in your current working directory. Read any files you need.
- Do not modify, create, or delete any files inside the repository checkout.
- Give brief, user-facing progress updates as you inspect and when your understanding changes. Summarize intent and conclusions; do not expose private chain-of-thought.
- The only file you may write is the output file: /tmp/out/review.txt
- Write your complete reply to the user's latest message as plain text to /tmp/out/review.txt.

## Reviewer instructions

Common guidance.

Role guidance.

## Plan under review: Ship feature X

# Ship feature X

Steps.

## Conversation so far

[Earlier eligible reviewer messages were omitted by the context window.]

User: Earlier question.

Assistant: Earlier answer.

## Latest user message — reply to this

Check the rollback.`);
});

test("reviewer chat without a skill uses the user message without hidden reviewer instructions", () => {
  const prompt = buildReviewerChatPrompt({
    plan,
    skillInstructions: "",
    threadMessages: [],
    instruction: "Look only for rollback risks.",
    outputFile: "/tmp/out/review.txt",
  });
  assert.match(prompt, /Look only for rollback risks\./);
  assert.doesNotMatch(prompt, /## Reviewer instructions/);
  assert.doesNotMatch(prompt, /Review the plan for correctness, feasibility, and gaps/);
});

test("subscription reviewer prompts return the full response as the final answer", () => {
  const prompt = buildReviewerPrompt({
    plan,
    skillInstructions: "Review correctness.",
  });
  assert.match(prompt, /Return your complete response in your final answer/);
  assert.match(prompt, /Do not write or modify any files/);
  assert.doesNotMatch(prompt, /output file/);

  const chatPrompt = buildReviewerChatPrompt({
    plan,
    skillInstructions: "",
    threadMessages: [],
    instruction: "What should change?",
  });
  assert.match(chatPrompt, /Return your complete reply .* in your final answer/);
  assert.doesNotMatch(chatPrompt, /output file/);
});

test("one-shot reviewer prompt requires explicit skill instructions", () => {
  assert.throws(
    () => buildReviewerPrompt({ plan, skillInstructions: "", outputFile: "/tmp/out/review.txt" }),
    /requires skill instructions or a user instruction/,
  );
});
