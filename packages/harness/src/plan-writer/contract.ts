export type PlanWriterProvider = "claude-code" | "codex" | "opencode";
export const PLAN_WRITER_PROTOCOL_VERSION = 2 as const;
export const PLAN_MARKDOWN_NORMALIZATION_VERSION = 1 as const;

export interface PlanWriterIdentity {
  protocolVersion: typeof PLAN_WRITER_PROTOCOL_VERSION;
  repoId: string;
  planArtifactId: string;
  generation: number;
  basisCommit: string;
  terminalId: string;
  provider: PlanWriterProvider;
  model: string;
  effort?: string;
  fastMode?: boolean;
  publicationCursor?: PublicationCursor | null;
}

export interface PlanWriterContext {
  writer: PlanWriterIdentity;
  plan: {
    normalizationVersion: typeof PLAN_MARKDOWN_NORMALIZATION_VERSION;
    title: string;
    status: string;
    markdown: string;
    digest: string;
  };
  planFormat: string;
  instructions: string[];
  skills: PlanWriterSkillDefinition[];
  capabilities?: { repoPlansV1?: true };
}

export interface PlanWriterSkillDefinition {
  id: string;
  command: string;
  label: string;
  description: string;
  sharedInstructions: string;
  agents: Array<{
    id: string;
    label: string;
    routeKey: string;
    effort: string;
    instructions: string;
    reportMode: "auto" | "manual";
  }>;
}

export interface PublicationCursor {
  sequence: number;
  providerEventId: string;
  bodyDigest: string;
  artifactVersion: number;
  result: "updated" | "unchanged";
}

export interface NativeTuiLaunch {
  command: string;
  args: string[];
  conversationId: string;
  env: Record<string, string>;
  /** Initializes provider-owned TUI state after the PTY is created and before the writer is registered. */
  initializeTui?: (writeInput: (data: string) => Promise<void>) => Promise<void>;
  afterExit?: () => Promise<void>;
}
