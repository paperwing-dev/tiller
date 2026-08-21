#!/usr/bin/env node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServerClient,
  createCodexAppServerSocketLease,
} from "./codex-app-server-client.js";

const MAX_AUTH_JSON_BYTES = 64 * 1_024;
const MAX_RESULT_JSON_BYTES = 128 * 1_024;
const ACCOUNT_READ_TIMEOUT_MS = 6_000;
const MAX_CLEANUP_RESERVE_MS = 500;

const CODEX_AUTH_HELPER_INHERITED_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
] as const;

export type CodexAuthHelperErrorCode =
  | "invalid_input"
  | "unsupported_auth_mode"
  | "invalid_credentials"
  | "account_mismatch"
  | "provider_rejected"
  | "refresh_timeout"
  | "refresh_failed"
  | "invalid_refresh_result";

export interface CodexAuthProjection {
  accessToken: string;
  accountId: string;
  expiresAt: number;
}

export type CodexAuthHelperResult =
  | {
      version: 1;
      ok: true;
      auth_json: string;
      projected: CodexAuthProjection;
    }
  | {
      version: 1;
      ok: false;
      error: { code: CodexAuthHelperErrorCode };
    };

interface TokenClaims {
  exp?: unknown;
  chatgpt_account_id?: unknown;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: unknown;
  };
}

interface AccountReadResponse {
  account: { type: "chatgpt" };
  requiresOpenaiAuth: true;
}

class CodexAuthHelperError extends Error {
  constructor(readonly code: CodexAuthHelperErrorCode) {
    super(code);
    this.name = "CodexAuthHelperError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * The auth helper handles the complete refresh credential, so it must not use
 * the broader workload environment policy. In particular, session-defined
 * names, Node injection settings, Git configuration, provider overrides, and
 * unrelated credentials must never reach the managed-refresh app-server.
 */
export function buildCodexAuthHelperEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
): Record<string, string> {
  const result: Record<string, string> = {
    HOME: codexHome,
    CODEX_HOME: codexHome,
    TMPDIR: codexHome,
  };
  for (const name of CODEX_AUTH_HELPER_INHERITED_ENV) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function decodeJwtClaims(value: string): TokenClaims | null {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed as TokenClaims : null;
  } catch {
    return null;
  }
}

function accountIdFromClaims(claims: TokenClaims | null): string {
  const nested = claims?.["https://api.openai.com/auth"];
  const value = claims?.chatgpt_account_id ?? nested?.chatgpt_account_id;
  return typeof value === "string" ? value.trim() : "";
}

function requiredToken(tokens: Record<string, unknown>, key: string): string {
  const value = tokens[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CodexAuthHelperError("invalid_credentials");
  }
  return value.trim();
}

/**
 * Validate only the fields Tiller projects. The complete input is handed to
 * the pinned Codex binary unchanged; its exact post-refresh file is the
 * authoritative durable value.
 */
export function projectCodexAuthJson(authJson: string): CodexAuthProjection {
  if (!authJson.trim() || byteLength(authJson) > MAX_AUTH_JSON_BYTES) {
    throw new CodexAuthHelperError("invalid_input");
  }
  let value: unknown;
  try {
    value = JSON.parse(authJson) as unknown;
  } catch {
    throw new CodexAuthHelperError("invalid_input");
  }
  if (!isRecord(value)) throw new CodexAuthHelperError("invalid_input");
  if (value.auth_mode !== "chatgpt") {
    throw new CodexAuthHelperError("unsupported_auth_mode");
  }
  if (!isRecord(value.tokens)) throw new CodexAuthHelperError("invalid_credentials");
  const tokens = value.tokens;
  const accessToken = requiredToken(tokens, "access_token");
  requiredToken(tokens, "refresh_token");
  const idToken = typeof tokens.id_token === "string" && tokens.id_token.trim()
    ? tokens.id_token.trim()
    : "";
  const accessClaims = decodeJwtClaims(accessToken);
  const idClaims = idToken ? decodeJwtClaims(idToken) : null;
  if (!accessClaims || (idToken && !idClaims)) {
    throw new CodexAuthHelperError("invalid_credentials");
  }
  const accessAccountId = accountIdFromClaims(accessClaims);
  const idAccountId = accountIdFromClaims(idClaims);
  if (accessAccountId && idAccountId && accessAccountId !== idAccountId) {
    throw new CodexAuthHelperError("account_mismatch");
  }
  const recordedAccountId = typeof tokens.account_id === "string"
    ? tokens.account_id.trim()
    : "";
  const accountId = idAccountId || accessAccountId || recordedAccountId;
  if (
    !accountId
    || (recordedAccountId && recordedAccountId !== accountId)
  ) {
    throw new CodexAuthHelperError("account_mismatch");
  }
  const exp = accessClaims.exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) {
    throw new CodexAuthHelperError("invalid_credentials");
  }
  const expiresAt = exp * 1_000;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new CodexAuthHelperError("invalid_credentials");
  }
  return { accessToken, accountId, expiresAt };
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new CodexAuthHelperError("refresh_timeout");
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CodexAuthHelperError("refresh_timeout")), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertAccountReadResponse(value: unknown): asserts value is AccountReadResponse {
  if (!isRecord(value) || value.requiresOpenaiAuth !== true) {
    throw new CodexAuthHelperError("invalid_refresh_result");
  }
  if (value.account === null) throw new CodexAuthHelperError("provider_rejected");
  if (!isRecord(value.account) || value.account.type !== "chatgpt") {
    throw new CodexAuthHelperError("invalid_refresh_result");
  }
}

