import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";

const CONTAINER_DIR = path.resolve(import.meta.dirname, "..");
const STOP_CONTROL_SOURCE = path.join(CONTAINER_DIR, "stop-control-server.mjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isolatedStopControlEnv(tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: "test",
    HUB_URL: "",
    REPO_SLUG: "",
    TILLER_RUNTIME_CAPABILITY: "",
    TILLER_STOP_TOKEN: "",
    TILLER_LIFECYCLE_OP_ID: "",
    TILLER_STOP_FINALIZE: "0",
    TILLER_IDLE_STOP_PREPARE_ONLY: "0",
    TILLER_STOP_TEST_STATE_OVERRIDES: "1",
    TILLER_STOP_STATE_DIR: path.join(tempRoot, "stop-state"),
    TILLER_STOP_PREPARED_FLAG_PATH: path.join(tempRoot, "prepared"),
    TILLER_STOP_REQUESTED_FLAG_PATH: path.join(tempRoot, "requested"),
    TILLER_STOP_OP_ID_PATH: path.join(tempRoot, "stop-op-id"),
    TILLER_HARNESS_CONTROL_SOCKET: path.join(tempRoot, "harness.sock"),
    TILLER_RUNNER_READY_MARKER_PATH: path.join(tempRoot, "runner-ready"),
    TILLER_HARNESS_EXITED_MARKER_PATH: path.join(tempRoot, "harness-exited"),
  };
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => child.once("exit", resolve));
}

function requestPrepareStop(
  port: number,
  options?: { stopOpId?: string; idleClaimId?: string; workspaceAckOwner?: "hub" },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/prepare-stop",
        method: "POST",
        headers: {
          ...(options?.stopOpId
            ? { "X-Tiller-Lifecycle-Op-Id": options.stopOpId }
            : {}),
          ...(options?.idleClaimId
            ? { "X-Tiller-Idle-Stop-Claim-Id": options.idleClaimId }
            : {}),
          ...(options?.workspaceAckOwner
            ? { "X-Tiller-Workspace-Ack-Owner": options.workspaceAckOwner }
            : {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function requestPrepareIdleStop(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/prepare-idle-stop",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { responseBody += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: responseBody }));
      },
    );
    req.on("error", reject);
    req.end(encoded);
  });
}

function requestHealth(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForServer(port: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const res = await requestHealth(port);
      if (res.status === 200) {
        return;
      }
    } catch {
      // Keep retrying until the server listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("stop control server did not start");
}

function listenOnSocket(server: http.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("stop control server", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("runs stop finalize and writes the prepared flag", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-test-");
    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const stopFlagPath = path.join(tempRoot, "prepared");
    const stopOpIdPath = path.join(tempRoot, "stop-op-id");
    const envCapturePath = path.join(tempRoot, "env.txt");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const socketPath = path.join(tempRoot, "harness.sock");
    const port = 8791;

    const harnessServer = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "idle", idleSince: Date.now(), opId: "stop-op-123" }));
    });
    await listenOnSocket(harnessServer, socketPath);

    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash
