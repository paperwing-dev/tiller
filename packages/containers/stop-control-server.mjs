import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";

const STOP_CONTROL_PREPARE_PATH = "/prepare-stop";
const STOP_CONTROL_PREPARE_IDLE_PATH = "/prepare-idle-stop";
const port = Number(process.env.TILLER_STOP_CONTROL_PORT || 8790);
const flagPath =
  process.env.TILLER_STOP_PREPARED_FLAG_PATH || "/tmp/tiller-stop-prepared";
const stopRequestedPath =
  process.env.TILLER_STOP_REQUESTED_FLAG_PATH || "/tmp/tiller-stop-requested";
const stopOpIdPath =
  process.env.TILLER_STOP_OP_ID_PATH || "/tmp/tiller-lifecycle-stop-op-id";
const harnessControlSocketPath =
  process.env.TILLER_HARNESS_CONTROL_SOCKET || "/tmp/tiller-harness-control.sock";
const runnerReadyMarkerPath =
  process.env.TILLER_RUNNER_READY_MARKER_PATH || "/tmp/tiller-runner-ready";
const harnessExitedMarkerPath =
  process.env.TILLER_HARNESS_EXITED_MARKER_PATH || "/tmp/tiller-harness-exited";

let inFlight = null;
let idlePrepareInFlight = null;
let pendingIdlePreparation = null;

class HarnessControlRequestError extends Error {
  constructor(message, statusCode, response) {
    super(message);
    this.name = "HarnessControlRequestError";
    this.statusCode = statusCode;
    this.response = response;
  }
}

function spawnStopFinalize(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn("/stop-finalize.sh", [], {
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }
      reject(new Error(
        stderr.trim()
          || stdout.trim()
          || `Stop finalize exited ${code ?? "unknown"}.`,
      ));
    });
  });
}

