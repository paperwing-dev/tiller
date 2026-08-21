import type { PlannerRunContext } from "./hub-callback.js";

// One-shot reviewer prompts. Plan Writer prompt/context management belongs to
// the native TUI adapter supervisor, not this disposable execution path.

const REPO_RULES = [
  "Rules:",
  "- The repository is checked out read-only in your current working directory. Read any files you need.",
  "- Do not modify, create, or delete any files inside the repository checkout.",
  "- Give brief, user-facing progress updates as you inspect and when your understanding changes. Summarize intent and conclusions; do not expose private chain-of-thought.",
].join("\n");

function renderTranscript(messages: PlannerRunContext["threadMessages"], truncated = false): string {
  const lines = messages
    .map((message) => {
      const body = message.body as { role?: string; text?: string } | undefined;
      if (!body || typeof body.text !== "string" || !body.text.trim()) return null;
      return `${body.role === "assistant" ? "Assistant" : "User"}: ${body.text.trim()}`;
    })
    .filter((line): line is string => Boolean(line));
  if (truncated) lines.unshift("[Earlier eligible reviewer messages were omitted by the context window.]");
  return lines.length > 0 ? lines.join("\n\n") : "(no prior messages)";
}

export interface ReviewerChatPromptOptions {
  plan: PlannerRunContext["plan"];
  skillInstructions: string;
  threadMessages: PlannerRunContext["threadMessages"];
  threadMessagesTruncated?: boolean;
  instruction: string;
  outputFile?: string;
}

function renderOptionalReviewerInstructions(skillInstructions: string): string[] {
  const trimmed = skillInstructions.trim();
  return trimmed ? ["## Reviewer instructions", "", trimmed, ""] : [];
}

// Conversational reviewer turn: the transcript comes from the Tiller thread
// (budget-windowed by the hub), never from provider session state.
export function buildReviewerChatPrompt(options: ReviewerChatPromptOptions): string {
  const deliveryRules = options.outputFile
    ? [
        `- The only file you may write is the output file: ${options.outputFile}`,
        `- Write your complete reply to the user's latest message as plain text to ${options.outputFile}.`,
      ]
    : [
        "- Do not write or modify any files.",
        "- Return your complete reply to the user's latest message in your final answer.",
      ];
  return [
    "You are responding in a reviewer thread for this repository, continuing a conversation with the user about the plan below.",
    "",
    REPO_RULES,
    ...deliveryRules,
    "",
    ...renderOptionalReviewerInstructions(options.skillInstructions),
    `## Plan under review: ${options.plan.title || "Untitled plan"}`,
    "",
    options.plan.markdown.trim(),
    "",
    "## Conversation so far",
    "",
    renderTranscript(options.threadMessages, options.threadMessagesTruncated),
    "",
    "## Latest user message — reply to this",
    "",
    options.instruction.trim(),
  ].join("\n");
}

export interface ReviewerPromptOptions {
  plan: PlannerRunContext["plan"];
  skillInstructions: string;
  outputFile?: string;
}

export function buildReviewerPrompt(options: ReviewerPromptOptions): string {
  const skillInstructions = options.skillInstructions.trim();
  if (!skillInstructions) {
    throw new Error("Reviewer prompt requires skill instructions or a user instruction.");
  }
  const deliveryRules = options.outputFile
    ? [
        `- The only file you may write is the output file: ${options.outputFile}`,
        `- When you are done, write your complete response as plain text to ${options.outputFile}.`,
      ]
    : [
        "- Do not write or modify any files.",
        "- Return your complete response in your final answer.",
      ];
  return [
    "You are responding in a reviewer run for this repository. Follow the reviewer instructions below.",
    "",
    REPO_RULES,
    ...deliveryRules,
    "",
    "## Reviewer instructions",
    "",
    skillInstructions,
    "",
    `## Plan under review: ${options.plan.title || "Untitled plan"}`,
    "",
    options.plan.markdown.trim(),
  ].join("\n");
}
