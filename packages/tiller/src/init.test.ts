import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runBrowserBootstrap: vi.fn(),
  loadConfig: vi.fn(),
  reloadConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

vi.mock("./browser-bootstrap.js", () => ({
  runBrowserBootstrap: mocks.runBrowserBootstrap,
}));

vi.mock("./codex-subscription.js", () => ({
  fetchHubSetupStatus: vi.fn(),
  isHubSetupStatusAuthError: vi.fn(() => false),
}));

vi.mock("./config.js", () => ({
  CONFIG_PATH: "/tmp/tiller-init-test.json",
  DEFAULT_LOCAL_RUNNER_IMAGE: "paperwing-test:latest",
  HUB_URL: "https://saved.preview.workers.dev",
  HAS_CF_ACCESS_SERVICE_TOKEN: false,
  CONTROL_SECRET: "",
  isLocalHubUrl: (hubUrl: string) => new URL(hubUrl).hostname === "localhost",
  isWorkersDevHubUrl: (hubUrl: string) =>
    new URL(hubUrl).hostname.endsWith(".workers.dev"),
  loadConfig: mocks.loadConfig,
  reloadConfig: mocks.reloadConfig,
  writeConfig: mocks.writeConfig,
}));

import {
  ensureControlCredential,
  ensureInteractiveConfig,
  runInit,
} from "./init.js";

describe("workers.dev init", () => {
  const originalExitCode = process.exitCode;
  const originalPublicHub = process.env.TILLER_PUBLIC_HUB;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    delete process.env.TILLER_PUBLIC_HUB;
    process.exitCode = undefined;
    mocks.runBrowserBootstrap.mockReset();
    mocks.loadConfig.mockReset().mockReturnValue({});
    mocks.reloadConfig.mockReset();
    mocks.writeConfig.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTTY,
    });
    if (originalPublicHub === undefined) delete process.env.TILLER_PUBLIC_HUB;
    else process.env.TILLER_PUBLIC_HUB = originalPublicHub;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("rejects retired public mode", async () => {
    await runInit([
      "--hub-url",
      "https://demo.preview.workers.dev",
      "--public-hub",
    ]);

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Public/custom-domain connection options were removed",
      ),
    );
    expect(mocks.runBrowserBootstrap).not.toHaveBeenCalled();
    expect(mocks.writeConfig).not.toHaveBeenCalled();
  });

  it("does not treat a saved public workers.dev hub as complete", async () => {
    mocks.loadConfig.mockReturnValue({
      hubUrl: "https://saved.preview.workers.dev",
      publicHub: true,
    });
    mocks.runBrowserBootstrap.mockResolvedValue({
      hubUrl: "https://saved.preview.workers.dev",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });

    await ensureInteractiveConfig();

    expect(mocks.runBrowserBootstrap).toHaveBeenCalledWith(
      "https://saved.preview.workers.dev",
    );
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        hubUrl: "https://saved.preview.workers.dev",
        clientId: "client-id.access",
        clientSecret: "client-secret",
        controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
      }),
    );
  });

  it("uses the encrypted browser handoff even when the existing config was public", async () => {
    mocks.loadConfig.mockReturnValue({
      hubUrl: "https://demo.preview.workers.dev",
      publicHub: true,
    });
    mocks.runBrowserBootstrap.mockResolvedValue({
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });

    await runInit(["--hub-url", "https://demo.preview.workers.dev"]);

    expect(mocks.runBrowserBootstrap).toHaveBeenCalledWith(
      "https://demo.preview.workers.dev",
    );
    expect(mocks.writeConfig).toHaveBeenCalledOnce();
    const saved = mocks.writeConfig.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      hubUrl: "https://demo.preview.workers.dev",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
    });
    expect(saved).not.toHaveProperty("publicHub");
    expect(mocks.reloadConfig).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it("honors a hub URL extracted by the global CLI parser", async () => {
    mocks.runBrowserBootstrap.mockResolvedValue({
      hubUrl: "https://global.preview.workers.dev",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });

    await runInit([], { hubUrlOverride: "https://global.preview.workers.dev" });

    expect(mocks.runBrowserBootstrap).toHaveBeenCalledWith(
      "https://global.preview.workers.dev",
    );
  });

  it("rejects a legacy custom-domain URL with the canonical setup command", async () => {
    await runInit(["--hub-url", "https://tiller.example.com"]);

    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "tiller host setup --hub-url https://<exact-host>.workers.dev",
      ),
    );
    expect(mocks.runBrowserBootstrap).not.toHaveBeenCalled();
  });

  it("gives non-interactive callers one actionable control-credential instruction", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    mocks.loadConfig.mockReturnValue({
      hubUrl: "https://saved.preview.workers.dev",
      clientId: "client-id.access",
      clientSecret: "client-secret",
    });

    await expect(ensureControlCredential()).rejects.toThrow(
      "Run `tiller init --hub-url https://saved.preview.workers.dev` interactively",
    );
    expect(mocks.runBrowserBootstrap).not.toHaveBeenCalled();
  });

  it("uses the same actionable failure for non-interactive init", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: false,
    });
    mocks.loadConfig.mockReturnValue({
      hubUrl: "https://saved.preview.workers.dev",
      clientId: "client-id.access",
      clientSecret: "client-secret",
    });

    await expect(
      runInit(["--hub-url", "https://saved.preview.workers.dev"]),
    ).rejects.toThrow(
      "Run `tiller init --hub-url https://saved.preview.workers.dev` interactively",
    );
    expect(mocks.runBrowserBootstrap).not.toHaveBeenCalled();
  });
});
