import type { PlanWriterTurnLifecycle } from "./activity.js";

export type OpenCodeHookMessage =
  | { type: "ready" }
  | {
      type: "bind";
      sessionId: string;
      agent: string;
      providerId: string;
      modelId: string;
      variant: string;
    }
  | {
      type: "activity";
      sessionId: string;
      state: "busy" | "retry" | "idle";
    }
  | {
      type: "publish";
      sessionId: string;
      callID: string;
      markdown: string;
    };

export type OpenCodeHookAction =
  | { kind: "ready" }
  | { kind: "bound"; sessionId: string }
  | {
      kind: "activity";
      lifecycle: PlanWriterTurnLifecycle;
      sessionId: string;
    }
  | { kind: "publication"; sessionId: string; callID: string; markdown: string }
  | { kind: "violation"; message: string };

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Authoritative supervisor-side fence for one socket-scoped OpenCode generation. */
export class OpenCodeGenerationFence {
  private sessionId: string | null = null;

  constructor(
    private readonly expected: {
      agent: string;
      providerId: string;
      modelId: string;
      variant: string;
    },
  ) {}

  get boundSessionId(): string | null {
    return this.sessionId;
  }

  accept(raw: Record<string, unknown>): OpenCodeHookAction {
    const type = stringField(raw.type);
    if (type === "ready") return { kind: "ready" };

    if (type === "bind") {
      const sessionId = stringField(raw.sessionId);
      const agent = stringField(raw.agent);
      const providerId = stringField(raw.providerId);
      const modelId = stringField(raw.modelId);
      const variant = stringField(raw.variant);
      if (!sessionId || !agent || !providerId || !modelId || !variant) {
        return {
          kind: "violation",
          message: "OpenCode omitted its complete chat identity.",
        };
      }
      if (agent !== this.expected.agent) {
        return {
          kind: "violation",
          message: `OpenCode changed agent from ${this.expected.agent} to ${agent}.`,
        };
      }
      if (providerId !== this.expected.providerId) {
        return {
          kind: "violation",
          message: `OpenCode changed provider from ${this.expected.providerId} to ${providerId}.`,
        };
      }
      if (modelId !== this.expected.modelId) {
        return {
          kind: "violation",
          message: `OpenCode changed model from ${this.expected.modelId} to ${modelId}.`,
        };
      }
      if (variant !== this.expected.variant) {
        return {
          kind: "violation",
          message: `OpenCode changed reasoning effort from ${this.expected.variant} to ${variant}.`,
        };
      }
      if (this.sessionId && this.sessionId !== sessionId) {
        return {
          kind: "violation",
          message:
            "OpenCode created a second session for one writer generation.",
        };
      }
      this.sessionId ??= sessionId;
      return { kind: "bound", sessionId };
    }

    if (type !== "activity" && type !== "publish") {
      return {
        kind: "violation",
        message: `Unknown OpenCode hook message: ${type || "(missing)"}.`,
      };
    }

    const sessionId = stringField(raw.sessionId);
    if (!sessionId || !this.sessionId || sessionId !== this.sessionId) {
      return {
        kind: "violation",
        message: "OpenCode activity escaped the generation's bound session.",
      };
    }

    if (type === "activity") {
      if (
        raw.state !== "busy" &&
        raw.state !== "retry" &&
        raw.state !== "idle"
      ) {
        return {
          kind: "violation",
          message: "OpenCode reported an unknown activity state.",
        };
      }
      return {
        kind: "activity",
        lifecycle: raw.state === "idle" ? "settled" : "started",
        sessionId,
      };
    }

    const callID = stringField(raw.callID);
    if (!callID)
      return {
        kind: "violation",
        message: "OpenCode publish_plan omitted its runtime callID.",
      };
    if (typeof raw.markdown !== "string") {
      return {
        kind: "violation",
        message: "OpenCode publish_plan omitted Markdown.",
      };
    }
    return { kind: "publication", sessionId, callID, markdown: raw.markdown };
  }
}
