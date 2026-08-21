import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMaintainerDevTarget } from "./maintainer-dev-target.mjs";

const ACCOUNT_ID = "a".repeat(32);
const ACCOUNT_SUBDOMAIN = "maintainer-preview";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function checkpointPath(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "tiller-dev-target-"));
  temporaryDirectories.push(directory);
  const checkpoint = path.join(directory, ".tiller-dev-bootstrap.json");
  await writeFile(
    checkpoint,
    JSON.stringify({
      accountId: ACCOUNT_ID,
      workerName: "tiller-dev",
      resources: {
        workersDevHostname: `tiller-dev.${ACCOUNT_SUBDOMAIN}.workers.dev`,
      },
    }),
    { mode },
  );
  await chmod(checkpoint, mode);
  return checkpoint;
}

describe("maintainer dev target resolver", () => {
  it("uses the private checkpoint as the established target", async () => {
    const checkpoint = await checkpointPath();
    expect(
      resolveMaintainerDevTarget({ checkpointPath: checkpoint, env: {} }),
    ).toEqual({
      accountId: ACCOUNT_ID,
      accountSubdomain: ACCOUNT_SUBDOMAIN,
      workerName: "tiller-dev",
      hostname: `tiller-dev.${ACCOUNT_SUBDOMAIN}.workers.dev`,
    });
  });

  it("rejects local configuration that differs from the checkpoint", async () => {
    const checkpoint = await checkpointPath();
    expect(() =>
      resolveMaintainerDevTarget({
        checkpointPath: checkpoint,
        env: {
          TILLER_MAINTAINER_DEV_ACCOUNT_ID: "b".repeat(32),
          TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN: ACCOUNT_SUBDOMAIN,
        },
      }),
    ).toThrow(/differs from the local checkpoint/);
  });

  it("requires explicit local configuration for a fresh bootstrap", () => {
    expect(
      resolveMaintainerDevTarget({
        checkpointPath: "/missing/checkpoint.json",
        env: {
          TILLER_MAINTAINER_DEV_ACCOUNT_ID: ACCOUNT_ID,
          TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN: ACCOUNT_SUBDOMAIN,
        },
      }),
    ).toMatchObject({
      accountId: ACCOUNT_ID,
      accountSubdomain: ACCOUNT_SUBDOMAIN,
    });
    expect(() =>
      resolveMaintainerDevTarget({
        checkpointPath: "/missing/checkpoint.json",
        env: {},
      }),
    ).toThrow(/Fresh maintainer bootstrap requires/);
  });

  it("refuses to read a checkpoint with public permissions", async () => {
    const checkpoint = await checkpointPath(0o644);
    expect(() =>
      resolveMaintainerDevTarget({ checkpointPath: checkpoint, env: {} }),
    ).toThrow(/mode 0600/);
  });
});