function classifyRefreshError(error: unknown): CodexAuthHelperError {
  if (error instanceof CodexAuthHelperError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("timed out") || message.includes("deadline")) {
    return new CodexAuthHelperError("refresh_timeout");
  }
  if (
    message.includes("unauthorized")
    || message.includes("invalid grant")
    || message.includes("invalid_grant")
    || message.includes("login required")
  ) {
    return new CodexAuthHelperError("provider_rejected");
  }
  return new CodexAuthHelperError("refresh_failed");
}

export async function refreshCodexAuthJson(
  authJson: string,
  options: { codexExecutable?: string; timeoutMs?: number } = {},
): Promise<Extract<CodexAuthHelperResult, { ok: true }>> {
  const inputProjection = projectCodexAuthJson(authJson);
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const codexHome = await mkdtemp(join(temporaryRoot, "tiller-codex-auth-"));
  await chmod(codexHome, 0o700);
  const authPath = join(codexHome, "auth.json");
  const socketLease = createCodexAppServerSocketLease("tiller-codex-auth-socket-");
  const childEnv = buildCodexAuthHelperEnvironment(process.env, codexHome);
  const client = new CodexAppServerClient({
    socketPath: socketLease.socketPath,
    cwd: codexHome,
    env: childEnv,
    codexExecutable: options.codexExecutable,
    clientName: "tiller-codex-auth-helper",
    rejectUnexpectedServerRequests: true,
    declineMcpServerElicitations: true,
  });
  const timeoutMs = options.timeoutMs ?? ACCOUNT_READ_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CodexAuthHelperError("refresh_timeout");
  }
  const deadline = Date.now() + timeoutMs;
  const cleanupReserveMs = Math.min(
    MAX_CLEANUP_RESERVE_MS,
    Math.max(1, Math.floor(timeoutMs / 4)),
    Math.max(0, timeoutMs - 1),
  );
  const workDeadline = deadline - cleanupReserveMs;
  try {
    await writeFile(join(codexHome, "config.toml"), [
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      "",
    ].join("\n"), { mode: 0o600, flag: "wx" });
    await writeFile(authPath, authJson, { mode: 0o600, flag: "wx" });
    await beforeDeadline(client.start(), workDeadline);
    const requestTimeoutMs = Math.max(1, workDeadline - Date.now());
    assertAccountReadResponse(await beforeDeadline(
      client.request("account/read", { refreshToken: true }, requestTimeoutMs),
      workDeadline,
    ));
    const updatedAuthJson = await beforeDeadline(
      readFile(authPath, "utf8"),
      workDeadline,
    );
    let projected: CodexAuthProjection;
    try {
      projected = projectCodexAuthJson(updatedAuthJson);
    } catch (error) {
      if (error instanceof CodexAuthHelperError && error.code === "account_mismatch") throw error;
      throw new CodexAuthHelperError("invalid_refresh_result");
    }
    if (projected.accountId !== inputProjection.accountId) {
      throw new CodexAuthHelperError("account_mismatch");
    }
    if (
      projected.accessToken === inputProjection.accessToken
      || projected.expiresAt <= inputProjection.expiresAt
    ) {
      throw new CodexAuthHelperError("invalid_refresh_result");
    }
    const result = {
      version: 1 as const,
      ok: true as const,
      auth_json: updatedAuthJson,
      projected,
    };
    if (byteLength(JSON.stringify(result)) > MAX_RESULT_JSON_BYTES) {
      throw new CodexAuthHelperError("invalid_refresh_result");
    }
    return result;
  } catch (error) {
    throw classifyRefreshError(error);
  } finally {
    const cleanupRemainingMs = Math.max(0, deadline - Date.now());
    const termGraceMs = Math.min(250, Math.floor(cleanupRemainingMs / 2));
    const stopPromise = client.stop({
      termGraceMs,
      killGraceMs: Math.max(0, cleanupRemainingMs - termGraceMs),
    });
    if (cleanupRemainingMs > 0) {
      await beforeDeadline(stopPromise, deadline).catch(() => undefined);
    } else {
      await stopPromise.catch(() => undefined);
    }
    socketLease.cleanup();
    await rm(codexHome, { recursive: true, force: true });
  }
}

async function readBoundedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += next.length;
    if (total > MAX_AUTH_JSON_BYTES) throw new CodexAuthHelperError("invalid_input");
    chunks.push(next);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeFailure(error: unknown): Extract<CodexAuthHelperResult, { ok: false }> {
  return {
    version: 1,
    ok: false,
    error: {
      code: error instanceof CodexAuthHelperError ? error.code : "refresh_failed",
    },
  };
}

export async function runCodexAuthHelperCli(): Promise<void> {
  let result: CodexAuthHelperResult;
  try {
    result = await refreshCodexAuthJson(await readBoundedStdin());
  } catch (error) {
    result = safeFailure(error);
  }
  const output = `${JSON.stringify(result)}\n`;
  // This guard is intentionally checked after replacing all errors with a
  // fixed code so no provider or credential material can leak on stdout.
  if (byteLength(output) > MAX_RESULT_JSON_BYTES) {
    process.stdout.write(`${JSON.stringify(safeFailure(new CodexAuthHelperError("invalid_refresh_result")))}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(output);
  if (!result.ok) process.exitCode = 1;
}
