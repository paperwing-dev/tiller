import { execFile } from "node:child_process";

export type WorkspaceSaveReason = "idle" | "explicit";

export interface WorkspaceSaveCoordinatorOptions {
  execute?: () => Promise<void>;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  onLog?: (message: string) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;

function runWorkspaceSync(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("flock", [
      "-w",
      "120",
      process.env.TILLER_WORKSPACE_SYNC_LOCK_PATH || "/run/tiller/workspace-sync.lock",
      "node",
      "/workspace-sync.mjs",
      "up",
    ], {
      timeout: 125_000,
    }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Serializes and coalesces routine saves. A request arriving during a scan
 * schedules another complete strict pass, while each pass gets a small capped
 * retry budget. The entrypoint's five-minute loop remains the long fallback.
 */
export class WorkspaceSaveCoordinator {
  private readonly execute: () => Promise<void>;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly onLog: (message: string) => void;
  private requested = false;
  private requestedReasons = new Set<WorkspaceSaveReason>();
  private active: Promise<void> | null = null;

  constructor(options: WorkspaceSaveCoordinatorOptions = {}) {
    this.execute = options.execute ?? runWorkspaceSync;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.onLog = options.onLog ?? (() => undefined);
  }

  requestSave(reason: WorkspaceSaveReason): Promise<void> {
    this.requested = true;
    this.requestedReasons.add(reason);
    if (!this.active) {
      const run = this.drain();
      let tracked: Promise<void>;
      tracked = run.finally(() => {
        if (this.active === tracked) this.active = null;
      });
      this.active = tracked;
    }
    return this.active;
  }

  private async drain(): Promise<void> {
    while (this.requested) {
      this.requested = false;
      const reasons = [...this.requestedReasons].sort().join(",");
      this.requestedReasons.clear();
      await this.saveWithRetry(reasons);
    }
  }

  private async saveWithRetry(reasons: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.execute();
        this.onLog(`Workspace save completed (${reasons || "routine"}).`);
        return;
      } catch (error) {
        const delayMs = this.retryDelaysMs[attempt];
        if (delayMs == null) throw error;
        this.onLog(
          `Workspace save failed; retrying in ${Math.ceil(delayMs / 1_000)}s (${attempt + 1}/${this.retryDelaysMs.length}).`,
        );
        await this.sleep(delayMs);
      }
    }
  }
}
