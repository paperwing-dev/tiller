import type { Harness } from "../harness.js";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Provider stdout is parsed locally. Concise tool/command activity and
// user-facing assistant commentary may be surfaced while the run is active;
// provider session ids and final output stay local.

export interface ParsedPlannerLine {
  activity?: string;
  assistantText?: string;
  commentary?: string;
  /** Codex exec omits message phase; a later work item proves this was commentary. */
  commentaryCandidate?: string;
  sessionId?: string;
}

function shortActivityTarget(input: unknown): string {
  if (!isRecord(input)) return "";
  const target = input.file_path
    ?? input.filePath
    ?? input.path
    ?? input.pattern
    ?? input.command
    ?? input.cmd
    ?? input.query
    ?? input.url;
  return typeof target === "string" ? target.trim().slice(0, 160) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filesystemPath(value: string): string {
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

function isWithinCheckout(path: string, checkoutDir: string): boolean {
  const root = resolve(checkoutDir);
  const target = resolve(root, filesystemPath(path));
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function inputPath(
  input: unknown,
  checkoutDir: string,
  options: { defaultToCheckout?: boolean } = {},
): boolean {
  if (!isRecord(input)) return Boolean(options.defaultToCheckout);
  const candidate = input.file_path ?? input.filePath ?? input.path ?? input.cwd ?? input.workdir;
  if (candidate === undefined || candidate === null || candidate === "") {
    return Boolean(options.defaultToCheckout);
  }
  return typeof candidate === "string" && isWithinCheckout(candidate, checkoutDir);
}

const REPOSITORY_COMMAND = /(?:^|(?:&&|\|\||;|\|)\s*)(?:rg|grep|cat|head|tail|less|awk|find|ls|sed\b|git\s+(?:diff|show|grep|ls-files)\b)/iu;

function isRepositoryInspectionCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  // Codex CLI's JSON stream uses the shlex-joined process argv, commonly
  // `/bin/bash -lc 'rg ...'`, rather than only the model-authored command.
  const shellWrapped = trimmed.match(
    /^(?:\S*\/)?(?:bash|dash|sh|zsh)\s+-[a-z]*c\s+(["'])([\s\S]*)\1$/iu,
  );
  return REPOSITORY_COMMAND.test(shellWrapped?.[2]?.trim() ?? trimmed);
}

function inspectionToolInput(
  name: unknown,
  input: unknown,
  checkoutDir: string,
): boolean {
  if (typeof name !== "string") return false;
  switch (name.toLowerCase()) {
    case "read":
      return inputPath(input, checkoutDir);
    case "grep":
    case "glob":
    case "list":
    case "listfiles":
    case "search":
      return inputPath(input, checkoutDir, { defaultToCheckout: true });
    default:
      return false;
  }
}

function inspectionToolCall(
  name: unknown,
  input: unknown,
  checkoutDir: string,
): boolean {
  if (inspectionToolInput(name, input, checkoutDir)) return true;
  return typeof name === "string"
    && (name.toLowerCase() === "bash" || name.toLowerCase() === "shell")
    && isRecord(input)
    && inputPath(input, checkoutDir, { defaultToCheckout: true })
    && isRepositoryInspectionCommand(input.command);
}

function claudeAssistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: string; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function textFromContentParts(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

function opencodeSessionId(parsed: Record<string, unknown>): string {
  for (const key of ["sessionID", "sessionId", "session_id"]) {
    if (typeof parsed[key] === "string" && parsed[key]) return parsed[key] as string;
  }
  const session = parsed.session;
  if (isRecord(session)) {
    for (const key of ["id", "sessionID", "sessionId", "session_id"]) {
      if (typeof session[key] === "string" && session[key]) return session[key] as string;
    }
  }
  if (/session/i.test(String(parsed.type ?? "")) && typeof parsed.id === "string" && parsed.id) {
    return parsed.id;
  }
  return "";
}

function opencodeAssistantText(parsed: Record<string, unknown>): string {
  if (parsed.role === "assistant") {
    return textFromContentParts(parsed.text ?? parsed.content ?? parsed.parts);
  }
  const message = parsed.message;
  if (isRecord(message) && message.role === "assistant") {
    return textFromContentParts(message.text ?? message.content ?? message.parts);
  }
  const part = parsed.part;
  if (isRecord(part) && (part.type === "text" || part.type === "message") && typeof part.text === "string") {
    return part.text.trim();
  }
  if (typeof parsed.text === "string" && /assistant/i.test(String(parsed.type ?? ""))) {
    return parsed.text.trim();
  }
  return "";
}

function opencodeActivity(parsed: Record<string, unknown>): string {
  const tool = parsed.tool ?? parsed.call ?? parsed.part;
  if (!isRecord(tool)) return "";
  const name = typeof tool.name === "string"
    ? tool.name
    : typeof tool.tool === "string"
      ? tool.tool
      : "";
  if (!name) return "";
  const state = isRecord(tool.state) ? tool.state : null;
  const target = shortActivityTarget(state?.input ?? tool.input ?? tool.args ?? tool);
  return target ? `${name}: ${target}` : name;
}

function shortText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 160) : "";
}

/** Normalize Codex CLI and app-server work items into the same public activity. */
export function codexItemActivity(item: unknown): string | null {
  if (!isRecord(item)) return null;
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "commandExecution" || type === "command_execution") {
    const command = shortText(item.command);
    return command ? `Running: ${command}` : "Running a command";
  }
  if (type === "mcpToolCall" || type === "mcp_tool_call" || type === "dynamicToolCall" || type === "dynamic_tool_call") {
    const server = shortText(item.server ?? item.serverName);
    const tool = shortText(item.tool ?? item.toolName ?? item.name);
    const label = [server, tool].filter(Boolean).join(".");
    return label ? `Using ${label}` : "Using a tool";
  }
  if (type === "webSearch" || type === "web_search") {
    const query = shortText(item.query);
    return query ? `Searching: ${query}` : "Searching the web";
  }
  if (type === "imageView" || type === "image_view") {
    const path = shortText(item.path ?? item.filePath ?? item.file_path);
    return path ? `Viewing image: ${path}` : "Viewing an image";
  }
  if (type === "fileChange" || type === "file_change") {
    const path = shortText(item.path ?? item.filePath ?? item.file_path);
    return path ? `Editing: ${path}` : "Editing files";
  }
  if (type === "reasoning") return "Thinking";
  return null;
}

export function parsePlannerLine(harness: Harness, line: string): ParsedPlannerLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (harness === "opencode") {
    const sessionId = opencodeSessionId(parsed);
    const assistantText = opencodeAssistantText(parsed);
    const activity = opencodeActivity(parsed);
    if (assistantText || activity) {
      return {
        ...(assistantText ? { assistantText } : {}),
        ...(assistantText ? { commentary: assistantText } : {}),
        ...(activity ? { activity } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    }
    return sessionId ? { sessionId } : null;
  }

  if (parsed.type === "assistant") {
    const assistantText = claudeAssistantText(parsed.message);
    const message = parsed.message;
    const toolUse = isRecord(message) && Array.isArray(message.content)
      ? message.content.find((part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "tool_use" && typeof part.name === "string")
      : null;
    const target = toolUse ? shortActivityTarget(toolUse.input) : "";
    const activity = toolUse
      ? target ? `${toolUse.name as string}: ${target}` : toolUse.name as string
      : "";
    return assistantText || activity
      ? {
          ...(assistantText ? { assistantText, commentary: assistantText } : {}),
          ...(activity ? { activity } : {}),
        }
      : null;
  }
  if (parsed.type === "result" && typeof parsed.result === "string" && parsed.result.trim()) {
    return { assistantText: parsed.result.trim() };
  }
  if (parsed.type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string" && parsed.session_id) {
    return { sessionId: parsed.session_id };
  }
  if (parsed.type === "item.completed") {
    const item = parsed.item;
    if (isRecord(item) && item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
      const assistantText = item.text.trim();
      return {
        assistantText,
        ...(item.phase === "commentary" ? { commentary: assistantText } : {}),
        ...(item.phase === undefined || item.phase === null
          ? { commentaryCandidate: assistantText }
          : {}),
      };
    }
    if (isRecord(item) && item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
      // codex exec's ReasoningItem.text is the joined user-facing reasoning
      // summary. The raw reasoning content is not part of this JSONL schema.
      return { commentary: item.text.trim() };
    }
    return null;
  }
  if (parsed.type === "item.started") {
    const activity = codexItemActivity(parsed.item);
    return activity ? { activity } : null;
  }
  if (parsed.type === "thread.started" && typeof parsed.thread_id === "string" && parsed.thread_id) {
    return { sessionId: parsed.thread_id };
  }

  return null;
}

export class PlannerOutputTracker {
  finalFallbackText: string | null = null;
  providerSessionId: string | null = null;
  hasSuccessfulRepositoryInspection = false;
  private lastActivity: string | null = null;
  private lastCommentary: string | null = null;
  private pendingCodexCommentary: string | null = null;
  private readonly pendingClaudeInspections = new Set<string>();

  constructor(
    private readonly harness: Harness,
    private readonly onActivity?: (message: string) => void,
    private readonly checkoutDir?: string,
    private readonly onCommentary?: (message: string) => void,
  ) {}

  handleLine(line: string): void {
    this.observeRepositoryInspection(line);
    const parsed = parsePlannerLine(this.harness, line);
    if (!parsed) return;
    if (parsed.sessionId) this.providerSessionId = parsed.sessionId;
    if (parsed.assistantText) this.finalFallbackText = parsed.assistantText;
    if (parsed.commentaryCandidate) {
      this.pendingCodexCommentary = parsed.commentaryCandidate;
    } else if (parsed.commentary || parsed.activity) {
      // An unphased Codex agent message followed by more work cannot have
      // been the final answer. Publish it now; leave the last message pending
      // forever so final fallback prose never leaks into live commentary.
      this.publishCommentary(this.pendingCodexCommentary);
      this.pendingCodexCommentary = null;
    }
    this.publishCommentary(parsed.commentary);
    if (parsed.activity && parsed.activity !== this.lastActivity) {
      this.lastActivity = parsed.activity;
      this.onActivity?.(parsed.activity);
    }
  }

  private publishCommentary(message: string | null | undefined): void {
    if (!message || message === this.lastCommentary) return;
    this.lastCommentary = message;
    this.onCommentary?.(message);
  }

  private observeRepositoryInspection(line: string): void {
    if (!this.checkoutDir || this.hasSuccessfulRepositoryInspection) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (this.harness === "codex") {
      if (parsed.type !== "item.completed" || !isRecord(parsed.item)) return;
      const item = parsed.item;
      this.hasSuccessfulRepositoryInspection = item.type === "command_execution"
        && item.status === "completed"
        && item.exit_code === 0
        && isRepositoryInspectionCommand(item.command);
      return;
    }

    if (this.harness === "opencode") {
      if (parsed.type !== "tool_use" || !isRecord(parsed.part)) return;
      const part = parsed.part;
      if (part.type !== "tool" || !isRecord(part.state) || part.state.status !== "completed") return;
      const state = part.state;
      if (inspectionToolInput(part.tool, state.input, this.checkoutDir)) {
        this.hasSuccessfulRepositoryInspection = true;
        return;
      }
      if ((part.tool === "bash" || part.tool === "shell") && isRecord(state.metadata)) {
        this.hasSuccessfulRepositoryInspection = state.metadata.exit === 0
          && isRepositoryInspectionCommand(isRecord(state.input) ? state.input.command : undefined);
      }
      return;
    }

    if (parsed.type === "assistant" && isRecord(parsed.message) && Array.isArray(parsed.message.content)) {
      for (const part of parsed.message.content) {
        if (
          isRecord(part)
          && part.type === "tool_use"
          && typeof part.id === "string"
          && inspectionToolCall(part.name, part.input, this.checkoutDir)
        ) this.pendingClaudeInspections.add(part.id);
      }
      return;
    }
    if (parsed.type === "user" && isRecord(parsed.message) && Array.isArray(parsed.message.content)) {
      for (const part of parsed.message.content) {
        if (
          isRecord(part)
          && part.type === "tool_result"
          && typeof part.tool_use_id === "string"
          && part.is_error !== true
          && this.pendingClaudeInspections.delete(part.tool_use_id)
        ) {
          this.hasSuccessfulRepositoryInspection = true;
          return;
        }
      }
    }
  }
}
