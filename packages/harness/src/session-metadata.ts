export interface SessionMetadataInput {
  cwd: string;
  host: string;
  platform: NodeJS.Platform;
  harness: string;
  repoSlug?: string;
  backend?: string;
  runnerId?: string;
  repoUrl?: string;
  teamName?: string;
  roleName?: string;
}

export interface SessionMetadata {
  cwd: string;
  host: string;
  platform: string;
  harness?: string;
  envSlug?: string;
  backend?: string;
  runnerId?: string;
  repoUrl?: string;
  team?: string;
  role?: string;
}

export function buildSessionMetadata(input: SessionMetadataInput): SessionMetadata {
  return {
    cwd: input.cwd,
    host: input.host,
    platform: input.platform,
    harness: input.harness,
    envSlug: input.repoSlug,
    backend: input.backend,
    runnerId: input.runnerId,
    repoUrl: input.repoUrl,
    ...(input.teamName ? { team: input.teamName } : {}),
    ...(input.roleName ? { role: input.roleName } : {}),
  };
}
