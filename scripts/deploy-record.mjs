#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSelfHostDeployRecord } from "../packages/hub/scripts/self-host-runtime-contract.mjs";

export function normalizeDeployRecord(record) {
  return normalizeSelfHostDeployRecord(record);
}

export function parseDeployRecordContent(content) {
  return normalizeDeployRecord(JSON.parse(content));
}

export function parseTaggedDeployRecordContent(content, expectedHubCommitSha) {
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("deploy tag record must be a JSON object.");
  }
  if (parsed.schemaVersion !== 2) {
    throw new Error("deploy tag record must use schemaVersion 2.");
  }
  if (Object.hasOwn(parsed, "commitSha")) {
    throw new Error("deploy tag record must not contain legacy commitSha.");
  }

  const normalized = normalizeDeployRecord(parsed);
  if (normalized.hubCommitSha !== expectedHubCommitSha) {
    throw new Error(
      `deploy tag record hubCommitSha ${normalized.hubCommitSha} does not match tagged commit ${expectedHubCommitSha}.`,
    );
  }
  if (
    !normalized.recordedAt
    || Number.isNaN(Date.parse(normalized.recordedAt))
    || new Date(normalized.recordedAt).toISOString() !== normalized.recordedAt
  ) {
    throw new Error("deploy tag record recordedAt must be a canonical ISO timestamp.");
  }

  return normalized;
}

export function readDeployRecordFile(recordPath) {
  return parseDeployRecordContent(fs.readFileSync(recordPath, "utf8"));
}

export function formatDeployRecord(record, recordedAt = new Date().toISOString()) {
  const normalized = normalizeDeployRecord({ ...record, recordedAt });
  return JSON.stringify({
    schemaVersion: 2,
    hubCommitSha: normalized.hubCommitSha,
    imageCommitSha: normalized.imageCommitSha,
    sandboxImage: normalized.sandboxImage,
    scmImage: normalized.scmImage,
    ...(normalized.reviewerIsolationProtocol === 1 ? { reviewerIsolationProtocol: 1 } : {}),
    recordedAt,
  }, null, 2) + "\n";
}

export function writeDeployRecordFile(recordPath, record) {
  fs.writeFileSync(recordPath, formatDeployRecord(record));
}

export function syncDeployRecordFile(recordPath, content, expectedHubCommitSha) {
  const record = parseTaggedDeployRecordContent(content, expectedHubCommitSha);
  fs.writeFileSync(recordPath, formatDeployRecord(record, record.recordedAt));
}

function printRecord(record) {
  process.stdout.write([
    record.hubCommitSha,
    record.imageCommitSha,
    record.sandboxImage,
    record.scmImage,
    record.reviewerIsolationProtocol === 1 ? "1" : "0",
  ].join("\n") + "\n");
}

function runCli(argv) {
  const [command, recordPath, ...args] = argv;
  if (command === "read" && recordPath) {
    printRecord(readDeployRecordFile(recordPath));
    return;
  }

  if (command === "write" && recordPath) {
    const [hubCommitSha, imageCommitSha, sandboxImage, scmImage, reviewerIsolationProtocol] = args;
    if (reviewerIsolationProtocol !== undefined
      && reviewerIsolationProtocol !== "0"
      && reviewerIsolationProtocol !== "1") {
      throw new Error("reviewerIsolationProtocol must be 0 or 1.");
    }
    writeDeployRecordFile(recordPath, {
      hubCommitSha,
      imageCommitSha,
      sandboxImage,
      scmImage,
      ...(reviewerIsolationProtocol === "1" ? { reviewerIsolationProtocol: 1 } : {}),
    });
    return;
  }

  if (command === "sync-tag" && recordPath) {
    const [expectedHubCommitSha] = args;
    syncDeployRecordFile(
      recordPath,
      fs.readFileSync(process.stdin.fd, "utf8"),
      expectedHubCommitSha,
    );
    return;
  }

  throw new Error(
    "Usage: deploy-record.mjs read <path> | write <path> <hubCommitSha> <imageCommitSha> <sandboxImage> <scmImage> [reviewerIsolationProtocol] | sync-tag <path> <expectedHubCommitSha>",
  );
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === currentFile) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
