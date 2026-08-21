import { DurableObject } from "cloudflare:workers";
import { listAccounts, type CloudflareAuthorization } from "./cloudflare-api";
import {
  decryptOAuthToken,
  encryptOAuthToken,
  pkceChallenge,
  randomBase64Url,
  sha256Hex,
} from "./crypto";
import {
  assertRequiredScopes,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  OAuthScopeError,
  revokeAccessToken,
} from "./oauth";
import { parseReleaseDescriptor } from "./release";
import { isPlacementRegion } from "../../hub/shared/placement";
import type {
  Env,
  InstallJobRecordV1,
  JobProjection,
  LifecycleIntent,
  PlacementRegion,
} from "./types";

const RECORD_KEY = "lifecycle-session:v1";
const SESSION_LIFETIME_MS = 30 * 60 * 1_000;
const OAUTH_ATTEMPT_MS = 10 * 60 * 1_000;
const MAX_INTERNAL_BODY = 32 * 1_024;
// Leave enough time to decrypt and revoke a grant before its 30-minute
// encryption envelope expires, even when an alarm is delivered a little late.
const SESSION_CLEANUP_LEAD_MS = 60_000;

type CallbackBody = { state?: unknown; code?: unknown; error?: unknown };

function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_INTERNAL_BODY) throw new Error("Request too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_INTERNAL_BODY) throw new Error("Request too large");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid request");
  return parsed;
}

function requiredString(value: unknown, max = 4_096): string {
  if (typeof value !== "string") throw new Error("Required value is missing");
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error("Required value is missing");
  return normalized;
}

function lifecycleIntent(value: unknown): LifecycleIntent {
  if (value === "install" || value === "update" || value === "renew") return value;
  throw new Error("Lifecycle intent is invalid");
}

function optionalPlacementRegion(value: unknown): PlacementRegion | undefined {
  if (value === undefined) return undefined;
  if (isPlacementRegion(value)) return value;
  throw new Error("Placement region is invalid");
}

function callbackFailed(code: string, message: string): JobProjection {
  return { stage: "failed", error: { code, message } };
}

