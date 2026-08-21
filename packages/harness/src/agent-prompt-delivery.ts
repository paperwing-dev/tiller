export type AgentPromptDeliveryPhase =
  | "waiting"
  | "scheduled"
  | "delivered"
  | "invalidated";

interface AgentPromptDeliveryState {
  prompt: string;
  phase: AgentPromptDeliveryPhase;
}

type PromptSubmissionResult = { ok: true } | { ok: false; error: string };

/**
 * Tracks startup-plan prompt delivery for each spawned agent process.
 *
 * A WeakMap is deliberate: a replacement agent must never inherit the prompt
 * state of the process it replaced, and exited agents should remain
 * collectible once their listeners are released.
 */
export class AgentPromptDeliveryRegistry<TAgent extends object> {
  private readonly deliveries = new WeakMap<TAgent, AgentPromptDeliveryState>();

  register(agent: TAgent, prompt: string | null | undefined): void {
    const normalized = prompt?.trim() ?? "";
    if (!normalized) return;
    this.deliveries.set(agent, { prompt: normalized, phase: "waiting" });
  }

  registerDelivered(agent: TAgent): void {
    this.deliveries.set(agent, { prompt: "", phase: "delivered" });
  }

  schedule(agent: TAgent): string | null {
    const delivery = this.deliveries.get(agent);
    if (!delivery || delivery.phase !== "waiting") return null;
    delivery.phase = "scheduled";
    return delivery.prompt;
  }

  markDelivered(agent: TAgent): boolean {
    const delivery = this.deliveries.get(agent);
    if (!delivery || delivery.phase !== "scheduled") return false;
    delivery.phase = "delivered";
    return true;
  }

  submitScheduled(
    agent: TAgent,
    submit: (prompt: string, onComplete: (result: PromptSubmissionResult) => void) => void,
    isActive: () => boolean,
    onDelivered?: () => void,
  ): boolean {
    const delivery = this.deliveries.get(agent);
    if (!delivery || delivery.phase !== "scheduled" || !isActive()) return false;
    submit(delivery.prompt, (result) => {
      if (!result.ok || !isActive()) {
        this.invalidate(agent);
        return;
      }
      if (this.markDelivered(agent)) onDelivered?.();
    });
    return true;
  }

  isDelivered(agent: TAgent): boolean {
    return this.deliveries.get(agent)?.phase === "delivered";
  }

  invalidate(agent: TAgent): void {
    const delivery = this.deliveries.get(agent);
    if (delivery) delivery.phase = "invalidated";
  }

  phase(agent: TAgent): AgentPromptDeliveryPhase | null {
    return this.deliveries.get(agent)?.phase ?? null;
  }
}