set -euo pipefail
printf '%s|%s' \
  "\${TILLER_STOP_FINALIZE:-}" \
  "\${TILLER_SKIP_WORKSPACE_SYNC_ACK:-0}" > "${envCapturePath}"
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );

    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_STOP_PREPARED_FLAG_PATH: stopFlagPath,
        TILLER_STOP_OP_ID_PATH: stopOpIdPath,
        TILLER_HARNESS_CONTROL_SOCKET: socketPath,
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const res = await requestPrepareStop(port, {
        stopOpId: "stop-op-123",
        workspaceAckOwner: "hub",
      });
      expect(res.status).toBe(200);
      const responseReceipt = JSON.parse(res.body).receipt;
      expect(responseReceipt).toEqual({
        opId: "stop-op-123",
        workspaceLastSyncedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(readFileSync(envCapturePath, "utf8")).toBe("1|1");
      expect(JSON.parse(readFileSync(stopFlagPath, "utf8"))).toEqual(responseReceipt);
      expect(statSync(stopFlagPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(stopOpIdPath, "utf8")).toBe("stop-op-123");
      expect(readFileSync(path.join(tempRoot, "requested"), "utf8")).toBe("1");

      const stale = await requestPrepareStop(port, { stopOpId: "stale-stop-op" });
      expect(stale.status).toBe(409);
      expect(JSON.parse(readFileSync(stopFlagPath, "utf8"))).toEqual(responseReceipt);
      expect(readFileSync(stopOpIdPath, "utf8")).toBe("stop-op-123");

      writeFileSync(stopFlagPath, "not-json");
      const malformed = await requestPrepareStop(port, { stopOpId: "stop-op-123" });
      expect(malformed.status).toBe(500);
      expect(JSON.parse(malformed.body)).toMatchObject({
        ok: false,
        error: expect.stringContaining("Prepared workspace receipt is malformed"),
      });
      expect(readFileSync(envCapturePath, "utf8")).toBe("1|1");
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await closeServer(harnessServer);
    }
  });

  it("replaces a stale harness fence only by comparing its exact owner", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-owner-recovery-test-");
    const socketPath = path.join(tempRoot, "harness.sock");
    const harnessRequests: Array<Record<string, unknown>> = [];
    let ownerOpId = "test-pollution-stop-op";
    const harnessServer = http.createServer(async (req, res) => {
      let rawBody = "";
      for await (const chunk of req) rawBody += chunk.toString();
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      harnessRequests.push(body);
      const requestedOpId = typeof body.opId === "string" ? body.opId : "";
      const replaceOpId = typeof body.replaceOpId === "string" ? body.replaceOpId : "";
      if (requestedOpId !== ownerOpId && replaceOpId !== ownerOpId) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          code: "manual_stop_conflict",
          ownerOpId,
          error: "A different Stop operation already owns the input fence.",
        }));
        return;
      }
      ownerOpId = requestedOpId;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, opId: requestedOpId, status: "idle", idleSince: Date.now() }));
    });
    await listenOnSocket(harnessServer, socketPath);

    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    writeFileSync(stopFinalizePath, "#!/bin/bash\nset -euo pipefail\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: "8797",
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(8797);
      const response = await requestPrepareStop(8797, { stopOpId: "active-stop-op" });
      expect(response.status).toBe(200);
      expect(harnessRequests).toEqual([
        { opId: "active-stop-op" },
        { opId: "active-stop-op", replaceOpId: "test-pollution-stop-op" },
      ]);
      expect(JSON.parse(readFileSync(path.join(tempRoot, "prepared"), "utf8"))).toEqual(
        JSON.parse(response.body).receipt,
      );
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await closeServer(harnessServer);
    }
  });

  it("reports health before any stop request", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-health-test-");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const port = 8792;

    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8"),
      { mode: 0o755 },
    );

    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_STOP_PREPARED_FLAG_PATH: path.join(tempRoot, "prepared"),
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const res = await requestHealth(port);
      expect(res.status).toBe(200);
      expect(res.body).toContain("\"ok\":true");
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }
  });

  it("fails closed without harness activity control", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-unavailable-test-");
    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const finalizeCapturePath = path.join(tempRoot, "finalize-ran");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const port = 8793;
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash
set -euo pipefail
touch "${finalizeCapturePath}"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_HARNESS_CONTROL_SOCKET: path.join(tempRoot, "missing.sock"),
        TILLER_STOP_PREPARED_FLAG_PATH: path.join(tempRoot, "prepared"),
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const response = await requestPrepareIdleStop(port, { idleTimeoutMs: 60_000 });
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        eligible: false,
        remainingIdleMs: 60_000,
        reason: "activity_unavailable",
      });
      expect(() => readFileSync(finalizeCapturePath)).toThrow();
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }
  });

  it("fails a manual stop closed when a missing harness socket has no confirmed exit", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-manual-unavailable-test-");
    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const finalizeCapturePath = path.join(tempRoot, "finalize-ran");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const port = 8798;
    writeFileSync(path.join(tempRoot, "runner-ready"), "1");
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash\nset -euo pipefail\ntouch "${finalizeCapturePath}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const response = await requestPrepareStop(port, { stopOpId: "stop-without-exit-proof" });
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: expect.stringContaining("ENOENT"),
      });
      expect(() => readFileSync(finalizeCapturePath)).toThrow();
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }
  });

  it("runs the strict final sync after a previously-ready harness has confirmed exit", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-exited-harness-test-");
    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const finalizeCapturePath = path.join(tempRoot, "finalize-ran");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const port = 8799;
    writeFileSync(path.join(tempRoot, "runner-ready"), "1");
    writeFileSync(path.join(tempRoot, "harness-exited"), "78\n");
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash\nset -euo pipefail\nprintf '%s' "\${TILLER_STOP_FINALIZE:-0}" > "${finalizeCapturePath}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const response = await requestPrepareStop(port, { stopOpId: "stop-after-harness-exit" });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).receipt).toEqual({
        opId: "stop-after-harness-exit",
        workspaceLastSyncedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(readFileSync(finalizeCapturePath, "utf8")).toBe("1");
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
    }
  });

  it("releases the input fence when strict workspace sync fails", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-sync-failure-test-");
    const socketPath = path.join(tempRoot, "harness.sock");
    const harnessRequests: Array<Record<string, unknown>> = [];
    const harnessServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const parsed = JSON.parse(body) as Record<string, unknown>;
      harnessRequests.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (parsed.action === "claim") {
        res.end(JSON.stringify({
          ok: true,
          eligible: true,
          remainingIdleMs: 0,
          reason: "eligible",
          claimId: "claim-1",
        }));
      } else {
        res.end(JSON.stringify({
          ok: true,
          eligible: false,
          remainingIdleMs: 0,
          reason: "released",
          claimReleased: true,
        }));
      }
    });
    await listenOnSocket(harnessServer, socketPath);

    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const preparedPath = path.join(tempRoot, "prepared");
    const port = 8794;
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash
set -euo pipefail
test "\${TILLER_IDLE_STOP_PREPARE_ONLY:-}" = "1"
exit 7
`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_HARNESS_CONTROL_SOCKET: socketPath,
        TILLER_STOP_PREPARED_FLAG_PATH: preparedPath,
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const response = await requestPrepareIdleStop(port, { idleTimeoutMs: 60_000 });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        eligible: false,
        remainingIdleMs: 60_000,
        reason: "sync_failed",
      });
      expect(harnessRequests).toEqual([
        { action: "claim", idleTimeoutMs: 60_000 },
        { action: "release", claimId: "claim-1" },
      ]);
      expect(() => readFileSync(preparedPath)).toThrow();
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await closeServer(harnessServer);
    }
  });

  it("performs a fresh strict sync after quiescing an eligible idle stop", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-idle-test-");
    const socketPath = path.join(tempRoot, "harness.sock");
    const harnessRequests: Array<Record<string, unknown>> = [];
    let supersedeClaim = false;
    let manualStopOpId: string | null = null;
    const harnessServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const parsed = JSON.parse(body) as Record<string, unknown>;
      harnessRequests.push(parsed);
      if (req.url === "/prepare-stop") {
        const requestedOpId = typeof parsed.opId === "string" ? parsed.opId : "";
        if (manualStopOpId && manualStopOpId !== requestedOpId) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "A different Stop owns the fence." }));
          return;
        }
        manualStopOpId = requestedOpId;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, opId: requestedOpId, status: "idle", idleSince: Date.now() }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed.action === "release"
        ? {
            ok: true,
            eligible: false,
            remainingIdleMs: 0,
            reason: "released",
            claimReleased: manualStopOpId == null,
          }
        : parsed.action === "confirm" && supersedeClaim
          ? {
              ok: true,
              eligible: false,
              remainingIdleMs: 60_000,
              reason: "claim_superseded",
            }
          : {
            ok: true,
            eligible: true,
            remainingIdleMs: 0,
            reason: "eligible",
            claimId: "claim-2",
          }));
    });
    await listenOnSocket(harnessServer, socketPath);

    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const invocationPath = path.join(tempRoot, "invocations.txt");
    const preparedPath = path.join(tempRoot, "prepared");
    const stopOpIdPath = path.join(tempRoot, "stop-op-id");
    const port = 8795;
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash
set -euo pipefail
printf 'idle=%s already=%s final=%s\\n' \
  "\${TILLER_IDLE_STOP_PREPARE_ONLY:-0}" \
  "\${TILLER_WORKSPACE_ALREADY_SYNCED:-0}" \
  "\${TILLER_STOP_FINALIZE:-0}" >> "${invocationPath}"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_HARNESS_CONTROL_SOCKET: socketPath,
        TILLER_STOP_PREPARED_FLAG_PATH: preparedPath,
        TILLER_STOP_OP_ID_PATH: stopOpIdPath,
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const idleResponse = await requestPrepareIdleStop(port, { idleTimeoutMs: 60_000 });
      expect(idleResponse.status).toBe(200);
      expect(JSON.parse(idleResponse.body)).toMatchObject({
        ok: true,
        eligible: true,
        claimId: "claim-2",
      });

      const stopResponse = await requestPrepareStop(port, {
        stopOpId: "stop-op-idle",
        idleClaimId: "claim-2",
      });
      expect(stopResponse.status).toBe(200);
      const responseReceipt = JSON.parse(stopResponse.body).receipt;
      expect(responseReceipt).toEqual({
        opId: "stop-op-idle",
        workspaceLastSyncedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
        "idle=1 already=0 final=0",
        "idle=0 already=0 final=1",
      ]);
      expect(JSON.parse(readFileSync(preparedPath, "utf8"))).toEqual(responseReceipt);
      expect(readFileSync(stopOpIdPath, "utf8")).toBe("stop-op-idle");

      // Once manual quiescence owns the fence, releasing the earlier idle
      // claim cannot reopen input or erase the exact completed Stop proof.
      const releaseResponse = await requestPrepareIdleStop(port, {
        action: "release",
        claimId: "claim-2",
      });
      expect(releaseResponse.status).toBe(200);
      expect(JSON.parse(readFileSync(preparedPath, "utf8"))).toEqual(responseReceipt);
      expect(readFileSync(stopOpIdPath, "utf8")).toBe("stop-op-idle");
      expect(harnessRequests).toEqual([
        { action: "claim", idleTimeoutMs: 60_000 },
        { action: "confirm", claimId: "claim-2" },
        { action: "confirm", claimId: "claim-2" },
        { opId: "stop-op-idle" },
        { action: "release", claimId: "claim-2" },
      ]);

      const replay = await requestPrepareStop(port, { stopOpId: "stop-op-idle" });
      expect(replay.status).toBe(200);
      expect(JSON.parse(replay.body).receipt).toEqual(responseReceipt);
      expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
        "idle=1 already=0 final=0",
        "idle=0 already=0 final=1",
      ]);
      expect(harnessRequests.at(-1)).toEqual({ opId: "stop-op-idle" });
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await closeServer(harnessServer);
    }
  });

  it("keeps manual stop independent when idle-claim confirmation is unavailable", async () => {
    const tempRoot = makeTempDir("tiller-stop-control-manual-fallback-test-");
    const socketPath = path.join(tempRoot, "harness.sock");
    const harnessRequests: Array<Record<string, unknown>> = [];
    let failConfirmation = false;
    const harnessServer = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      const parsed = JSON.parse(body) as Record<string, unknown>;
      harnessRequests.push(parsed);
      if (req.url === "/prepare-stop") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, opId: parsed.opId, status: "idle", idleSince: Date.now() }));
        return;
      }
      if (parsed.action === "confirm" && failConfirmation) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed.action === "release"
        ? {
            ok: true,
            eligible: false,
            remainingIdleMs: 0,
            reason: "released",
            claimReleased: true,
          }
        : {
            ok: true,
            eligible: true,
            remainingIdleMs: 0,
            reason: "eligible",
            claimId: "claim-3",
          }));
    });
    await listenOnSocket(harnessServer, socketPath);

    const stopFinalizePath = path.join(tempRoot, "stop-finalize.sh");
    const scriptPath = path.join(tempRoot, "stop-control-server.mjs");
    const invocationPath = path.join(tempRoot, "invocations.txt");
    const preparedPath = path.join(tempRoot, "prepared");
    const requestedPath = path.join(tempRoot, "requested");
    const stopOpIdPath = path.join(tempRoot, "stop-op-id");
    const port = 8796;
    writeFileSync(
      stopFinalizePath,
      `#!/bin/bash