export class InstallJobDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/create") return await this.create(request);
      if (request.method === "POST" && url.pathname === "/callback") return await this.callback(request);
      if (request.method === "GET" && url.pathname === "/status") return await this.status(request);
      return noStoreJson({ error: "not_found" }, 404);
    } catch {
      return noStoreJson({ error: "invalid_request" }, 400);
    }
  }

  async alarm(): Promise<void> {
    const record = await this.readRecord();
    if (!record) return;
    if (Date.now() >= this.cleanupAt(record)) {
      await this.expire(record);
      return;
    }
    if (record.step === "authorize") {
      if (Date.now() >= Date.parse(record.oauthAttempt?.expiresAt ?? "")) {
        record.oauthAttempt = undefined;
        record.step = "failed";
        record.projection = callbackFailed("oauth_expired", "Cloudflare authorization expired. Start again.");
        await this.writeRecord(record);
      }
      await this.ctx.storage.setAlarm(this.cleanupAt(record));
      return;
    }
    if (record.step === "attach") {
      await this.attach(record);
      return;
    }
    await this.ctx.storage.setAlarm(this.cleanupAt(record));
  }

  private async create(request: Request): Promise<Response> {
    if (await this.readRecord()) return noStoreJson({ error: "already_exists" }, 409);
    const body = await readJson(request);
    const jobId = requiredString(body.jobId, 128);
    const session = requiredString(request.headers.get("X-Tiller-Browser-Session"), 512);
    const descriptor = parseReleaseDescriptor(body.descriptor);
    const intent = lifecycleIntent(body.intent);
    const placementRegion = optionalPlacementRegion(body.placementRegion);
    if (intent === "install" && placementRegion === undefined) {
      throw new Error("Installation requires a placement region");
    }
    if (intent !== "install" && placementRegion !== undefined) {
      throw new Error("Maintenance cannot select a placement region");
    }
    const now = Date.now();
    const verifier = randomBase64Url(48);
    const state = `${jobId}.${randomBase64Url(32)}`;
    const record: InstallJobRecordV1 = {
      jobId,
      browserSessionSha256: await sha256Hex(session),
      expiresAt: new Date(now + SESSION_LIFETIME_MS).toISOString(),
      intent,
      ...(placementRegion ? { placementRegion } : {}),
      descriptor,
      projection: { stage: "connect-cloudflare" },
      step: "authorize",
      oauthAttempt: {
        state,
        verifier,
        consumed: false,
        expiresAt: new Date(now + OAUTH_ATTEMPT_MS).toISOString(),
      },
    };
    await this.writeRecord(record);
    await this.ctx.storage.setAlarm(Date.parse(record.oauthAttempt!.expiresAt));
    return noStoreJson({
      authorizationUrl: buildAuthorizationUrl(this.env, {
        state,
        challenge: await pkceChallenge(verifier),
      }),
    });
  }

  private async callback(request: Request): Promise<Response> {
    const body = await readJson(request) as CallbackBody;
    const state = requiredString(body.state, 512);
    const sessionSha256 = await this.requestSessionSha256(request);
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<InstallJobRecordV1>(RECORD_KEY);
      this.assertBrowserSession(record, sessionSha256);
      const attempt = record.oauthAttempt;
      if (!attempt || attempt.consumed || attempt.state !== state || record.step !== "authorize") return null;
      attempt.consumed = true;
      record.oauthAttempt = attempt;
      await transaction.put(RECORD_KEY, record);
      return { record, verifier: attempt.verifier };
    });
    if (!consumed) return noStoreJson({ error: "invalid_oauth_state" }, 409);

    if (Date.now() >= Date.parse(consumed.record.oauthAttempt!.expiresAt)
      || Date.now() >= this.cleanupAt(consumed.record)) {
      consumed.record.oauthAttempt = undefined;
      consumed.record.step = "failed";
      consumed.record.projection = callbackFailed("oauth_expired", "Cloudflare authorization expired. Start again.");
      await this.writeRecord(consumed.record);
      return noStoreJson({ accepted: true, intent: consumed.record.intent });
    }
    if (typeof body.error === "string" && body.error.trim()) {
      consumed.record.oauthAttempt = undefined;
      consumed.record.step = "failed";
      consumed.record.projection = callbackFailed("oauth_denied", "Cloudflare authorization was not granted.");
      await this.writeRecord(consumed.record);
      return noStoreJson({ accepted: true, intent: consumed.record.intent });
    }

    let issuedToken: string | undefined;
    try {
      const exchanged = await exchangeAuthorizationCode(this.env, {
        code: requiredString(body.code, 4_096),
        verifier: consumed.verifier,
      });
      issuedToken = exchanged.accessToken;
      assertRequiredScopes(exchanged.grantedScopes);
      const encryptedToken = await encryptOAuthToken(
        this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
        exchanged.accessToken,
        { jobId: consumed.record.jobId, jobExpiresAt: consumed.record.expiresAt },
      );
      const authorization: CloudflareAuthorization = {
        accessToken: exchanged.accessToken,
        deadline: Date.parse(encryptedToken.expiresAt),
      };
      const accountIds = (await listAccounts(authorization))
        .map((account) => account.id?.trim() ?? "")
        .filter(Boolean);
      if (accountIds.length !== 1) {
        await revokeAccessToken(this.env, exchanged.accessToken).catch(() => undefined);
        consumed.record.oauthAttempt = undefined;
        consumed.record.step = "failed";
        consumed.record.projection = {
          stage: "action-required",
          issue: "single-account-required",
          nextAction: { kind: "reauthorize", url: this.startUrl(consumed.record.intent) },
        };
        await this.writeRecord(consumed.record);
        return noStoreJson({ accepted: true, intent: consumed.record.intent });
      }
      consumed.record.accountId = accountIds[0];
      consumed.record.encryptedToken = encryptedToken;
      consumed.record.oauthAttempt = undefined;
      consumed.record.step = "attach";
      await this.writeRecord(consumed.record);
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return noStoreJson({ accepted: true, intent: consumed.record.intent });
    } catch (error) {
      if (issuedToken) await revokeAccessToken(this.env, issuedToken).catch(() => undefined);
      consumed.record.encryptedToken = undefined;
      consumed.record.oauthAttempt = undefined;
      consumed.record.step = "failed";
      consumed.record.projection = callbackFailed(
        error instanceof OAuthScopeError ? "oauth_scope_missing" : "oauth_exchange_failed",
        error instanceof OAuthScopeError
          ? "Cloudflare did not grant every required deployment permission."
          : "Cloudflare authorization could not be completed.",
      );
      await this.writeRecord(consumed.record);
      return noStoreJson({ accepted: true, intent: consumed.record.intent });
    }
  }

  private async attach(record: InstallJobRecordV1): Promise<void> {
    if (!record.encryptedToken || !record.accountId) throw new Error("Authorization handoff is incomplete");
    const tokenExpiresAt = record.encryptedToken.expiresAt;
    let token: string;
    try {
      token = await decryptOAuthToken(this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1, record.encryptedToken, {
        jobId: record.jobId,
      });
    } catch {
      record.encryptedToken = undefined;
      record.step = "failed";
      record.projection = {
        stage: "action-required",
        issue: "reauthorization-required",
        nextAction: { kind: "reauthorize", url: this.startUrl(record.intent) },
      };
      await this.writeRecord(record);
      await this.ctx.storage.setAlarm(this.cleanupAt(record));
      return;
    }
    try {
      const response = await this.accountStub(record.accountId).fetch("https://account-lifecycle.internal/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorizationId: record.jobId,
          accountId: record.accountId,
          intent: record.intent,
          ...(record.placementRegion ? { placementRegion: record.placementRegion } : {}),
          descriptor: record.descriptor,
          accessToken: token,
          authorizationExpiresAt: record.encryptedToken.expiresAt,
        }),
      });
      const body: { operationId?: unknown; authorizationAccepted?: unknown } = await response.json<{
        operationId?: unknown;
        authorizationAccepted?: unknown;
      }>()
        .catch(() => ({}));
      if (!response.ok || typeof body.operationId !== "string" || !body.operationId.trim()
        || typeof body.authorizationAccepted !== "boolean") {
        throw new Error("Lifecycle operation rejected authorization");
      }
      if (!body.authorizationAccepted) {
        // This account operation already has a usable grant. Revoke this
        // session's unused grant before dropping its encrypted copy.
        await revokeAccessToken(this.env, token);
      }
      record.operationId = body.operationId.trim();
      record.encryptedToken = undefined;
      record.step = "attached";
      await this.writeRecord(record);
      await this.ctx.storage.setAlarm(this.cleanupAt(record));
    } catch {
      await this.ctx.storage.setAlarm(Math.min(
        Date.now() + 2_000,
        this.cleanupAt(record),
        Date.parse(tokenExpiresAt),
      ));
    }
  }

  private async status(request: Request): Promise<Response> {
    const record = await this.readRecord();
    if (!record) return noStoreJson({ error: "not_found" }, 404);
    this.assertBrowserSession(record, await this.requestSessionSha256(request));
    if (record.step !== "attached" || !record.accountId || !record.operationId) {
      return noStoreJson(record.projection);
    }
    const response = await this.accountStub(record.accountId).fetch(
      `https://account-lifecycle.internal/status?operationId=${encodeURIComponent(record.operationId)}`,
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("Content-Type") ?? "application/json",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  private accountStub(accountId: string): DurableObjectStub {
    return this.env.ACCOUNT_LIFECYCLE.get(this.env.ACCOUNT_LIFECYCLE.idFromName(`account:v1:${accountId}`));
  }

  private startUrl(intent: LifecycleIntent): string {
    return intent === "install" ? "/deploy" : `/maintenance?intent=${intent}`;
  }

  private async expire(record: InstallJobRecordV1): Promise<void> {
    if (record.encryptedToken && record.step !== "attached") {
      const token = await decryptOAuthToken(
        this.env.INSTALLER_TOKEN_ENCRYPTION_KEY_V1,
        record.encryptedToken,
        { jobId: record.jobId },
      ).catch(() => undefined);
      if (token) await revokeAccessToken(this.env, token).catch(() => undefined);
    }
    await this.ctx.storage.delete(RECORD_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  private cleanupAt(record: InstallJobRecordV1): number {
    return Date.parse(record.expiresAt) - SESSION_CLEANUP_LEAD_MS;
  }

  private async requestSessionSha256(request: Request): Promise<string> {
    return sha256Hex(requiredString(request.headers.get("X-Tiller-Browser-Session"), 512));
  }

  private assertBrowserSession(
    record: InstallJobRecordV1 | undefined,
    sessionSha256: string,
  ): asserts record is InstallJobRecordV1 {
    if (!record || record.browserSessionSha256 !== sessionSha256) throw new Error("Lifecycle session not found");
  }

  private readRecord(): Promise<InstallJobRecordV1 | undefined> {
    return this.ctx.storage.get<InstallJobRecordV1>(RECORD_KEY);
  }

  private writeRecord(record: InstallJobRecordV1): Promise<void> {
    return this.ctx.storage.put(RECORD_KEY, record);
  }
}
