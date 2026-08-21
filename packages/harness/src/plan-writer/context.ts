import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlanWriterContext } from "./contract.js";
import { repoPlansEnabled } from "./repo-plans.js";

export function normalizePlanMarkdown(markdown: string): string {
  const lineNormalized = markdown.replace(/\r\n?/g, "\n");
  if (!lineNormalized.trim()) return "";
  const normalized = lineNormalized.replace(/(?:\n[ \t]*)+$/u, "");
  return normalized ? `${normalized}\n` : "";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function renderManagedPlanWriterContext(
  context: PlanWriterContext,
): string {
  const repoPlanInstructions = repoPlansEnabled(context)
    ? [
        "- The only MCP server available in this runtime is the managed `tiller_plans` server. Repository and user MCP entries and hooks remain unavailable.",
        "- `tiller_plans` exposes only `list_plans`, `read_plan`, `create_plan`, and `update_plan` for plans in this repository.",
        "- Use `create_plan` or `update_plan` only when the user explicitly asks to create, split, or update a repository plan.",
        "- Never use `update_plan` for this Scribe's owned plan. Publish changes to the owned plan through the provider's native managed Plan Mode path.",
      ]
    : [
        "- MCP servers and repository or user hooks are unavailable in this runtime.",
      ];
  const skills =
    context.skills.length > 0
      ? [
          "## Plan Skills",
          "",
          "Invoke a listed command as its own user prompt. Tiller runs it against the current selected plan.",
          ...context.skills.map(
            (skill) =>
              `- /${skill.command} — ${skill.description || skill.label}`,
          ),
          "",
        ]
      : [];
  return [
    "# Tiller Managed Plan Writer Context",
    "",
    `Plan: ${context.plan.title || "Untitled plan"}`,
    `Status: ${context.plan.status}`,
    `Frozen basis commit: ${context.writer.basisCommit}`,
    `Provider conversation owner: ${context.writer.provider} / generation ${context.writer.generation}`,
    `Canonical body SHA-256: ${context.plan.digest}`,
    "",
    "## Planning contract",
    "",
    ...context.instructions.map((instruction) => `- ${instruction}`),
    "- The checkout is read-only. Do not attempt to modify repository files.",
    ...repoPlanInstructions,
    "",
    ...skills,
    "## Plan format",
    "",
    context.planFormat.trim(),
    "",
    "## Current canonical plan",
    "",
    context.plan.markdown.trimEnd(),
    "",
  ].join("\n");
}

/** Preserve every process-launch projection while refreshing mutable plan state. */
export function mergeRefreshedPlanWriterContext(
  frozen: PlanWriterContext,
  refreshed: PlanWriterContext,
): PlanWriterContext {
  return {
    ...refreshed,
    planFormat: frozen.planFormat,
    instructions: frozen.instructions,
    skills: frozen.skills,
    capabilities: frozen.capabilities,
  };
}

export function writeManagedPlanWriterContext(
  path: string,
  context: PlanWriterContext,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.context-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, renderManagedPlanWriterContext(context), { encoding: "utf8", mode: 0o444 });
  chmodSync(temporary, 0o444);
  renameSync(temporary, path);
}
