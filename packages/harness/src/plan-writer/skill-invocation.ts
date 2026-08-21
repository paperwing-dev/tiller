import { randomUUID } from "node:crypto";

export function planWriterSkillStartedReason(skill: {
  id: string;
  command: string;
}): string {
  return skill.id === "plan-health"
    ? `/${skill.command} started. Its immutable result will appear in Tiller.`
    : `/${skill.command} started. Its result will appear in Tiller.`;
}

/** Keeps one idempotency key per pending Scribe command until Hub confirms it. */
export class PlanWriterSkillRequestIds {
  private readonly pending = new Map<string, string>();

  constructor(
    private readonly generation: number,
    private readonly createId: () => string = randomUUID,
  ) {}

  acquire(command: string): string {
    const existing = this.pending.get(command);
    if (existing) return existing;
    const requestId = `plan-writer-skill:${this.generation}:${this.createId()}`;
    this.pending.set(command, requestId);
    return requestId;
  }

  confirm(command: string, requestId: string): void {
    if (this.pending.get(command) === requestId) {
      this.pending.delete(command);
    }
  }
}
