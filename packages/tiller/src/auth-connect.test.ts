import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import {
  buildSubscriptionLoginEnvironment,
  collectSubscriptionCredentials,
  parseAuthConnectProviders,
  readHiddenInput,
  runAuthConnectCommand,
} from "./auth-connect";

function fakeCodexAuth(): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "access-secret",
      refresh_token: "refresh-secret",
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tiller auth connect", () => {
  it("restores terminal state and signal handlers when hidden input is terminated", async () => {
    const input = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
      isPaused: () => boolean;
      resume: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = vi.fn((mode: boolean) => { input.isRaw = mode; });
    input.isPaused = () => true;
    input.resume = vi.fn();
    input.pause = vi.fn();
    const signals = new EventEmitter();
    const stderr: string[] = [];

    const pending = readHiddenInput("secret: ", {
      input,
      signalSource: signals as Pick<NodeJS.Process, "once" | "off">,
      writeStderr: (message) => stderr.push(message),
    });
    signals.emit("SIGTERM");

    await expect(pending).rejects.toThrow("cancelled");
    expect(input.setRawMode.mock.calls.map(([mode]) => mode)).toEqual([true, false]);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGHUP")).toBe(0);
    expect(stderr).toEqual(["secret: ", "\n"]);
  });

  it("connects both providers by default and supports provider filtering", () => {
    expect(parseAuthConnectProviders([])).toEqual(["codex", "claude"]);
    expect(parseAuthConnectProviders(["codex"])).toEqual(["codex"]);
    expect(parseAuthConnectProviders(["claude"])).toEqual(["claude"]);
    expect(() => parseAuthConnectProviders(["unknown"])).toThrow("Usage: tiller auth connect");
    expect(() => parseAuthConnectProviders(["codex", "claude"])).toThrow("Usage: tiller auth connect");
  });

  it("uses a private isolated Codex cache and removes it after collection", async () => {
    let codexHome = "";
    const runCommand = vi.fn(async (command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(command).toBe("codex");
      expect(args).toEqual(["login"]);
      codexHome = options.env?.CODEX_HOME ?? "";
      expect(codexHome).toContain("tiller-codex-login-");
      expect(codexHome).not.toBe(process.env.CODEX_HOME);
      await expect(readFile(`${codexHome}/config.toml`, "utf8")).resolves.toBe(
        'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
      );
      await writeFile(`${codexHome}/auth.json`, fakeCodexAuth(), { mode: 0o600 });
    });

    await expect(collectSubscriptionCredentials(["codex"], { runCommand })).resolves.toEqual({
      codexAuthJson: fakeCodexAuth(),
    });
    await expect(stat(codexHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs Claude setup-token and performs exactly one hidden paste", async () => {
    const runCommand = vi.fn(async () => undefined);
    const promptHidden = vi.fn(async () => "  claude-secret-token  ");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(collectSubscriptionCredentials(["claude"], { runCommand, promptHidden })).resolves.toEqual({
      claudeOauthToken: "claude-secret-token",
    });
    expect(runCommand).toHaveBeenCalledWith("claude", ["setup-token"], expect.objectContaining({ stdio: "inherit" }));
    expect(promptHidden).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("claude-secret-token");
  });

  it("scrubs provider and Tiller secrets from login subprocess environments", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-secret");
    vi.stubEnv("CF_ACCESS_CLIENT_SECRET", "access-secret");
    vi.stubEnv("TILLER_RUNTIME_CAPABILITY", "runtime-secret");
    vi.stubEnv("PATH", "/bin");
    const env = buildSubscriptionLoginEnvironment("codex", "/private/tmp/isolated-codex-home");
    expect(env).toMatchObject({ PATH: "/bin", CODEX_HOME: "/private/tmp/isolated-codex-home" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(env).not.toHaveProperty("CF_ACCESS_CLIENT_SECRET");
    expect(env).not.toHaveProperty("TILLER_RUNTIME_CAPABILITY");
    vi.unstubAllEnvs();
  });

  it("reports a missing provider CLI without retaining the temporary cache", async () => {
    const priorPath = process.env.PATH;
    process.env.PATH = "/definitely/not/a/real/path";
    try {
      await expect(collectSubscriptionCredentials(["codex"])).rejects.toThrow(
        "codex is not installed or is not available on PATH",
      );
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it("propagates cancellation before requesting owner approval", async () => {
    const promptHidden = vi.fn();
    await expect(collectSubscriptionCredentials(["codex", "claude"], {
      runCommand: vi.fn(async (command) => {
        throw new Error(`${command} authentication was cancelled.`);
      }),
      promptHidden,
    })).rejects.toThrow("codex authentication was cancelled");
    expect(promptHidden).not.toHaveBeenCalled();
  });

  it("connects both providers with one approval and provider-scoped uploads", async () => {
    const events: string[] = [];
    const runCommand = vi.fn(async (command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      events.push(command);
      if (command === "codex") {
        await writeFile(`${options.env?.CODEX_HOME}/auth.json`, fakeCodexAuth(), { mode: 0o600 });
      }
    });
    const promptHidden = vi.fn(async () => {
      events.push("hidden-paste");
      return "claude-upload-secret";
    });
    const approve = vi.fn(async () => {
      events.push("owner-approval");
      return {
        version: 1 as const,
        hubUrl: "https://demo.preview.workers.dev",
        grants: { codex: "codex-grant", claude: "claude-grant" },
      };
    });
    const uploads: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      uploads.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAuthConnectCommand([], {
      dependencies: {
        initialize: vi.fn(async () => undefined),
        validateAuth: vi.fn(),
        hubUrl: "https://demo.preview.workers.dev",
        accessHeaders: { "CF-Access-Client-Id": "service-client" },
        runCommand,
        promptHidden,
        approve,
        fetch: fetchImpl,
      },
    });

    expect(events).toEqual(["codex", "claude", "hidden-paste", "owner-approval"]);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(uploads.map((upload) => upload.url)).toEqual([
      "https://demo.preview.workers.dev/api/auth/subscriptions/codex/connect",
      "https://demo.preview.workers.dev/api/auth/subscriptions/claude/connect",
    ]);
    expect(uploads[0].headers.get("X-Tiller-Auth-Grant")).toBe("codex-grant");
    expect(uploads[1].headers.get("X-Tiller-Auth-Grant")).toBe("claude-grant");
    expect(uploads[0].headers.get("CF-Access-Client-Id")).toBe("service-client");
    expect(uploads[0].body).toEqual({ version: 1, auth_json: fakeCodexAuth() });
    expect(uploads[1].body).toEqual({ version: 1, oauth_token: "claude-upload-secret" });
    expect(stderr.mock.calls.flat().join(" ")).not.toMatch(/access-secret|refresh-secret|claude-upload-secret/);
  });
});
