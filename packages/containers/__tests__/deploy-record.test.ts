import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  formatDeployRecord,
  normalizeDeployRecord,
  parseDeployRecordContent,
  parseTaggedDeployRecordContent,
  syncDeployRecordFile,
} = await import("../../../scripts/deploy-record.mjs");

const HUB_SHA = "a".repeat(40);
const IMAGE_SHA = "b".repeat(40);
const LEGACY_SHA = "c".repeat(40);

describe("self-host deploy record", () => {
  it("normalizes legacy v1 records into v2 authority fields", () => {
    expect(normalizeDeployRecord({
      commitSha: LEGACY_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${LEGACY_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${LEGACY_SHA}`,
    })).toMatchObject({
      schemaVersion: 2,
      hubCommitSha: LEGACY_SHA,
      imageCommitSha: LEGACY_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${LEGACY_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${LEGACY_SHA}`,
    });
  });

  it("preserves split hub and image commit authority in v2 records", () => {
    expect(parseDeployRecordContent(JSON.stringify({
      schemaVersion: 2,
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
      recordedAt: "2026-05-27T00:00:00.000Z",
    }))).toMatchObject({
      schemaVersion: 2,
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    });
  });

  it("writes schema v2 records without legacy commitSha", () => {
    const content = formatDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    }, "2026-05-27T00:00:00.000Z");

    expect(JSON.parse(content)).toEqual({
      schemaVersion: 2,
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
      recordedAt: "2026-05-27T00:00:00.000Z",
    });
    expect(content).not.toContain("commitSha");
  });

  it("persists verified reviewer isolation protocol evidence", () => {
    const content = formatDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
      reviewerIsolationProtocol: 1,
    }, "2026-05-27T00:00:00.000Z");

    expect(JSON.parse(content)).toMatchObject({
      reviewerIsolationProtocol: 1,
    });
    expect(parseDeployRecordContent(content)).toMatchObject({
      reviewerIsolationProtocol: 1,
    });
  });

  it("rejects unverified reviewer isolation protocol values", () => {
    expect(() => normalizeDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
      reviewerIsolationProtocol: 0,
    })).toThrow(/reviewerIsolationProtocol must be 1/);
  });

  it("accepts an authoritative tagged record for its tagged commit", () => {
    const content = formatDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    }, "2026-05-27T00:00:00.000Z");

    expect(parseTaggedDeployRecordContent(content, HUB_SHA)).toMatchObject({
      schemaVersion: 2,
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      recordedAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("rejects a tagged record that belongs to another commit", () => {
    const content = formatDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    }, "2026-05-27T00:00:00.000Z");

    expect(() => parseTaggedDeployRecordContent(content, LEGACY_SHA)).toThrow(
      /does not match tagged commit/,
    );
  });

  it("rejects legacy records as authoritative tag payloads", () => {
    expect(() => parseTaggedDeployRecordContent(JSON.stringify({
      commitSha: LEGACY_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${LEGACY_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${LEGACY_SHA}`,
    }), LEGACY_SHA)).toThrow(/schemaVersion 2/);
  });

  it("replaces a stale local cache with the validated tagged record", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "tiller-deploy-record-"));
    const recordPath = path.join(tempDir, "deploy-record.json");
    const taggedContent = formatDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${IMAGE_SHA}`,
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    }, "2026-05-27T00:00:00.000Z");

    try {
      writeFileSync(recordPath, JSON.stringify({
        commitSha: LEGACY_SHA,
        sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${LEGACY_SHA}`,
        scmImage: `docker.io/jamieatlason/tiller-scm:${LEGACY_SHA}`,
      }));

      syncDeployRecordFile(recordPath, taggedContent, HUB_SHA);

      expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(JSON.parse(taggedContent));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects mutable image refs", () => {
    expect(() => normalizeDeployRecord({
      hubCommitSha: HUB_SHA,
      imageCommitSha: IMAGE_SHA,
      sandboxImage: "docker.io/jamieatlason/tiller-sandbox:latest",
      scmImage: `docker.io/jamieatlason/tiller-scm:${IMAGE_SHA}`,
    })).toThrow(/sandboxImage/);
  });
});
