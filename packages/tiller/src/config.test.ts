import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTillerConfig } from "./config.js";

const originalHome = process.env.HOME;
const originalConfigPath = process.env.TILLER_CONFIG_PATH;
const originalMachineId = process.env.MACHINE_ID;
const tempHomes: string[] = [];

function createTempHome(): string {
  const home = mkdtempSync(resolve(tmpdir(), "tiller-config-permissions-"));
  tempHomes.push(home);
  return home;
}

async function loadConfigForHome(home: string) {
  process.env.HOME = home;
  delete process.env.TILLER_CONFIG_PATH;
  vi.resetModules();
  return import("./config.js");
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigPath === undefined) delete process.env.TILLER_CONFIG_PATH;
  else process.env.TILLER_CONFIG_PATH = originalConfigPath;
  if (originalMachineId === undefined) delete process.env.MACHINE_ID;
  else process.env.MACHINE_ID = originalMachineId;
  vi.resetModules();
  while (tempHomes.length > 0) {
    rmSync(tempHomes.pop()!, { recursive: true, force: true });
  }
});

describe("normalizeTillerConfig", () => {
  it("keeps supported settings and discards retired gateway fields", () => {
    expect(normalizeTillerConfig({
      hubUrl: "https://hub.example.com",
      publicHub: true,
      localRunnerPort: 8789,
      gatewayHostname: "gateway.example.com",
      gatewayPort: 9876,
      tunnelToken: "retired-secret",
      codexGatewayAuthMode: "subscription",
      namespace: "my-laptop",
      controlSecret: "control-secret",
      futureUnrelatedSetting: { enabled: true },
    })).toEqual({
      hubUrl: "https://hub.example.com",
      controlSecret: "control-secret",
      localRunnerPort: 8789,
      futureUnrelatedSetting: { enabled: true },
    });
  });

  it("prefers a saved workers.dev origin and removes retired setup state without network access", () => {
    expect(normalizeTillerConfig({
      hubUrl: "https://legacy.example.com",
      workersDevHubUrl: "https://demo.preview.workers.dev",
      selfHostSetupAttemptId: "attempt",
      selfHostEnableToken: "secret",
      machineId: "b5fe8efb-5eba-4e9e-8270-1b3a148c53e4",
      displayName: "build-mac",
      clientId: "client",
      clientSecret: "credential",
    })).toEqual({
      hubUrl: "https://demo.preview.workers.dev",
      machineId: "b5fe8efb-5eba-4e9e-8270-1b3a148c53e4",
      displayName: "build-mac",
      clientId: "client",
      clientSecret: "credential",
    });
  });

  it("drops malformed known values instead of trusting an untyped JSON cast", () => {
    expect(normalizeTillerConfig({
      hubUrl: 42,
      publicHub: "true",
      localRunnerPort: 8789.5,
      machineId: "legacy-hostname-derived-id",
      skipCodexSubscriptionPrompt: true,
    })).toEqual({});
  });
});

describe("writeConfig permissions", () => {
  it("uses only the persisted generated UUID for execution-machine identity", async () => {
    const home = createTempHome();
    const configDir = resolve(home, ".config/tiller");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, "config.json"), JSON.stringify({
      hubUrl: "https://demo.preview.workers.dev",
      machineId: "b5fe8efb-5eba-4e9e-8270-1b3a148c53e4",
      clientId: "client",
      clientSecret: "secret",
      controlSecret: "0123456789abcdef0123456789abcdef0123456789A", // gitleaks:allow -- inert fixture secret
    }));
    process.env.MACHINE_ID = "arbitrary-hostname";

    const config = await loadConfigForHome(home);

    expect(config.MACHINE_ID).toBe("b5fe8efb-5eba-4e9e-8270-1b3a148c53e4");
    expect(() => config.ensureHostAuth()).not.toThrow();
  });

  it("creates the config directory as 0700 and config file as 0600", async () => {
    const home = createTempHome();
    const config = await loadConfigForHome(home);

    config.writeConfig({
      hubUrl: "https://hub.example.com",
      clientId: "client-id",
      clientSecret: "client-secret",
    });

    expect(statSync(config.TILLER_CONFIG_DIR).mode & 0o777).toBe(0o700);
    expect(statSync(config.CONFIG_PATH).mode & 0o777).toBe(0o600);
  });

  it("keeps transport and control request headers explicitly separate", async () => {
    const home = createTempHome();
    const configDir = resolve(home, ".config/tiller");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, "config.json"), JSON.stringify({
      hubUrl: "https://demo.preview.workers.dev",
      clientId: "service-client.access",
      clientSecret: "service-secret",
      controlSecret: "control-secret",
    }));

    const config = await loadConfigForHome(home);

    expect(config.cfTransportHeaders).toEqual({
      "CF-Access-Client-Id": "service-client.access",
      "CF-Access-Client-Secret": "service-secret",
    });
    expect(config.hubControlHeaders).toEqual({
      "CF-Access-Client-Id": "service-client.access",
      "CF-Access-Client-Secret": "service-secret",
      "X-Tiller-Capability": "control-secret",
    });
  });

  it("tightens permissions on an existing config directory and file before updating them", async () => {
    const home = createTempHome();
    const configDir = resolve(home, ".config/tiller");
    const configPath = resolve(configDir, "config.json");
    mkdirSync(configDir, { recursive: true, mode: 0o755 });
    chmodSync(configDir, 0o755);
    writeFileSync(configPath, "{}\n", { mode: 0o644 });
    chmodSync(configPath, 0o644);
    const config = await loadConfigForHome(home);

    config.writeConfig({
      hubUrl: "https://hub.example.com",
      clientId: "client-id",
      clientSecret: "replacement-secret",
    });

    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
