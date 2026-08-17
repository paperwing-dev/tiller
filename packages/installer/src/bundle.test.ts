import { afterEach, describe, expect, it, vi } from "vitest";
import { productionReleaseDescriptorFixture } from "./release-fixture";
import {
  assetHash,
  fetchReleaseBundle,
  readReleaseTar,
  RetryableBundleDownloadError,
  uploadReleaseAssets,
} from "./bundle";
import type { ReleaseDescriptorV1 } from "./types";

const stableDescriptor = productionReleaseDescriptorFixture();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function octal(value: number, width: number): Uint8Array {
  return new TextEncoder().encode(value.toString(8).padStart(width - 1, "0") + "\0");
}

function paxRecord(key: string, value: string): string {
  const payload = `${key}=${value}\n`;
  let length = new TextEncoder().encode(`0 ${payload}`).byteLength;
  while (true) {
    const record = `${length} ${payload}`;
    const nextLength = new TextEncoder().encode(record).byteLength;
    if (nextLength === length) return record;
    length = nextLength;
  }
}

function tar(entries: Array<{ name: string; body: string; type?: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const body = new TextEncoder().encode(entry.body);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(entry.name), 0);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(body.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header.set(new TextEncoder().encode(entry.type ?? "0"), 156);
    header.set(new TextEncoder().encode("ustar\0"), 257);
    header.set(new TextEncoder().encode("00"), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
    chunks.push(header, body, new Uint8Array(Math.ceil(body.byteLength / 512) * 512 - body.byteLength));
  }
  chunks.push(new Uint8Array(1_024));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe("release tar validation", () => {
  it("classifies only bundle transport and availability failures as retryable", async () => {
    const release = structuredClone(stableDescriptor) as ReleaseDescriptorV1;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));
    await expect(fetchReleaseBundle(release, Date.now() + 60_000))
      .rejects.toBeInstanceOf(RetryableBundleDownloadError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(fetchReleaseBundle(release, Date.now() + 60_000))
      .rejects.toBeInstanceOf(RetryableBundleDownloadError);

    const invalid = { ...release, bundle: { ...release.bundle, size: 3, sha256: "0".repeat(64) } };
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Length": "3" },
      });
      Object.defineProperty(response, "url", { value: invalid.bundle.url });
      return response;
    }));
    const error = await fetchReleaseBundle(invalid, Date.now() + 60_000).catch((value) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RetryableBundleDownloadError);
  });

  it("aborts a release download at the absolute job deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-30T00:00:00.000Z");
    const deadline = Date.now() + 1_000;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        started();
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    )));
    const descriptor = structuredClone(stableDescriptor) as ReleaseDescriptorV1;
    const download = fetchReleaseBundle(descriptor, deadline);
    const rejected = expect(download).rejects.toThrow();
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(Date.now()).toBe(deadline);
  });

  it("uses Cloudflare's BLAKE3 asset-manifest hash format", async () => {
    await expect(assetHash("hello.txt", new TextEncoder().encode("hello")))
      .resolves.toBe("f0b3413d4cabb000327fad369003d6a5");
    await expect(assetHash("LICENSE", new TextEncoder().encode("hello")))
      .resolves.toBe("324ea05bea4d7f75b8d9ed695e65b2ca");
  });

  it("uses the original upload JWT for every asset batch", async () => {
    const assets = [
      { path: "one.txt", content: new TextEncoder().encode("one"), contentType: "text/plain" },
      { path: "two.txt", content: new TextEncoder().encode("two"), contentType: "text/plain" },
    ];
    const hashes = await Promise.all(assets.map((asset) => assetHash(asset.path, asset.content)));
    let upload = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [[hashes[0]], [hashes[1]]] } });
      }
      if (path.endsWith("/workers/assets/upload")) {
        upload += 1;
        return Response.json({ success: true, result: { jwt: `completion-${upload}` } });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadReleaseAssets({
      authorization: { accessToken: "oauth", deadline: Date.now() + 60_000 },
      accountId: "account-1",
      workerName: "tiller",
      assets,
    })).resolves.toBe("completion-2");

    const uploadCalls = fetchMock.mock.calls.filter(([input]) => (
      new URL(String(input)).pathname.endsWith("/workers/assets/upload")
    ));
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls.map(([, init]) => new Headers((init as RequestInit).headers).get("Authorization")))
      .toEqual(["Bearer upload-jwt", "Bearer upload-jwt"]);
  });

  it("uses Cloudflare's raw per-hash endpoint when the upload JWT selects single-asset mode", async () => {
    const assets = [
      { path: "one.txt", content: new TextEncoder().encode("one"), contentType: "text/plain" },
      { path: "two.json", content: new TextEncoder().encode("{\"two\":true}"), contentType: "application/json" },
    ];
    const hashes = await Promise.all(assets.map((asset) => assetHash(asset.path, asset.content)));
    const payload = btoa(JSON.stringify({ wrangler_single_asset_uploads: true }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const uploadJwt = `header.${payload}.signature`;
    let upload = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: uploadJwt, buckets: [[hashes[0], hashes[1]]] } });
      }
      const hash = path.split("/").pop();
      if (hashes.includes(hash ?? "")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${uploadJwt}`);
        const expected = assets[hashes.indexOf(hash!)];
        expect(new Headers(init?.headers).get("Content-Type")).toBe(expected.contentType);
        expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(expected.content);
        upload += 1;
        return Response.json({ success: true, result: { jwt: `completion-${upload}` } });
      }
      throw new Error(`unexpected ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadReleaseAssets({
      authorization: { accessToken: "oauth", deadline: Date.now() + 60_000 },
      accountId: "account-1",
      workerName: "tiller",
      assets,
    })).resolves.toBe("completion-2");

    const uploads = fetchMock.mock.calls.filter(([input]) => (
      hashes.includes(new URL(String(input)).pathname.split("/").pop() ?? "")
    ));
    expect(uploads).toHaveLength(2);
    expect(fetchMock.mock.calls.some(([input]) => new URL(String(input)).searchParams.has("base64"))).toBe(false);
  });

  it("does not start a later asset mutation after the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-30T00:00:00.000Z");
    const assets = [
      { path: "one.txt", content: new TextEncoder().encode("one"), contentType: "text/plain" },
      { path: "two.txt", content: new TextEncoder().encode("two"), contentType: "text/plain" },
    ];
    const hashes = await Promise.all(assets.map((asset) => assetHash(asset.path, asset.content)));
    const deadline = Date.now() + 1_000;
    let uploads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const requestPath = new URL(String(input)).pathname;
      if (requestPath.endsWith("/assets-upload-session")) {
        return Response.json({
          success: true,
          result: { jwt: "upload-jwt", buckets: [[hashes[0]], [hashes[1]]] },
        });
      }
      if (requestPath.endsWith("/workers/assets/upload")) {
        uploads += 1;
        vi.setSystemTime(deadline + 1);
        return Response.json({ success: true, result: { jwt: "completion-1" } });
      }
      throw new Error(`unexpected ${requestPath}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadReleaseAssets({
      authorization: { accessToken: "oauth", deadline },
      accountId: "account-1",
      workerName: "tiller",
      assets,
    })).rejects.toThrow(/Cloudflare API request failed/);
    expect(uploads).toBe(1);
  });

  it("reads Worker chunks and client assets as regular entries", () => {
    const entries = readReleaseTar(tar([
      { name: "worker/index.js", body: "export default {}" },
      { name: "worker/assets/chunk.js", body: "export const chunk = true" },
      { name: "client/index.html", body: "<main>Tiller</main>" },
    ]));
    expect([...entries.keys()]).toEqual([
      "worker/index.js",
      "worker/assets/chunk.js",
      "client/index.html",
    ]);
  });

  it("ignores portable archive metadata without admitting links", () => {
    const entries = readReleaseTar(tar([
      { name: "PaxHeader/worker", body: paxRecord("mtime", "1785713061.448208268"), type: "x" },
      { name: "worker/", body: "", type: "5" },
      { name: "worker/._index.js", body: "apple-double" },
      { name: "client/.DS_Store", body: "finder" },
      { name: "__MACOSX/client/index.html", body: "metadata" },
      { name: "worker/index.js", body: "export default {}" },
    ]));

    expect([...entries.keys()]).toEqual(["worker/index.js"]);
  });

  it("rejects malformed or semantic PAX overrides", () => {
    expect(() => readReleaseTar(tar([
      { name: "PaxHeader/worker", body: "22 SCHILY.xattr.test=x\n", type: "x" },
    ]))).toThrow(/invalid PAX metadata/);
    expect(() => readReleaseTar(tar([
      { name: "PaxHeader/worker", body: paxRecord("path", "../worker/index.js"), type: "x" },
    ]))).toThrow(/unsupported PAX metadata/);
    expect(() => readReleaseTar(tar([
      { name: "PaxHeader/worker", body: paxRecord("size", "0"), type: "x" },
    ]))).toThrow(/unsupported PAX metadata/);
  });

  it("rejects traversal, links, duplicate names, and bad checksums", () => {
    expect(() => readReleaseTar(tar([{ name: "../secret", body: "x" }]))).toThrow(/unsafe path/);
    expect(() => readReleaseTar(tar([{ name: "worker/link", body: "", type: "2" }]))).toThrow(/unsupported entry type/);
    expect(() => readReleaseTar(tar([
      { name: "worker/index.js", body: "one" },
      { name: "worker/index.js", body: "two" },
    ]))).toThrow(/duplicate path/);
    const damaged = tar([{ name: "worker/index.js", body: "one" }]);
    damaged[0] ^= 1;
    expect(() => readReleaseTar(damaged)).toThrow(/checksum/);
  });
});
