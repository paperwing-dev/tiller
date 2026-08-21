import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { LOCAL_STATE_DIR } from "./config.js";

export type RunnerCommandDesiredState = "running" | "stopped" | "absent";
export const RUNNER_COMMAND_PROTOCOL = 1 as const;
export type RunnerCommandErrorCode =
  | "runner_command_superseded_before_mutation"
  | "runner_command_superseded"
  | "runner_command_conflict";

export interface RunnerCommandEnvelope {
  commandGeneration: number;
  operationId: string;
  desiredState: RunnerCommandDesiredState;
}

export interface RunnerCommandFenceRecord extends RunnerCommandEnvelope {
  version: 1;
  slug: string;
  phase: "accepted" | "applied";
  updatedAt: string;
}

export interface RunnerWorkspaceSyncedStopProof {
  version: 1;
  slug: string;
  stopCommandGeneration: number;
  stopOperationId: string;
  runnerCommandGeneration: number;
  recordedAt: string;
}

export class RunnerCommandFenceError extends Error {
  readonly status = 409;

  constructor(
    message: string,
    readonly code: RunnerCommandErrorCode,
    readonly currentCommandGeneration?: number,
  ) {
    super(message);
    this.name = "RunnerCommandFenceError";
  }
}

function isDesiredState(value: unknown): value is RunnerCommandDesiredState {
  return value === "running" || value === "stopped" || value === "absent";
}

function normalizeRecord(value: unknown, expectedSlug?: string): RunnerCommandFenceRecord {
  if (!value || typeof value !== "object") {
    throw new RunnerCommandFenceError("Stored runner command fence is invalid.", "runner_command_conflict");
  }
  const record = value as Partial<RunnerCommandFenceRecord>;
  if (
    record.version !== 1
    || typeof record.slug !== "string"
    || (expectedSlug !== undefined && record.slug !== expectedSlug)
    || !Number.isSafeInteger(record.commandGeneration)
    || (record.commandGeneration ?? 0) <= 0
    || typeof record.operationId !== "string"
    || !record.operationId.trim()
    || !isDesiredState(record.desiredState)
    || (record.phase !== "accepted" && record.phase !== "applied")
    || typeof record.updatedAt !== "string"
  ) {
    throw new RunnerCommandFenceError("Stored runner command fence is invalid.", "runner_command_conflict");
  }
  return record as RunnerCommandFenceRecord;
}

function encodeSlug(slug: string): string {
  return Buffer.from(slug, "utf8").toString("base64url");
}

function normalizeWorkspaceSyncedStopProof(
  value: unknown,
  expectedSlug?: string,
): RunnerWorkspaceSyncedStopProof {
  if (!value || typeof value !== "object") {
    throw new RunnerCommandFenceError("Stored workspace persistence proof is invalid.", "runner_command_conflict");
  }
  const proof = value as Partial<RunnerWorkspaceSyncedStopProof>;
  if (
    proof.version !== 1
    || typeof proof.slug !== "string"
    || (expectedSlug !== undefined && proof.slug !== expectedSlug)
    || !Number.isSafeInteger(proof.stopCommandGeneration)
    || (proof.stopCommandGeneration ?? 0) <= 0
    || typeof proof.stopOperationId !== "string"
    || !proof.stopOperationId.trim()
    || !Number.isSafeInteger(proof.runnerCommandGeneration)
    || (proof.runnerCommandGeneration ?? 0) <= 0
    || (proof.runnerCommandGeneration ?? 0) >= (proof.stopCommandGeneration ?? 0)
    || typeof proof.recordedAt !== "string"
  ) {
    throw new RunnerCommandFenceError("Stored workspace persistence proof is invalid.", "runner_command_conflict");
  }
  return proof as RunnerWorkspaceSyncedStopProof;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
}

export class RunnerCommandFenceStore {
  readonly rootPath: string;

  constructor(localStateDir = LOCAL_STATE_DIR) {
    this.rootPath = resolve(localStateDir, "runner-fences");
  }

  directoryFor(slug: string): string {
    return resolve(this.rootPath, encodeSlug(slug));
  }

  private statePath(slug: string): string {
    return resolve(this.directoryFor(slug), "state.json");
  }

  private workspaceSyncedStopPath(slug: string): string {
    return resolve(this.directoryFor(slug), "workspace-synced-stop.json");
  }

