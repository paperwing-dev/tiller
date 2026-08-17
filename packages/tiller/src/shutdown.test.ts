import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, stopChildProcess } from "./shutdown.js";

type FakeChild = ChildProcess & EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stdin: EventEmitter & { destroy: ReturnType<typeof vi.fn> };
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.stdin = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  child.kill = vi.fn(() => true);
  child.unref = vi.fn();
  return child;
}

function fakeServer(): http.Server & {
  close: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
} {
  let server: http.Server & {
    close: ReturnType<typeof vi.fn>;
    closeIdleConnections: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
  };
  server = {
    close: vi.fn(() => server),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  } as unknown as typeof server;
  return server;
}

describe("shutdown helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("force closes HTTP connections and resolves if server.close never finishes", async () => {
    vi.useFakeTimers();
    const server = fakeServer();

    const pending = closeHttpServer(server, {
      forceAfterMs: 100,
      resolveAfterMs: 250,
    });

    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(150);
    await expect(pending).resolves.toBeUndefined();
    expect(server.closeAllConnections).toHaveBeenCalledTimes(2);
  });

  it("forwards the requested signal and escalates child shutdown to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = fakeChild();

    const pending = stopChildProcess(child, {
      signal: "SIGINT",
      termGraceMs: 100,
      killGraceMs: 100,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGINT");

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBeUndefined();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("does not SIGKILL a child that exits during SIGTERM grace", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        setTimeout(() => {
          child.signalCode = "SIGTERM";
          child.emit("exit", null, "SIGTERM");
        }, 50);
      }
      return true;
    });

    const pending = stopChildProcess(child, {
      termGraceMs: 100,
      killGraceMs: 100,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
  });
});
