// Shared shape for planner provider command builders. Each provider module
// stays an args builder: no spawning, no callbacks.
export interface ProviderCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}
