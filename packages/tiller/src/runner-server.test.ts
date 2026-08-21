import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock, spawnSyncMock, tempHome, originalHome } = vi.hoisted(() => {
  const home = `/tmp/tiller-runner-home-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  return {
    spawnMock: vi.fn(),
    spawnSyncMock: vi.fn(),
    tempHome: home,
    originalHome: priorHome,
  };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

const {
  prepareDurableStop,
  buildContainerRunArgs,
  buildContainerEnvVars,
  buildDockerEnvFileContent,
  createDockerEnvFile,
  resolveOpencodeMount,
  removeLocalOpencodeState,
  HOST_OPENCODE_STATE_MOUNT_PATH,
  startRunnerServer,
} = await import("./runner-server.js");
const { RunnerCommandFenceStore } = await import("./runner-command-fence.js");

const LOCAL_STATE_DIR = resolve(tempHome, ".config", "tiller", "local");

function listTillerEnvTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith("tiller-env-"));
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

describe("runner-server host stop flow", () => {
  afterEach(async () => {
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    rmSync(LOCAL_STATE_DIR, { recursive: true, force: true });
  });

  it("inspects reviewer isolation capability once with a bounded Docker call", async () => {
    const sourceId = "a".repeat(40);
    const image = `docker.io/jamieatlason/tiller-sandbox:${sourceId}`;
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "1\n", stderr: "" });

    try {
      runner = await startRunnerServer({ port: 0, image, localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const healthUrl = `http://127.0.0.1:${address.port}/healthz`;

      for (let request = 0; request < 2; request += 1) {
        const response = await fetch(healthUrl);
        await expect(response.json()).resolves.toMatchObject({
          capabilities: { reviewerIsolationProtocol: 1 },
        });
      }

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["image", "inspect", image]),
        expect.objectContaining({ timeout: 2_000 }),
      );
    } finally {
      await runner?.close();
    }
  });

  it("prepares the container stop through the internal stop-control service before docker stop", async () => {
    const expectedDockerExec = ["exec", "tiller-demo-env", "sh", "-lc"];
    const dockerArgs: string[][] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();

      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stdout.emit("data", Buffer.from(JSON.stringify([{ State: { Status: "running" } }])));
        }
        child.emit("close", 0);
      });

      return child;
    });

    await prepareDurableStop("demo-env", "stop-op-1");

    expect(dockerArgs).toHaveLength(1);
    expect(dockerArgs[0]?.slice(0, 4)).toEqual(expectedDockerExec);
    expect(dockerArgs[0]?.[4]).toContain("curl -fsS --max-time 120 -X POST");
    expect(dockerArgs[0]?.[4]).toContain("http://127.0.0.1:8790/prepare-stop");
    expect(dockerArgs[0]?.[4]).toContain("X-Tiller-Lifecycle-Op-Id: stop-op-1");
    expect(dockerArgs[0]?.[4]).not.toContain("tiller-stop-requested");
  });

  it("creates a per-env OpenCode state mount under the local state dir", () => {
    const mount = resolveOpencodeMount({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "opencode" },
    });

    expect(mount).toEqual({
      sourcePath: resolve(LOCAL_STATE_DIR, "opencode", "demo-env"),
      targetPath: HOST_OPENCODE_STATE_MOUNT_PATH,
    });
    expect(existsSync(mount!.sourcePath)).toBe(true);
  });

  it("does not create an OpenCode state mount for other harnesses", () => {
    const mount = resolveOpencodeMount({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "codex" },
    });

    expect(mount).toBeNull();
    expect(existsSync(resolve(LOCAL_STATE_DIR, "opencode", "demo-env"))).toBe(false);
  });

  it("adds the OpenCode state mount to the host docker run args", () => {
    const runArgs = buildContainerRunArgs({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "opencode" },
    }, "demo-image", "/tmp/demo-env-file");

    expect(runArgs).toContain("-v");
    expect(runArgs).toContain(
      `${resolve(LOCAL_STATE_DIR, "opencode", "demo-env")}:${HOST_OPENCODE_STATE_MOUNT_PATH}`,
    );
    expect(runArgs).toContain("--env-file");
    expect(runArgs).toContain("/tmp/demo-env-file");
    expect(runArgs).not.toContain("-e");
  });

  it("mounts and labels the persisted command fence for fenced launches", () => {
    const fenceDirectory = resolve(LOCAL_STATE_DIR, "runner-fences", "demo");
    const runArgs = buildContainerRunArgs({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "codex" },
      commandGeneration: 7,
      operationId: "start-op-7",
      desiredState: "running",
    }, "demo-image", "/tmp/demo-env-file", { fenceDirectory });

    expect(runArgs).toContain("tiller.command-generation=7");
    expect(runArgs).toContain("tiller.operation-id=start-op-7");
    expect(runArgs).toContain(`${fenceDirectory}:/run/tiller-host-command:ro`);
    expect(buildContainerEnvVars({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: { TILLER_HARNESS: "codex" },
      commandGeneration: 7,
      operationId: "start-op-7",
      desiredState: "running",
    })).toMatchObject({
      TILLER_LIFECYCLE_START_OP_ID: "start-op-7",
      TILLER_HOST_COMMAND_GENERATION: "7",
      TILLER_HOST_COMMAND_FENCE_REQUIRED: "1",
    });
  });

  it("writes host launch env vars to Docker env-file content instead of docker args", () => {
    const runArgs = buildContainerRunArgs({
      slug: "demo-env",
      repoUrl: "https://github.com/example/repo",
      envVars: {
        TILLER_HARNESS: "codex",
        USER_SECRET: "super-secret-value",
      },
    }, "demo-image", "/tmp/demo-env-file");

    expect(runArgs.join(" ")).not.toContain("super-secret-value");
    expect(buildDockerEnvFileContent({
      TILLER_HARNESS: "codex",
      USER_SECRET: "super-secret-value",
    })).toBe("TILLER_HARNESS=codex\nUSER_SECRET=super-secret-value\n");
  });

  it("cleans up the Docker env-file temp dir if env-file content is invalid", () => {
    const before = new Set(listTillerEnvTempDirs());

    expect(() => createDockerEnvFile({
      TILLER_HARNESS: "codex",
      USER_SECRET: "line\nbreak",
    })).toThrow("USER_SECRET cannot be written to a Docker env file.");

    const leakedDirs = listTillerEnvTempDirs().filter((entry) => !before.has(entry));
    expect(leakedDirs).toEqual([]);
  });

  it("deletes persisted OpenCode state when an env is deleted", () => {
    const stateDir = resolve(LOCAL_STATE_DIR, "opencode", "demo-env");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, "state.db"), "demo");

    expect(removeLocalOpencodeState("demo-env")).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    expect(removeLocalOpencodeState("demo-env")).toBe(false);
  });

  it("falls back to container cleanup when persisted OpenCode state is not host-readable", async () => {
    const stateDir = resolve(LOCAL_STATE_DIR, "opencode", "locked-env");
    const dockerArgs: string[][] = [];
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, "state.db"), "demo");
    chmodSync(stateDir, 0o000);

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image" });
      const address = runner.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected runner server to bind a TCP port");
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/envs/locked-env`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandGeneration: 1,
          operationId: "delete-locked-env-1",
          desiredState: "absent",
        }),
      });

      expect(response.status).toBe(200);
      expect(dockerArgs).toContainEqual(["rm", "-f", "tiller-locked-env"]);
      expect(dockerArgs).toContainEqual([
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        "-v",
        `${resolve(LOCAL_STATE_DIR, "opencode")}:/tiller-opencode-state`,
        "demo-image",
        "-lc",
        'rm -rf -- "$1"',
        "sh",
        "/tiller-opencode-state/locked-env",
      ]);
    } finally {
      await runner?.close();
      if (existsSync(stateDir)) {
        chmodSync(stateDir, 0o700);
      }
    }
  });

  it("rejects every commandless mutation before its first Docker effect", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    spawnMock.mockImplementation(() => {
      throw new Error("Docker must not be called for an unfenced mutation");
    });

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const requests = [
        fetch(`${baseUrl}/envs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "create-env",
            repoUrl: "https://github.com/example/repo",
            envVars: { TILLER_HARNESS: "codex" },
          }),
        }),
        fetch(`${baseUrl}/envs/start-env/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoUrl: "https://github.com/example/repo",
            envVars: { TILLER_HARNESS: "codex" },
          }),
        }),
        fetch(`${baseUrl}/envs/stop-env/stop`, { method: "POST" }),
        fetch(`${baseUrl}/envs/delete-env`, { method: "DELETE" }),
      ];

      for (const response of await Promise.all(requests)) {
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          code: "runner_command_conflict",
        });
      }
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await runner?.close();
    }
  });

  it("rejects a delayed Start after a newer persisted Stop", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    const dockerArgs: string[][] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stderr.emit("data", Buffer.from("No such object"));
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const healthResponse = await fetch(`${baseUrl}/healthz`);
      await expect(healthResponse.json()).resolves.toMatchObject({
        capabilities: { runnerCommandProtocol: 1 },
      });

      const stopResponse = await fetch(`${baseUrl}/envs/demo-env/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandGeneration: 2,
          operationId: "stop-op-2",
          desiredState: "stopped",
        }),
      });
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toMatchObject({
        callbackExpected: false,
        commandGeneration: 2,
        operationId: "stop-op-2",
        desiredState: "stopped",
      });

      const startResponse = await fetch(`${baseUrl}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 1,
          operationId: "start-op-1",
          desiredState: "running",
        }),
      });
      expect(startResponse.status).toBe(409);
      await expect(startResponse.json()).resolves.toMatchObject({
        code: "runner_command_superseded_before_mutation",
        currentCommandGeneration: 2,
      });
      expect(dockerArgs.some((args) => args[0] === "run")).toBe(false);
    } finally {
      await runner?.close();
    }
  });

  it("returns a persisted Delete high-water before an initial Create can invoke Docker", async () => {
    const store = new RunnerCommandFenceStore(LOCAL_STATE_DIR);
    const deletion = store.accept("demo-env", {
      commandGeneration: 60,
      operationId: "destroy-op-60",
      desiredState: "absent",
    }, "absent");
    store.markApplied(deletion);
    spawnMock.mockImplementation(() => {
      throw new Error("Docker must not be invoked for a superseded Create");
    });
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");

      const response = await fetch(`http://127.0.0.1:${address.port}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 1,
          operationId: "start-op-1",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "runner_command_superseded_before_mutation",
        currentCommandGeneration: 60,
      });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await runner?.close();
    }
  });

  it("proves only an exact generation exited at the pre-workspace entrypoint fence", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          const container = args[1];
          const exitCode = container === "tiller-generic-exit" ? 1 : 75;
          const generation = container === "tiller-wrong-generation" ? 7 : 1;
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "exited", ExitCode: exitCode },
            Config: { Labels: { "tiller.command-generation": String(generation) } },
          }])));
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const stop = async (slug: string) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/envs/${slug}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandGeneration: 2,
            operationId: `stop-${slug}-2`,
            desiredState: "stopped",
          }),
        });
        expect(response.status).toBe(200);
        return response.json() as Promise<Record<string, unknown>>;
      };

      await expect(stop("fenced-exit")).resolves.toMatchObject({
        callbackExpected: false,
        startRejectedBeforeWorkspace: true,
      });
      await expect(stop("generic-exit")).resolves.toEqual(expect.not.objectContaining({
        startRejectedBeforeWorkspace: true,
      }));
      await expect(stop("wrong-generation")).resolves.toEqual(expect.not.objectContaining({
        startRejectedBeforeWorkspace: true,
      }));
    } finally {
      await runner?.close();
    }
  });

  it("leaves an overtaken live Start for the queued fenced Stop to save and stop", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    let delayedRun: FakeChildProcess | null = null;
    let containerExists = false;
    let notifyRunSpawned: (() => void) | null = null;
    const runSpawned = new Promise<void>((resolvePromise) => {
      notifyRunSpawned = resolvePromise;
    });
    let notifyStopCompleted: (() => void) | null = null;
    const stopCompleted = new Promise<void>((resolvePromise) => {
      notifyStopCompleted = resolvePromise;
    });
    const dockerArgs: string[][] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      if (args[0] === "run" && args.includes("--name")) {
        delayedRun = child;
        notifyRunSpawned?.();
        return child;
      }
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
          }])));
        }
        if (args[0] === "rm") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such container"));
            child.emit("close", 1);
            return;
          }
          containerExists = false;
        }
        if (args[0] === "stop") {
          containerExists = false;
          notifyStopCompleted?.();
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const startPromise = fetch(`${baseUrl}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 1,
          operationId: "start-op-1",
          desiredState: "running",
        }),
      });
      await runSpawned;

      const stopPromise = fetch(`${baseUrl}/envs/demo-env/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandGeneration: 2,
          operationId: "stop-op-2",
          desiredState: "stopped",
        }),
      });
      const store = new RunnerCommandFenceStore(LOCAL_STATE_DIR);
      while (store.read("demo-env")?.desiredState !== "stopped") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      }
      expect(existsSync(resolve(LOCAL_STATE_DIR, "runner-fences"))).toBe(true);

      containerExists = true;
      delayedRun!.emit("close", 0);
      const stopResponse = await stopPromise;
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toMatchObject({
        commandGeneration: 2,
        operationId: "stop-op-2",
        desiredState: "stopped",
      });
      const startResponse = await startPromise;
      expect(startResponse.status).toBe(409);
      await expect(startResponse.json()).resolves.toMatchObject({
        code: "runner_command_superseded",
      });
      await stopCompleted;
      expect(containerExists).toBe(false);
      expect(dockerArgs.some((args) => args[0] === "exec")).toBe(true);
      expect(dockerArgs.some((args) => args[0] === "stop")).toBe(true);
      const runIndex = dockerArgs.findIndex((args) => args[0] === "run");
      expect(runIndex).toBeGreaterThanOrEqual(0);
      expect(dockerArgs.slice(runIndex + 1).some((args) => args[0] === "rm")).toBe(false);
    } finally {
      await runner?.close();
    }
  });

  it("recovers an accepted Stop after Runner Server restarts", async () => {
    const store = new RunnerCommandFenceStore(LOCAL_STATE_DIR);
    store.accept("demo-env", {
      commandGeneration: 4,
      operationId: "stop-op-4",
      desiredState: "stopped",
    }, "stopped");
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    let notifyStopped: (() => void) | null = null;
    const stopped = new Promise<void>((resolvePromise) => {
      notifyStopped = resolvePromise;
    });

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
            Config: { Labels: { "tiller.command-generation": "3" } },
          }])));
        }
        child.emit("close", 0);
        if (args[0] === "stop") notifyStopped?.();
      });
      return child;
    });

    try {
      runner = await startRunnerServer({
        port: 0,
        image: "demo-image",
        localStateDir: LOCAL_STATE_DIR,
      });
      await stopped;
      expect(store.read("demo-env")).toMatchObject({
        operationId: "stop-op-4",
        desiredState: "stopped",
        phase: "applied",
      });
      expect(store.readWorkspaceSyncedStop("demo-env")).toMatchObject({
        stopCommandGeneration: 4,
        stopOperationId: "stop-op-4",
        runnerCommandGeneration: 3,
      });
    } finally {
      await runner?.close();
    }
  });

  it("replays an applied Create by inspecting its exact runner without replacing the workspace", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    let containerExists = false;
    let containerGeneration = 0;
    let workspaceContents = "initial workspace";
    const dockerArgs: string[][] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
            Config: { Labels: { "tiller.command-generation": String(containerGeneration) } },
          }])));
        } else if (args[0] === "rm") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such container"));
            child.emit("close", 1);
            return;
          }
          containerExists = false;
          workspaceContents = "";
        } else if (args[0] === "run") {
          const generationLabel = args.find((value) => value.startsWith("tiller.command-generation="));
          containerGeneration = Number(generationLabel?.split("=")[1]);
          containerExists = true;
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const command = {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        envVars: { TILLER_HARNESS: "codex" },
        commandGeneration: 1,
        operationId: "create-op-1",
        desiredState: "running",
      } as const;

      // The first response is deliberately ignored, modeling a response that
      // was lost after Docker created the runner and the fence was committed.
      const firstResponse = await fetch(`http://127.0.0.1:${address.port}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      expect(firstResponse.status).toBe(201);
      workspaceContents = "unsaved work produced by the live runner";
      const mutationsAfterFirstResponse = dockerArgs.filter((args) => args[0] === "rm" || args[0] === "run");

      const replayResponse = await fetch(`http://127.0.0.1:${address.port}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });

      expect(replayResponse.status).toBe(201);
      await expect(replayResponse.json()).resolves.toMatchObject({
        runnerId: "tiller-demo-env",
        status: "running",
        commandGeneration: 1,
        operationId: "create-op-1",
        desiredState: "running",
      });
      expect(dockerArgs.filter((args) => args[0] === "rm" || args[0] === "run"))
        .toEqual(mutationsAfterFirstResponse);
      expect(workspaceContents).toBe("unsaved work produced by the live runner");
    } finally {
      await runner?.close();
    }
  });

  it("never recreates a missing runner when an applied Start is replayed", async () => {
    const store = new RunnerCommandFenceStore(LOCAL_STATE_DIR);
    const applied = store.accept("demo-env", {
      commandGeneration: 3,
      operationId: "start-op-3",
      desiredState: "running",
    }, "running");
    store.markApplied(applied!);
    const dockerArgs: string[][] = [];
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stderr.emit("data", Buffer.from("No such object"));
          child.emit("close", 1);
          return;
        }
        child.emit("close", 0);
      });
      return child;
    });

    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 3,
          operationId: "start-op-3",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(409);
      expect(dockerArgs.some((args) => args[0] === "rm" || args[0] === "run" || args[0] === "start"))
        .toBe(false);
      expect(store.read("demo-env")).toMatchObject({
        commandGeneration: 3,
        operationId: "start-op-3",
        phase: "applied",
      });
    } finally {
      await runner?.close();
    }
  });

  it("refuses to replace a live runner from an older command generation", async () => {
    const dockerArgs: string[][] = [];
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
            Config: { Labels: { "tiller.command-generation": "1" } },
          }])));
        }
        child.emit("close", 0);
      });
      return child;
    });

    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 2,
          operationId: "start-op-2",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(409);
      expect(dockerArgs.some((args) => args[0] === "rm" || args[0] === "run")).toBe(false);
    } finally {
      await runner?.close();
    }
  });

  it("refuses to remove a stopped runner without its matching persistence acknowledgement", async () => {
    const dockerArgs: string[][] = [];
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "exited", ExitCode: 1 },
            Config: { Labels: { "tiller.command-generation": "1" } },
          }])));
        }
        child.emit("close", 0);
      });
      return child;
    });

    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 2,
          operationId: "start-op-2",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(409);
      expect(dockerArgs.some((args) => args[0] === "rm" || args[0] === "run")).toBe(false);
    } finally {
      await runner?.close();
    }
  });

  it("removes a stopped runner proven to have failed before harness launch without force", async () => {
    let exists = true;
    let generation = 1;
    let operationId = "start-op-1";
    let status = "exited";
    let exitCode = 76;
    const dockerArgs: string[][] = [];
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!exists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: status, ExitCode: exitCode },
            Config: { Labels: {
              "tiller.command-generation": String(generation),
              "tiller.operation-id": operationId,
            } },
          }])));
        } else if (args[0] === "rm") {
          exists = false;
        } else if (args[0] === "run") {
          exists = true;
          generation = 2;
          operationId = "start-op-2";
          status = "running";
          exitCode = 0;
        }
        child.emit("close", 0);
      });
      return child;
    });

    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const statusResponse = await fetch(`http://127.0.0.1:${address.port}/envs/demo-env`);
      await expect(statusResponse.json()).resolves.toMatchObject({
        status: "stopped",
        failedStartBeforeHarness: true,
        commandGeneration: 1,
        operationId: "start-op-1",
      });

      const response = await fetch(`http://127.0.0.1:${address.port}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 2,
          operationId: "start-op-2",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(200);
      expect(dockerArgs).toContainEqual(["rm", "tiller-demo-env"]);
      expect(dockerArgs).not.toContainEqual(["rm", "-f", "tiller-demo-env"]);
    } finally {
      await runner?.close();
    }
  });

  it("removes only an exact stopped runner with acknowledged persistence and never uses force", async () => {
    const store = new RunnerCommandFenceStore(LOCAL_STATE_DIR);
    store.accept("demo-env", {
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    }, "running");
    const stop = store.accept("demo-env", {
      commandGeneration: 2,
      operationId: "stop-op-2",
      desiredState: "stopped",
    }, "stopped");
    store.recordWorkspaceSyncedStop(stop, 1);
    store.markApplied(stop);

    let exists = true;
    let generation = 1;
    let status = "exited";
    const dockerArgs: string[][] = [];
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!exists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: status },
            Config: { Labels: { "tiller.command-generation": String(generation) } },
          }])));
        } else if (args[0] === "rm") {
          exists = false;
        } else if (args[0] === "run") {
          generation = 3;
          status = "running";
          exists = true;
        }
        child.emit("close", 0);
      });
      return child;
    });

    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 3,
          operationId: "start-op-3",
          desiredState: "running",
        }),
      });

      expect(response.status).toBe(200);
      expect(dockerArgs).toContainEqual(["rm", "tiller-demo-env"]);
      expect(dockerArgs).not.toContainEqual(["rm", "-f", "tiller-demo-env"]);
      expect(dockerArgs.some((args) => args[0] === "run")).toBe(true);
    } finally {
      await runner?.close();
    }
  });

  it("deduplicates identical Create requests while the accepted command is still in flight", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    let containerExists = false;
    let delayedRun: FakeChildProcess | null = null;
    let notifyRunSpawned: (() => void) | null = null;
    const runSpawned = new Promise<void>((resolvePromise) => {
      notifyRunSpawned = resolvePromise;
    });
    const dockerArgs: string[][] = [];

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      dockerArgs.push(args);
      const child = new FakeChildProcess();
      if (args[0] === "run") {
        delayedRun = child;
        notifyRunSpawned?.();
        return child;
      }
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
            Config: { Labels: { "tiller.command-generation": "1" } },
          }])));
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const url = `http://127.0.0.1:${address.port}/envs`;
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          commandGeneration: 1,
          operationId: "create-op-1",
          desiredState: "running",
        }),
      };

      const firstRequest = fetch(url, init);
      await runSpawned;
      const duplicateRequest = fetch(url, init);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      containerExists = true;
      delayedRun!.emit("close", 0);

      const [firstResponse, duplicateResponse] = await Promise.all([firstRequest, duplicateRequest]);
      expect(firstResponse.status).toBe(201);
      expect(duplicateResponse.status).toBe(201);
      expect(dockerArgs.filter((args) => args[0] === "rm")).toHaveLength(0);
      expect(dockerArgs.filter((args) => args[0] === "run")).toHaveLength(1);
    } finally {
      await runner?.close();
    }
  });

  it("echoes the accepted fence tuple for every fenced mutation response", async () => {
    let runner: Awaited<ReturnType<typeof startRunnerServer>> | null = null;
    let containerExists = false;
    let containerGeneration = 0;

    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeChildProcess();
      queueMicrotask(() => {
        if (args[0] === "inspect") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such object"));
            child.emit("close", 1);
            return;
          }
          child.stdout.emit("data", Buffer.from(JSON.stringify([{
            State: { Status: "running" },
            Config: { Labels: { "tiller.command-generation": String(containerGeneration) } },
          }])));
        } else if (args[0] === "rm") {
          if (!containerExists) {
            child.stderr.emit("data", Buffer.from("No such container"));
            child.emit("close", 1);
            return;
          }
          containerExists = false;
        } else if (args[0] === "run") {
          const generationLabel = args.find((value) => value.startsWith("tiller.command-generation="));
          containerGeneration = Number(generationLabel?.split("=")[1]);
          containerExists = true;
        } else if (args[0] === "stop") {
          containerExists = false;
        }
        child.emit("close", 0);
      });
      return child;
    });

    try {
      runner = await startRunnerServer({ port: 0, image: "demo-image", localStateDir: LOCAL_STATE_DIR });
      const address = runner.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const runningCommand = {
        commandGeneration: 1,
        operationId: "start-op-1",
        desiredState: "running",
      } as const;

      const createResponse = await fetch(`${baseUrl}/envs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          ...runningCommand,
        }),
      });
      expect(createResponse.status).toBe(201);
      await expect(createResponse.json()).resolves.toMatchObject(runningCommand);

      const startResponse = await fetch(`${baseUrl}/envs/demo-env/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/example/repo",
          envVars: { TILLER_HARNESS: "codex" },
          ...runningCommand,
        }),
      });
      expect(startResponse.status).toBe(200);
      await expect(startResponse.json()).resolves.toMatchObject(runningCommand);

      const stoppedCommand = {
        commandGeneration: 2,
        operationId: "stop-op-2",
        desiredState: "stopped",
      } as const;
      const stopResponse = await fetch(`${baseUrl}/envs/demo-env/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stoppedCommand),
      });
      expect(stopResponse.status).toBe(200);
      await expect(stopResponse.json()).resolves.toMatchObject(stoppedCommand);

      const absentCommand = {
        commandGeneration: 3,
        operationId: "delete-op-3",
        desiredState: "absent",
      } as const;
      const destroyResponse = await fetch(`${baseUrl}/envs/demo-env`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(absentCommand),
      });
      expect(destroyResponse.status).toBe(200);
      await expect(destroyResponse.json()).resolves.toMatchObject(absentCommand);
    } finally {
      await runner?.close();
    }
  });
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});