set -euo pipefail
printf 'idle=%s already=%s final=%s\\n' \\
  "\${TILLER_IDLE_STOP_PREPARE_ONLY:-0}" \\
  "\${TILLER_WORKSPACE_ALREADY_SYNCED:-0}" \\
  "\${TILLER_STOP_FINALIZE:-0}" >> "${invocationPath}"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      scriptPath,
      readFileSync(STOP_CONTROL_SOURCE, "utf8").replaceAll("/stop-finalize.sh", stopFinalizePath),
      { mode: 0o755 },
    );
    const child = spawn("node", [scriptPath], {
      env: {
        ...isolatedStopControlEnv(tempRoot),
        TILLER_STOP_CONTROL_PORT: String(port),
        TILLER_HARNESS_CONTROL_SOCKET: socketPath,
        TILLER_STOP_PREPARED_FLAG_PATH: preparedPath,
        TILLER_STOP_REQUESTED_FLAG_PATH: requestedPath,
        TILLER_STOP_OP_ID_PATH: stopOpIdPath,
      },
      stdio: "ignore",
    });

    try {
      await waitForServer(port);
      const idleResponse = await requestPrepareIdleStop(port, { idleTimeoutMs: 60_000 });
      expect(idleResponse.status).toBe(200);
      expect(JSON.parse(idleResponse.body)).toMatchObject({
        ok: true,
        eligible: true,
        claimId: "claim-3",
      });

      failConfirmation = true;
      const manualStopResponse = await requestPrepareStop(port, { stopOpId: "manual-stop-op" });

      expect(manualStopResponse.status).toBe(200);
      expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
        "idle=1 already=0 final=0",
        "idle=0 already=0 final=1",
      ]);
      expect(harnessRequests).toEqual([
        { action: "claim", idleTimeoutMs: 60_000 },
        { action: "confirm", claimId: "claim-3" },
        { action: "confirm", claimId: "claim-3" },
        { action: "release", claimId: "claim-3" },
        { opId: "manual-stop-op" },
      ]);
      expect(readFileSync(stopOpIdPath, "utf8")).toBe("manual-stop-op");
    } finally {
      child.kill("SIGTERM");
      await waitForChildExit(child);
      await closeServer(harnessServer);
    }
  });
});
