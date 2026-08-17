import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  HUB_BUILD_LOCK_ENV,
  HubBuildLockBusyError,
  acquireHubBuildLock,
  assertHubBuildLockOwnership,
  readHubBuildLock,
  releaseHubBuildLock,
  runWithHubBuildLock,
} from "../../../scripts/hub-build-lock.mjs";

const FIRST_TOKEN = "11111111-1111-4111-8111-111111111111";
const SECOND_TOKEN = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];

function temporaryLockPath(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "tiller-hub-build-lock-"));
  temporaryDirectories.push(directory);
  return path.join(directory, ".tiller-hub-build.lock");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hub build lock", () => {
  it("acquires and releases an owner-verified lock", () => {
    const lockPath = temporaryLockPath();
    const owner = acquireHubBuildLock({
      lockPath,
      purpose: "deploy:dev",
      pid: process.pid,
      hostname: "test-host",
      token: FIRST_TOKEN,
    });

    expect(readHubBuildLock(lockPath)).toEqual(owner);
    expect(() => releaseHubBuildLock({ lockPath, token: SECOND_TOKEN }))
      .toThrow("ownership changed");
    expect(releaseHubBuildLock({ lockPath, token: FIRST_TOKEN })).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails immediately when a live owner holds the lock", () => {
    const lockPath = temporaryLockPath();
    acquireHubBuildLock({
      lockPath,
      purpose: "deploy:dev",
      pid: 101,
      hostname: "test-host",
      token: FIRST_TOKEN,
    });

    expect(() => acquireHubBuildLock({
      lockPath,
      purpose: "hub-build",
      pid: 202,
      hostname: "test-host",
      token: SECOND_TOKEN,
      processAlive: () => true,
    })).toThrowError(HubBuildLockBusyError);
    expect(() => acquireHubBuildLock({
      lockPath,
      purpose: "hub-build",
      pid: 202,
      hostname: "test-host",
      token: SECOND_TOKEN,
      processAlive: () => true,
    })).toThrow("No waiting was performed");
  });

  it("recovers a same-host lock only after its owner is dead", () => {
    const lockPath = temporaryLockPath();
    acquireHubBuildLock({
      lockPath,
      purpose: "hub-build",
      pid: 101,
      hostname: "test-host",
      token: FIRST_TOKEN,
    });

    const owner = acquireHubBuildLock({
      lockPath,
      purpose: "deploy:dev",
      pid: 202,
      hostname: "test-host",
      token: SECOND_TOKEN,
      processAlive: (pid: number) => pid !== 101,
    });

    expect(owner.token).toBe(SECOND_TOKEN);
    expect(readHubBuildLock(lockPath)?.purpose).toBe("deploy:dev");
  });

  it("does not reclaim a lock owned on another host", () => {
    const lockPath = temporaryLockPath();
    acquireHubBuildLock({
      lockPath,
      purpose: "hub-build",
      pid: 101,
      hostname: "other-host",
      token: FIRST_TOKEN,
    });

    expect(() => acquireHubBuildLock({
      lockPath,
      purpose: "deploy:dev",
      pid: 202,
      hostname: "test-host",
      token: SECOND_TOKEN,
      processAlive: () => false,
    })).toThrowError(HubBuildLockBusyError);
  });

  it("allows the owning deploy to run its nested Hub build", async () => {
    const lockPath = temporaryLockPath();
    acquireHubBuildLock({
      lockPath,
      purpose: "deploy:dev",
      pid: process.pid,
      hostname: os.hostname(),
      token: FIRST_TOKEN,
    });

    expect(assertHubBuildLockOwnership({ lockPath, token: FIRST_TOKEN }))
      .toMatchObject({ purpose: "deploy:dev" });
    await expect(runWithHubBuildLock({
      lockPath,
      purpose: "hub-build",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env: { ...process.env, [HUB_BUILD_LOCK_ENV]: FIRST_TOKEN },
      stdio: "ignore",
    })).resolves.toBe(0);
    expect(readHubBuildLock(lockPath)?.token).toBe(FIRST_TOKEN);

    releaseHubBuildLock({ lockPath, token: FIRST_TOKEN });
  });

  it("releases a normal build lock after its child exits", async () => {
    const lockPath = temporaryLockPath();
    const env = { ...process.env };
    delete env[HUB_BUILD_LOCK_ENV];

    await expect(runWithHubBuildLock({
      lockPath,
      purpose: "hub-build",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      env,
      stdio: "ignore",
    })).resolves.toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("Hub build lock wiring", () => {
  it("routes package builds and deploy:dev through the shared lock", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    ));
    expect(packageJson.scripts.build).toBe(
      "node ../../scripts/hub-build-lock.mjs run hub-build -- vite build",
    );

    const deploySource = readFileSync(
      new URL("../../../scripts/deploy-dev.sh", import.meta.url),
      "utf8",
    );
    expect(deploySource).toContain("acquire_hub_build_lock");
    expect(deploySource.indexOf("  acquire_hub_build_lock\n"))
      .toBeLessThan(deploySource.indexOf("  configure_maintainer_dev_target\n"));
  });
});
