import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseReleaseDescriptor } from "../packages/installer/src/release-contract.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
export const RELEASE_DESCRIPTOR_ASSET_NAME = "release-descriptor.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function releaseBundleName(version) {
  const normalized = String(version ?? "").trim();
  assert(
    /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(normalized),
    "Release version is invalid",
  );
  return `tiller-hub-v${normalized}.tar.gz`;
}

export function canonicalReleaseBundleUrl(
  version,
  repository = "paperwing-dev/tiller",
) {
  const bundleName = releaseBundleName(version);
  const normalizedRepository = String(repository ?? "").trim();
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepository),
    "Public release repository must be owner/name",
  );
  return `https://github.com/${normalizedRepository}/releases/download/tiller-hub-v${String(version).trim()}/${bundleName}`;
}

export function releaseDescriptorAssetUrl(bundleUrl) {
  const url = new URL(bundleUrl);
  const separator = url.pathname.lastIndexOf("/");
  assert(
    separator >= 0 && separator < url.pathname.length - 1,
    "Release bundle URL must name an artifact",
  );
  url.pathname = `${url.pathname.slice(0, separator + 1)}${RELEASE_DESCRIPTOR_ASSET_NAME}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

async function fetchPublishedBytes({
  url,
  fetchImpl,
  accept,
  label,
  maxBytes,
  expectedSize,
}) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    headers: { Accept: accept, "User-Agent": "tiller-release-verifier" },
  });
  assert(
    response.ok && response.body,
    `Published ${label} returned HTTP ${response.status}`,
  );
  const advertised = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(advertised) && advertised > 0) {
    assert(advertised <= maxBytes, `Published ${label} exceeds its size limit`);
    if (expectedSize !== undefined) {
      assert(
        advertised === expectedSize,
        `Published ${label} Content-Length does not match its expected size`,
      );
    }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.byteLength;
    assert(size <= maxBytes, `Published ${label} exceeds its size limit`);
    if (expectedSize !== undefined) {
      assert(
        size <= expectedSize,
        `Published ${label} exceeds its expected size`,
      );
    }
    chunks.push(bytes);
  }
  if (expectedSize !== undefined) {
    assert(
      size === expectedSize,
      `Published ${label} size does not match its expected size`,
    );
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

export async function verifyPublishedRelease({
  descriptorPath,
  fetchImpl = fetch,
}) {
  const descriptorBytes = await readFile(path.resolve(descriptorPath));
  const descriptor = parseReleaseDescriptor(
    JSON.parse(descriptorBytes.toString("utf8")),
  );
  assert(
    !/^0{40}$/.test(descriptor.releaseId),
    "Installer release ID cannot be the development sentinel",
  );
  assert(
    descriptor.bundle.size <= MAX_BUNDLE_BYTES,
    "Published bundle exceeds the installer size limit",
  );
  assert(
    descriptorBytes.byteLength <= MAX_DESCRIPTOR_BYTES,
    "Release descriptor exceeds its size limit",
  );

  const descriptorUrl = releaseDescriptorAssetUrl(descriptor.bundle.url);
  const publishedDescriptorBytes = await fetchPublishedBytes({
    url: descriptorUrl,
    fetchImpl,
    accept: "application/json",
    label: "release descriptor",
    maxBytes: MAX_DESCRIPTOR_BYTES,
  });
  assert(
    descriptorBytes.equals(publishedDescriptorBytes),
    `Published release descriptor differs for public snapshot SHA ${descriptor.releaseId}; release descriptors are immutable`,
  );

  const bundleBytes = await fetchPublishedBytes({
    url: descriptor.bundle.url,
    fetchImpl,
    accept: "application/octet-stream",
    label: "bundle",
    maxBytes: MAX_BUNDLE_BYTES,
    expectedSize: descriptor.bundle.size,
  });
  const digest = createHash("sha256").update(bundleBytes).digest("hex");
  assert(
    digest === descriptor.bundle.sha256,
    "Published bundle SHA-256 does not match its descriptor",
  );
  return {
    descriptor,
    descriptorUrl,
    size: bundleBytes.byteLength,
    sha256: digest,
  };
}
