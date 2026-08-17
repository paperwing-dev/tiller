import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve4: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

vi.mock("node:dns/promises", () => ({
  resolve4: mocks.resolve4,
}));

import { checkHttpHealth } from "./health-check.js";

function dnsResponse(...ips: string[]): Response {
  return Response.json({
    Status: 0,
    Answer: ips.map((data) => ({ type: 1, data })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("checkHttpHealth", () => {
  it("passes Access headers to curl over stdin instead of argv", async () => {
    mocks.resolve4.mockRejectedValue(new Error("local DNS unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse("203.0.113.10")));
    vi.stubEnv("CF_ACCESS_CLIENT_ID", "environment-client-id");
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "environment-client-secret");
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: "200", stderr: "" });

    await expect(checkHttpHealth("https://hub.example.com/health", {
      "CF-Access-Client-Id": "saved-client-id",
      "CF-Access-Client-Secret": "saved-client-secret",
    })).resolves.toMatchObject({ ok: true });

    const [, args, options] = mocks.spawnSync.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; input: string; stdio: string[] },
    ];
    expect(args).toContain("@-");
    expect(args.join(" ")).not.toContain("saved-client-id");
    expect(args.join(" ")).not.toContain("saved-client-secret");
    expect(options.input).toContain("cf-access-client-id: saved-client-id\n");
    expect(options.input).toContain("cf-access-client-secret: saved-client-secret\n");
    expect(options.env.CF_ACCESS_CLIENT_ID).toBeUndefined();
    expect(options.env.CF_ACCESS_CLIENT_SECRET).toBeUndefined();
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("fails when every public-DNS address fails authenticated HTTP", async () => {
    mocks.resolve4.mockRejectedValue(new Error("local DNS unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse("203.0.113.10", "203.0.113.11")));
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: "403", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "502", stderr: "" });

    await expect(checkHttpHealth("https://hub.example.com/health"))
      .resolves.toEqual({ ok: false, detail: "https://hub.example.com/health -> 502" });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("accepts a later public-DNS address only after it returns 2xx", async () => {
    mocks.resolve4.mockRejectedValue(new Error("local DNS unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse("203.0.113.10", "203.0.113.11")));
    mocks.spawnSync
      .mockReturnValueOnce({ status: 0, stdout: "503", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "204", stderr: "" });

    await expect(checkHttpHealth("https://hub.example.com/health"))
      .resolves.toEqual({ ok: true, detail: "https://hub.example.com/health" });
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
  });

  it("keeps the DNS-specific failure when public DNS has no A answers", async () => {
    mocks.resolve4.mockRejectedValue(new Error("local DNS unavailable"));
    vi.stubGlobal("fetch", vi.fn(async () => dnsResponse()));

    await expect(checkHttpHealth("https://hub.example.com/health"))
      .resolves.toEqual({ ok: false, detail: "DNS not yet available for hub.example.com" });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("does not follow redirects in the normal fetch path", async () => {
    mocks.resolve4.mockResolvedValue(["203.0.113.10"]);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://login.example.invalid" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(checkHttpHealth("https://hub.example.com/health"))
      .resolves.toEqual({ ok: false, detail: "https://hub.example.com/health -> 302" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example.com/health",
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