function readPreparedReceipt() {
  if (!existsSync(flagPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(flagPath, "utf8"));
    const opId = typeof parsed?.opId === "string" ? parsed.opId.trim() : "";
    const workspaceLastSyncedAt = typeof parsed?.workspaceLastSyncedAt === "string"
      ? parsed.workspaceLastSyncedAt.trim()
      : "";
    if (
      !opId
      || !workspaceLastSyncedAt
      || Number.isNaN(new Date(workspaceLastSyncedAt).getTime())
    ) {
      throw new Error("invalid prepared workspace receipt");
    }
    return { opId, workspaceLastSyncedAt: new Date(workspaceLastSyncedAt).toISOString() };
  } catch (error) {
    throw new Error(
      `Prepared workspace receipt is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runStopFinalize(stopOpId = "", options = {}) {
  const preparedReceipt = readPreparedReceipt();
  console.log(
    `[stop-control] stop finalize requested opId=${stopOpId || "none"} prepared=${preparedReceipt?.opId || "none"}`,
  );
  if (preparedReceipt?.opId === stopOpId) {
    return Promise.resolve({ code: 0, stdout: "", stderr: "", receipt: preparedReceipt });
  }
  if (preparedReceipt && preparedReceipt.opId !== stopOpId) {
    return Promise.reject(new Error("A different Stop operation already completed preparation."));
  }
  if (inFlight) {
    if (inFlight.opId !== stopOpId) {
      return Promise.reject(new Error("A different Stop operation is already preparing."));
    }
    return inFlight.promise;
  }

  const promise = spawnStopFinalize({
    TILLER_STOP_FINALIZE: "1",
    ...(stopOpId ? { TILLER_LIFECYCLE_OP_ID: stopOpId } : {}),
    ...(options.hubOwnsWorkspaceAck
      ? { TILLER_SKIP_WORKSPACE_SYNC_ACK: "1" }
      : {}),
  }).then((result) => {
    const receipt = {
      opId: stopOpId,
      workspaceLastSyncedAt: new Date().toISOString(),
    };
    writeFileSync(flagPath, JSON.stringify(receipt), { mode: 0o600 });
    console.log(
      `[stop-control] stop finalize complete opId=${stopOpId || "none"}`,
    );
    return { ...result, receipt };
  }).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { opId: stopOpId, promise };

  return promise;
}

function runIdleWorkspacePrepare() {
  if (idlePrepareInFlight) return idlePrepareInFlight;
  idlePrepareInFlight = spawnStopFinalize({
    TILLER_IDLE_STOP_PREPARE_ONLY: "1",
  }).finally(() => {
    idlePrepareInFlight = null;
  });
  return idlePrepareInFlight;
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 16 * 1024) {
        reject(new Error("Request is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("Request must be a JSON object"));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function requestHarnessControl(path, payload, timeoutMs = 2_000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: harnessControlSocketPath,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        try {
          const parsed = JSON.parse(responseBody);
          if (response.statusCode !== 200 || parsed.ok !== true) {
            reject(new HarnessControlRequestError(
              parsed.error || `Harness control returned HTTP ${response.statusCode}`,
              response.statusCode || 500,
              parsed,
            ));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Harness control timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function prepareHarnessManualStop(stopOpId) {
  try {
    return await requestHarnessControl("/prepare-stop", { opId: stopOpId }, 35_000);
  } catch (error) {
    const staleOwnerOpId = error instanceof HarnessControlRequestError
      && error.statusCode === 409
      && error.response?.code === "manual_stop_conflict"
      && typeof error.response.ownerOpId === "string"
      ? error.response.ownerOpId.trim()
      : "";
    if (!staleOwnerOpId || staleOwnerOpId === stopOpId) throw error;

    // stopOpId has already passed the runtime's durable operation fence. A
    // compare-and-swap against the harness's exact stale owner repairs only
    // split-brain left by an interrupted Stop; a delayed caller cannot replace
    // a newer fence without naming its current owner.
    console.warn(
      `[stop-control] replacing stale harness Stop fence owner ${staleOwnerOpId} with ${stopOpId}`,
    );
    return await requestHarnessControl(
      "/prepare-stop",
      { opId: stopOpId, replaceOpId: staleOwnerOpId },
      35_000,
    );
  }
}

function confirmedExitedHarnessCode(error) {
  const errorCode = error && typeof error === "object" ? error.code : null;
  if (errorCode !== "ENOENT" && errorCode !== "ECONNREFUSED") return null;
  if (!existsSync(runnerReadyMarkerPath) || !existsSync(harnessExitedMarkerPath)) return null;
  const rawExitCode = readFileSync(harnessExitedMarkerPath, "utf8").trim();
  if (!/^\d+$/.test(rawExitCode)) return null;
  return Number(rawExitCode);
}

async function releaseIdlePreparation(claimId) {
  if (!claimId) return false;
  if (pendingIdlePreparation?.claimId === claimId) pendingIdlePreparation = null;
  const response = await requestHarnessControl("/prepare-idle-stop", { action: "release", claimId }).catch(() => null);
  return response?.claimReleased === true;
}

function clearStopPreparationFiles() {
  unlinkSync(flagPath, { force: true });
  unlinkSync(stopRequestedPath, { force: true });
  unlinkSync(stopOpIdPath, { force: true });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handlePrepareIdleStop(req, res) {
  let body;
  try {
    body = await readRequestJson(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, eligible: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  if (body.action === "release") {
    const claimId = typeof body.claimId === "string" ? body.claimId : "";
    const claimReleased = await releaseIdlePreparation(claimId);
    if (claimReleased) clearStopPreparationFiles();
    sendJson(res, 200, { ok: true, eligible: false, remainingIdleMs: 0, reason: "released" });
    return;
  }

  const idleTimeoutMs = body.idleTimeoutMs;
  if (typeof idleTimeoutMs !== "number" || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    sendJson(res, 400, { ok: false, eligible: false, error: "idleTimeoutMs must be positive" });
    return;
  }

  let claim;
  try {
    claim = await requestHarnessControl("/prepare-idle-stop", { action: "claim", idleTimeoutMs });
  } catch (error) {
    sendJson(res, 503, {
      ok: false,
      eligible: false,
      remainingIdleMs: idleTimeoutMs,
      reason: "activity_unavailable",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (claim.eligible !== true || typeof claim.claimId !== "string") {
    sendJson(res, 200, claim);
    return;
  }

  const claimId = claim.claimId;
  try {
    if (pendingIdlePreparation?.claimId !== claimId) {
      await runIdleWorkspacePrepare();
    }
    const confirmed = await requestHarnessControl("/prepare-idle-stop", { action: "confirm", claimId });
    if (confirmed.eligible !== true) {
      await releaseIdlePreparation(claimId);
      sendJson(res, 200, confirmed);
      return;
    }
    pendingIdlePreparation = { claimId };
    sendJson(res, 200, { ...confirmed, ok: true });
  } catch (error) {
    await releaseIdlePreparation(claimId);
    sendJson(res, 200, {
      ok: false,
      eligible: false,
      remainingIdleMs: idleTimeoutMs,
      reason: "sync_failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "POST" && req.url === STOP_CONTROL_PREPARE_IDLE_PATH) {
    await handlePrepareIdleStop(req, res);
    return;
  }

  // Both host-backed Docker envs and Cloudflare Containers use this endpoint
  // as the durable-stop prepare contract before the outer runtime kills the container.
  if (req.method !== "POST" || req.url !== STOP_CONTROL_PREPARE_PATH) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  const requestedIdleClaimId = req.headers["x-tiller-idle-stop-claim-id"]?.trim() || "";
  let idlePreparation = pendingIdlePreparation;
  try {
    if (
      requestedIdleClaimId
      && idlePreparation?.claimId !== requestedIdleClaimId
    ) {
      sendJson(res, 409, { ok: false, error: "Idle stop claim is no longer available." });
      return;
    }
    if (idlePreparation) {
      let confirmed;
      try {
        confirmed = await requestHarnessControl("/prepare-idle-stop", {
          action: "confirm",
          claimId: idlePreparation.claimId,
        });
      } catch (error) {
        if (requestedIdleClaimId) throw error;
        console.warn(
          `[stop-control] manual stop could not re-confirm idle claim; running a fresh strict sync: ${error instanceof Error ? error.message : String(error)}`,
        );
        await releaseIdlePreparation(idlePreparation.claimId);
        idlePreparation = null;
      }
      if (confirmed && confirmed.eligible !== true) {
        pendingIdlePreparation = null;
        idlePreparation = null;
        if (requestedIdleClaimId) {
          sendJson(res, 409, { ok: false, error: "Idle stop claim was superseded by new work." });
          return;
        }
      }
    }
    const stopOpId = req.headers["x-tiller-lifecycle-op-id"]?.trim() || "";
    const hubOwnsWorkspaceAck =
      req.headers["x-tiller-workspace-ack-owner"]?.trim().toLowerCase() === "hub";
    if (!stopOpId) {
      sendJson(res, 400, { ok: false, error: "A lifecycle Stop operation ID is required." });
      return;
    }
    const existingStopOpId = existsSync(stopOpIdPath)
      ? readFileSync(stopOpIdPath, "utf8").trim()
      : "";
    if (existingStopOpId && existingStopOpId !== stopOpId) {
      sendJson(res, 409, { ok: false, error: "A different Stop operation already owns the runtime fence." });
      return;
    }
    // Write stop-requested immediately so entrypoint.sh can distinguish
    // intentional stops from unexpected harness exits.
    if (!existsSync(stopRequestedPath)) {
      writeFileSync(stopRequestedPath, "1");
    }
    if (!existingStopOpId) writeFileSync(stopOpIdPath, stopOpId);
    console.log(
      `[stop-control] prepare-stop opId=${stopOpId || "none"} stopRequested=1 stopPrepared=${existsSync(flagPath) ? "1" : "0"}`,
    );
    try {
      await prepareHarnessManualStop(stopOpId);
    } catch (error) {
      const exitedHarnessCode = confirmedExitedHarnessCode(error);
      if (exitedHarnessCode === null) throw error;
      // The entrypoint reaped a harness that had already reached runner-ready,
      // so there is no remaining agent writer to quiesce. The sync lock still
      // serializes this strict pass against the periodic workspace saver.
      console.warn(
        `[stop-control] harness exited before Stop quiescence (code ${exitedHarnessCode}); running the strict final workspace sync`,
      );
    }
    // Idle preflight proves eligibility only. Stop always performs a fresh
    // strict save after the manual fence has drained and quiesced the agent.
    const prepared = await runStopFinalize(stopOpId, { hubOwnsWorkspaceAck });
    pendingIdlePreparation = null;
    sendJson(res, 200, { ok: true, receipt: prepared.receipt });
  } catch (error) {
    pendingIdlePreparation = null;
    console.error(
      `[stop-control] prepare-stop failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "0.0.0.0");

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
