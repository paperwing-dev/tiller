const BRACKETED_PASTE_END = /\u001b\[201~/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export const MAX_CONTRIBUTION_INSERT_BYTES = 64 * 1024;

export function sanitizeContributionInsert(text: string): string {
  const sanitized = text.replace(BRACKETED_PASTE_END, "").replace(CONTROL_CHARACTERS, "");
  const bytes = Buffer.from(sanitized, "utf8");
  if (bytes.byteLength <= MAX_CONTRIBUTION_INSERT_BYTES) return sanitized;
  return bytes.subarray(0, MAX_CONTRIBUTION_INSERT_BYTES).toString("utf8").replace(/\uFFFD$/u, "");
}

export function bracketedPasteWithoutEnter(text: string): string {
  return `\u001b[200~${sanitizeContributionInsert(text)}\u001b[201~`;
}

const UNSUPPORTED_CONVERSATION_COMMAND = /(?:^|[\r\n])[\t ]*\/(?:new|resume|fork|clear|branch|permissions?|sandbox)(?:[\t ]|[\r\n]|$)/iu;

export function containsUnsupportedConversationCommand(inputBuffer: string): boolean {
  // Pasted reviewer text is literal composer content, not a native slash
  // command. Ignore complete and in-progress bracketed-paste payloads.
  const typedInput = inputBuffer.replace(/\u001b\[200~[\s\S]*?(?:\u001b\[201~|$)/gu, "");
  return UNSUPPORTED_CONVERSATION_COMMAND.test(typedInput);
}