  private clearRunningTokens(slug: string): void {
    const directory = this.directoryFor(slug);
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith("running-")) {
        rmSync(resolve(directory, entry), { force: true });
      }
    }
  }

  private ensureToken(record: RunnerCommandFenceRecord): void {
    mkdirSync(this.directoryFor(record.slug), { recursive: true, mode: 0o700 });
    this.clearRunningTokens(record.slug);
    if (record.desiredState === "running") {
      writeFileSync(
        resolve(this.directoryFor(record.slug), `running-${record.commandGeneration}`),
        `${record.operationId}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
  }

  read(slug: string): RunnerCommandFenceRecord | null {
    const path = this.statePath(slug);
    if (!existsSync(path)) return null;
    try {
      return normalizeRecord(JSON.parse(readFileSync(path, "utf8")), slug);
    } catch (error) {
      if (error instanceof RunnerCommandFenceError) throw error;
      throw new RunnerCommandFenceError(
        `Stored runner command fence for ${slug} cannot be read.`,
        "runner_command_conflict",
      );
    }
  }

  accept(
    slug: string,
    input: Partial<RunnerCommandEnvelope>,
    expectedDesiredState: RunnerCommandDesiredState,
  ): RunnerCommandFenceRecord {
    if (
      !Number.isSafeInteger(input.commandGeneration)
      || (input.commandGeneration ?? 0) <= 0
      || typeof input.operationId !== "string"
      || !input.operationId.trim()
      || input.desiredState !== expectedDesiredState
    ) {
      throw new RunnerCommandFenceError(
        "Runner command generation, operationId, and desiredState are required and must match the action.",
        "runner_command_conflict",
      );
    }

    const commandGeneration = input.commandGeneration as number;
    const operationId = input.operationId.trim();
    const current = this.read(slug);
    if (current) {
      if (commandGeneration < current.commandGeneration) {
        throw new RunnerCommandFenceError(
          `Runner command generation ${commandGeneration} was superseded by ${current.commandGeneration}.`,
          "runner_command_superseded_before_mutation",
          current.commandGeneration,
        );
      }
      if (commandGeneration === current.commandGeneration) {
        if (current.operationId !== operationId || current.desiredState !== expectedDesiredState) {
          throw new RunnerCommandFenceError(
            `Runner command generation ${commandGeneration} belongs to another operation.`,
            "runner_command_conflict",
          );
        }
        // An applied replay is observational: the caller must inspect the
        // runner produced by this exact command instead of refreshing fence
        // files or executing the mutation again. Accepted commands can still
        // repair their token before joining the in-flight execution.
        if (current.phase === "accepted") {
          this.ensureToken(current);
        }
        return current;
      }
      if (current.operationId === operationId) {
        throw new RunnerCommandFenceError(
          `Runner operation ${operationId} is already bound to generation ${current.commandGeneration}.`,
          "runner_command_conflict",
        );
      }
    }

    const record: RunnerCommandFenceRecord = {
      version: 1,
      slug,
      commandGeneration,
      operationId,
      desiredState: expectedDesiredState,
      phase: "accepted",
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(this.directoryFor(slug), { recursive: true, mode: 0o700 });
    // Removing the running token first makes Stop/Destroy fail closed even if
    // persistence is interrupted before the request can be acknowledged.
    if (expectedDesiredState !== "running") {
      this.clearRunningTokens(slug);
    }
    writeJsonAtomic(this.statePath(slug), record);
    this.ensureToken(record);
    return record;
  }

  assertCurrent(record: RunnerCommandFenceRecord): void {
    const current = this.read(record.slug);
    if (
      !current
      || current.commandGeneration !== record.commandGeneration
      || current.operationId !== record.operationId
      || current.desiredState !== record.desiredState
    ) {
      throw new RunnerCommandFenceError(
        `Runner command generation ${record.commandGeneration} was superseded.`,
        "runner_command_superseded",
      );
    }
  }

  markApplied(record: RunnerCommandFenceRecord): RunnerCommandFenceRecord {
    this.assertCurrent(record);
    const applied: RunnerCommandFenceRecord = {
      ...record,
      phase: "applied",
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.statePath(record.slug), applied);
    return applied;
  }

  recordWorkspaceSyncedStop(
    record: RunnerCommandFenceRecord,
    runnerCommandGeneration: number,
  ): RunnerWorkspaceSyncedStopProof {
    this.assertCurrent(record);
    if (
      record.desiredState !== "stopped"
      || !Number.isSafeInteger(runnerCommandGeneration)
      || runnerCommandGeneration <= 0
      || runnerCommandGeneration >= record.commandGeneration
    ) {
      throw new RunnerCommandFenceError(
        "Workspace persistence proof does not match the stopped runner.",
        "runner_command_conflict",
      );
    }
    const proof: RunnerWorkspaceSyncedStopProof = {
      version: 1,
      slug: record.slug,
      stopCommandGeneration: record.commandGeneration,
      stopOperationId: record.operationId,
      runnerCommandGeneration,
      recordedAt: new Date().toISOString(),
    };
    writeJsonAtomic(this.workspaceSyncedStopPath(record.slug), proof);
    return proof;
  }

  readWorkspaceSyncedStop(slug: string): RunnerWorkspaceSyncedStopProof | null {
    const path = this.workspaceSyncedStopPath(slug);
    if (!existsSync(path)) return null;
    try {
      return normalizeWorkspaceSyncedStopProof(JSON.parse(readFileSync(path, "utf8")), slug);
    } catch (error) {
      if (error instanceof RunnerCommandFenceError) throw error;
      throw new RunnerCommandFenceError(
        `Stored workspace persistence proof for ${slug} cannot be read.`,
        "runner_command_conflict",
      );
    }
  }

  listAcceptedTerminalCommands(): RunnerCommandFenceRecord[] {
    if (!existsSync(this.rootPath)) return [];
    const records: RunnerCommandFenceRecord[] = [];
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(this.rootPath, entry.name, "state.json");
      if (!existsSync(path)) continue;
      try {
        const record = normalizeRecord(JSON.parse(readFileSync(path, "utf8")));
        if (record.phase === "accepted" && record.desiredState !== "running") {
          records.push(record);
        }
      } catch (error) {
        console.error(
          `[runner] Ignoring unreadable command fence at ${path}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return records;
  }
}
