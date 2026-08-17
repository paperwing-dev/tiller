import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  createAssetUploadSession,
  uploadAssetBatch,
  uploadSingleAsset,
  type CloudflareAuthorization,
} from "./cloudflare-api";
import { sha256Hex } from "./crypto";
import { readBoundedResponseBytes, withAbortDeadline } from "./outbound";
import type { ReleaseDescriptorV1 } from "./types";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_TAR_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const ALLOWED_PAX_METADATA_KEYS = new Set([
  "mtime",
  "LIBARCHIVE.xattr.com.apple.provenance",
  "SCHILY.xattr.com.apple.provenance",
]);

export class RetryableBundleDownloadError extends Error {
  constructor() {
    super("Release bundle is temporarily unavailable");
    this.name = "RetryableBundleDownloadError";
  }
}

export interface ReleaseBundle {
  modules: Array<{ name: string; content: Uint8Array; contentType: string }>;
  assets: Array<{ path: string; content: Uint8Array; contentType: string }>;
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  deadline: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error("Release bundle download expired");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error("Expanded release archive is too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeEntryPath(raw: string): string {
  const path = raw.replace(/^\/+/, "");
  if (!path || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Release archive contains an unsafe path");
  }
  return path;
}

function isMacMetadataPath(path: string): boolean {
  return path.split("/").some((part) => (
    part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._")
  ));
}

function parseOctal(bytes: Uint8Array): number {
  const value = new TextDecoder().decode(bytes).replace(/\0.*$/, "").trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("Release archive contains an invalid entry size");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Release archive entry is too large");
  return parsed;
}

function verifyTarChecksum(header: Uint8Array): void {
  const expected = parseOctal(header.slice(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (expected !== actual) throw new Error("Release archive checksum is invalid");
}

function validateIgnoredPaxMetadata(bytes: Uint8Array): void {
  if (bytes.byteLength === 0) throw new Error("Release archive contains invalid PAX metadata");
  let offset = 0;
  while (offset < bytes.byteLength) {
    let separator = offset;
    let recordLength = 0;
    while (separator < bytes.byteLength && bytes[separator] !== 0x20) {
      const digit = bytes[separator] - 0x30;
      if (digit < 0 || digit > 9 || separator - offset >= 15) {
        throw new Error("Release archive contains invalid PAX metadata");
      }
      recordLength = recordLength * 10 + digit;
      separator += 1;
    }
    const end = offset + recordLength;
    if (separator === offset || separator >= bytes.byteLength
      || !Number.isSafeInteger(recordLength) || end > bytes.byteLength
      || end <= separator + 3 || bytes[end - 1] !== 0x0a) {
      throw new Error("Release archive contains invalid PAX metadata");
    }
    const equals = bytes.indexOf(0x3d, separator + 1);
    if (equals < 0 || equals >= end - 1 || equals - separator > 128) {
      throw new Error("Release archive contains invalid PAX metadata");
    }
    let key = "";
    for (let index = separator + 1; index < equals; index += 1) {
      if (bytes[index] < 0x21 || bytes[index] > 0x7e) {
        throw new Error("Release archive contains invalid PAX metadata");
      }
      key += String.fromCharCode(bytes[index]);
    }
    if (!ALLOWED_PAX_METADATA_KEYS.has(key)) {
      throw new Error("Release archive contains unsupported PAX metadata");
    }
    offset = end;
  }
}

export function readReleaseTar(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > MAX_TAR_BYTES) throw new Error("Expanded release archive is too large");
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.slice(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const name = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, "");
    const prefix = decoder.decode(header.slice(345, 500)).replace(/\0.*$/, "");
    const type = decoder.decode(header.slice(156, 157));
    const size = parseOctal(header.slice(124, 136));
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > bytes.byteLength) throw new Error("Release archive is truncated");
    if (type === "0" || type === "\0" || type === "") {
      const path = safeEntryPath(prefix ? `${prefix}/${name}` : name);
      if (!isMacMetadataPath(path)) {
        if (entries.has(path)) throw new Error("Release archive contains a duplicate path");
        entries.set(path, bytes.slice(offset, offset + size));
        if (entries.size > MAX_ENTRIES) throw new Error("Release archive contains too many files");
      }
    } else if (type === "x") {
      validateIgnoredPaxMetadata(bytes.slice(offset, offset + size));
    } else if (type !== "5") {
      throw new Error("Release archive contains an unsupported entry type");
    }
    offset += padded;
  }
  return entries;
}

function moduleContentType(path: string): string {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/javascript+module";
}

function assetContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return ({
    css: "text/css",
    html: "text/html",
    js: "text/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    txt: "text/plain",
    xml: "application/xml",
    webmanifest: "application/manifest+json",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function remainingBundleTimeout(deadline: number): number {
  const remaining = Math.floor(deadline - Date.now());
  if (!Number.isFinite(deadline) || remaining <= 0) {
    throw new Error("Release bundle download expired");
  }
  return Math.min(60_000, remaining);
}

export async function fetchReleaseBundle(
  descriptor: ReleaseDescriptorV1,
  deadline: number,
): Promise<ReleaseBundle> {
  if (descriptor.bundle.size > MAX_ARCHIVE_BYTES) throw new Error("Release bundle exceeds the installer limit");
  const archive = await withAbortDeadline(async (signal) => {
    let response: Response;
    try {
      response = await fetch(descriptor.bundle.url, {
        // GitHub release downloads redirect to its object store. Integrity is
        // anchored by the descriptor's exact byte length and SHA-256 below.
        redirect: "follow",
        signal,
        headers: { Accept: "application/octet-stream", "User-Agent": "tiller-installer/1" },
      });
    } catch {
      throw new RetryableBundleDownloadError();
    }
    if (!response.ok) {
      if ([404, 408, 409, 425, 429].includes(response.status) || response.status >= 500) {
        throw new RetryableBundleDownloadError();
      }
      throw new Error("Release bundle could not be downloaded");
    }
    if (new URL(response.url).protocol !== "https:") throw new Error("Release bundle redirected outside HTTPS");
    const declared = response.headers.get("Content-Length");
    if (declared !== null && Number(declared) !== descriptor.bundle.size) {
      throw new Error("Release bundle size does not match its descriptor");
    }
    try {
      return await readBoundedResponseBytes(response, MAX_ARCHIVE_BYTES);
    } catch (error) {
      if (error instanceof Error && error.message === "Outbound response exceeded its size limit") throw error;
      throw new RetryableBundleDownloadError();
    }
  }, remainingBundleTimeout(deadline));
  if (archive.byteLength !== descriptor.bundle.size || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Release bundle size does not match its descriptor");
  }
  if (await sha256Hex(archive) !== descriptor.bundle.sha256) {
    throw new Error("Release bundle digest does not match its descriptor");
  }
  const ownedArchive = new Uint8Array(archive.byteLength);
  ownedArchive.set(archive);
  const stream = new Blob([ownedArchive.buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const expanded = await readBoundedStream(stream, MAX_TAR_BYTES, deadline);
  const entries = readReleaseTar(expanded);
  const modules: ReleaseBundle["modules"] = [];
  const assets: ReleaseBundle["assets"] = [];
  for (const [path, content] of entries) {
    if (path.startsWith("worker/")) {
      const name = path.slice("worker/".length);
      if (name) {
        modules.push({ name, content, contentType: moduleContentType(name) });
      }
    } else if (path.startsWith("client/")) {
      const name = path.slice("client/".length);
      if (name && name !== ".assetsignore") {
        if (content.byteLength > MAX_ASSET_BYTES) throw new Error(`Release asset ${name} exceeds the Cloudflare limit`);
        assets.push({ path: name, content, contentType: assetContentType(name) });
      }
    }
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  assets.sort((left, right) => left.path.localeCompare(right.path));
  if (!modules.some((module) => module.name === descriptor.uploadTemplate.mainModule)) {
    throw new Error("Release bundle is missing its main Worker module");
  }
  if (assets.length === 0) throw new Error("Release bundle is missing Hub assets");
  if (Date.now() >= deadline) throw new Error("Release bundle download expired");
  return { modules, assets };
}

function base64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function usesSingleAssetUploads(jwt: string): boolean {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as unknown;
    return typeof decoded === "object"
      && decoded !== null
      && !Array.isArray(decoded)
      && (decoded as Record<string, unknown>).wrangler_single_asset_uploads === true;
  } catch {
    return false;
  }
}

export async function assetHash(path: string, bytes: Uint8Array): Promise<string> {
  const filename = path.split("/").pop() ?? "";
  const lastDot = filename.lastIndexOf(".");
  const extension = lastDot > 0 ? filename.slice(lastDot + 1) : "";
  const input = new TextEncoder().encode(base64(bytes) + extension);
  return bytesToHex(blake3(input)).slice(0, 32);
}

export async function uploadReleaseAssets(args: {
  authorization: CloudflareAuthorization;
  accountId: string;
  workerName: string;
  assets: ReleaseBundle["assets"];
}): Promise<string> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  const byHash = new Map<string, ReleaseBundle["assets"][number]>();
  for (const asset of args.assets) {
    const hash = await assetHash(asset.path, asset.content);
    manifest[`/${asset.path}`] = { hash, size: asset.content.byteLength };
    byHash.set(hash, asset);
  }
  const session = await createAssetUploadSession(
    args.authorization,
    args.accountId,
    args.workerName,
    manifest,
  );
  const uploadJwt = session.jwt?.trim() ?? "";
  const singleAssetUploads = usesSingleAssetUploads(uploadJwt);
  let completionJwt = uploadJwt;
  for (const bucket of session.buckets ?? []) {
    if (!uploadJwt) throw new Error("Cloudflare did not return an asset upload token");
    const files = bucket.map((hash) => {
      const file = byHash.get(hash);
      if (!file) throw new Error("Cloudflare requested an unknown release asset");
      return { hash, content: file.content, contentType: file.contentType };
    });
    if (singleAssetUploads) {
      for (const file of files) {
        const completed = await uploadSingleAsset(
          args.accountId,
          uploadJwt,
          file,
          args.authorization.deadline,
        );
        completionJwt = completed.jwt?.trim() || completionJwt;
      }
    } else {
      const completed = await uploadAssetBatch(
        args.accountId,
        uploadJwt,
        files,
        args.authorization.deadline,
      );
      completionJwt = completed.jwt?.trim() || completionJwt;
    }
  }
  if (!completionJwt) throw new Error("Cloudflare did not complete the asset upload");
  return completionJwt;
}
