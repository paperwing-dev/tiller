import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  runBrowserBootstrap,
  type BrowserBootstrapResult,
} from "./browser-bootstrap.js";
import {
  fetchHubSetupStatus,
  isHubSetupStatusAuthError,
} from "./codex-subscription.js";
import {
  CONFIG_PATH,
  type TillerConfig,
  DEFAULT_LOCAL_RUNNER_IMAGE,
  HUB_URL,
  isLocalHubUrl,
  isWorkersDevHubUrl,
  loadConfig,
  reloadConfig,
  writeConfig,
} from "./config.js";

interface ParsedArgs {
  [key: string]: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function normalizeUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function printUsage(): void {
  console.error(
    "Usage: tiller init --hub-url https://<exact-host>.workers.dev [options]",
  );
  console.error("");
  console.error(
    "Run `tiller init` with no flags to update the saved hub URL interactively.",
  );
  console.error("");
  console.error(
    "Cloudflare Access credentials are delivered only through the encrypted owner browser handoff.",
  );
  console.error("");
  console.error("Options:");
  console.error(
    `  --host-pull-image <value>           Override sandbox image (defaults to ${DEFAULT_LOCAL_RUNNER_IMAGE})`,
  );
}

function unsupportedHubUrlMessage(): string {
  return (
    "Tiller requires the exact workers.dev Hub URL. Run " +
    "`tiller host setup --hub-url https://<exact-host>.workers.dev`."
  );
}

function isSupportedHubUrl(hubUrl: string): boolean {
  return isWorkersDevHubUrl(hubUrl) || isLocalHubUrl(hubUrl);
}

function buildSavedConfigFromBootstrap(
  bootstrap: BrowserBootstrapResult,
  localRunnerImage?: string,
): TillerConfig {
  if (!isSupportedHubUrl(bootstrap.hubUrl)) {
    throw new Error(unsupportedHubUrlMessage());
  }
  return buildSavedConfig(loadConfig(), {
    hubUrl: bootstrap.hubUrl,
    clientId:
      bootstrap.protectionMode === "cf-access" ? bootstrap.clientId : undefined,
    clientSecret:
      bootstrap.protectionMode === "cf-access"
        ? bootstrap.clientSecret
        : undefined,
    controlSecret:
      bootstrap.protectionMode === "cf-access"
        ? bootstrap.controlSecret
        : undefined,
    localRunnerImage,
  });
}

async function connectAndPersistCredentials(
  hubUrl: string,
  localRunnerImage?: string,
): Promise<BrowserBootstrapResult> {
  const bootstrap = await runBrowserBootstrap(hubUrl);
  writeConfig(buildSavedConfigFromBootstrap(bootstrap, localRunnerImage));
  reloadConfig();
  return bootstrap;
}

async function refreshProtectedHubAccessCredentials(
  hubUrl: string,
  quiet = false,
): Promise<void> {
  if (!quiet) {
    process.stderr.write(
      "[tiller] Saved hub access credentials no longer work. Reconnecting through the browser...\n",
    );
  }

  await ensureControlCredential({ hubUrlOverride: hubUrl, force: true, quiet });

  if (!quiet) {
    process.stderr.write(`[tiller] Refreshed ${CONFIG_PATH}\n`);
    process.stderr.write(
      "[tiller] Refreshed browser-authenticated Cloudflare Access credentials.\n",
    );
  }
}

async function verifySavedHubAccess(
  hubUrl: string,
  quiet = false,
): Promise<void> {
  if (!hubUrl) return;
  try {
    await fetchHubSetupStatus(hubUrl);
    return;
  } catch (error) {
    if (isHubSetupStatusAuthError(error) && input.isTTY && output.isTTY) {
      try {
        await refreshProtectedHubAccessCredentials(hubUrl, quiet);
        await fetchHubSetupStatus(hubUrl);
        return;
      } catch (refreshError) {
        error = refreshError;
      }
    }
    if (!quiet) {
      process.stderr.write(
        `[tiller] Could not verify saved hub access: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

function buildConfig(options: {
  hubUrl: string;
  clientId?: string;
  clientSecret?: string;
  controlSecret?: string;
  localRunnerImage?: string;
}): TillerConfig {
  const config: TillerConfig = {
    hubUrl: normalizeUrl(options.hubUrl),
    localRunnerImage: options.localRunnerImage || DEFAULT_LOCAL_RUNNER_IMAGE,
  };

  if (options.clientId) {
    config.clientId = options.clientId;
  }
  if (options.clientSecret) {
    config.clientSecret = options.clientSecret;
  }
  if (options.controlSecret) config.controlSecret = options.controlSecret;

  return config;
}

type SavedConfigRecord = TillerConfig & Record<string, unknown>;

export function buildSavedConfig(
  existing: TillerConfig,
  options: {
    hubUrl: string;
    clientId?: string;
    clientSecret?: string;
    controlSecret?: string;
    localRunnerImage?: string;
  },
): TillerConfig {
  const base = buildConfig({
    hubUrl: options.hubUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    controlSecret: options.controlSecret,
    localRunnerImage: options.localRunnerImage ?? existing.localRunnerImage,
  });

  const next: SavedConfigRecord = {
    ...(existing as SavedConfigRecord),
    ...base,
  };

  delete next.publicHub;
  if (options.clientId) next.clientId = options.clientId;
  else delete next.clientId;
  if (options.clientSecret) next.clientSecret = options.clientSecret;
  else delete next.clientSecret;
  if (options.controlSecret) next.controlSecret = options.controlSecret;
  else delete next.controlSecret;

  return next;
}

interface EnsureInteractiveConfigOptions {
  forceHubPrompt?: boolean;
  hubUrlOverride?: string;
  localRunnerImageOverride?: string;
}

export async function ensureInteractiveConfig(
  options: EnsureInteractiveConfigOptions = {},
): Promise<void> {
  const overrideHubUrl = normalizeUrl(options.hubUrlOverride || "");

  if (!options.forceHubPrompt && !overrideHubUrl && HUB_URL) {
    await ensureControlCredential();
    await verifySavedHubAccess(HUB_URL, true);
    return;
  }

  const existing = loadConfig();
  let normalizedHubUrl = overrideHubUrl || HUB_URL;
  let rl: ReturnType<typeof createInterface> | null = null;

  try {
    if (!normalizedHubUrl || options.forceHubPrompt) {
      if (!input.isTTY || !output.isTTY) {
        console.error(
          `[tiller] ${CONFIG_PATH} is missing or incomplete. Run \`tiller\` interactively or use \`tiller init --help\`.`,
        );
        process.exit(1);
      }

      const currentHubUrl = normalizeUrl(existing.hubUrl || normalizedHubUrl);
      process.stderr.write(
        options.forceHubPrompt
          ? "[tiller] Update the hub URL used by tiller.\n"
          : `[tiller] No config found at ${CONFIG_PATH}. Let's connect tiller to your hub.\n`,
      );
      rl = createInterface({ input, output });
      const prompt = rl;
      const ask = async (question: string): Promise<string> => {
        const answer = await prompt.question(question);
        return (answer ?? "").trim();
      };

      const hubUrl = await ask(
        currentHubUrl ? `Hub URL [${currentHubUrl}]: ` : "Hub URL: ",
      );
      const selectedHubUrl = normalizeUrl(hubUrl || currentHubUrl);
      if (!selectedHubUrl) {
        console.error("[tiller] Hub URL is required.");
        process.exit(1);
      }
      normalizedHubUrl = selectedHubUrl;
    } else {
      process.stderr.write(
        `[tiller] Connecting tiller to ${normalizedHubUrl}\n`,
      );
    }

    if (!normalizedHubUrl) {
      console.error("[tiller] Hub URL is required.");
      process.exit(1);
    }
    if (!isSupportedHubUrl(normalizedHubUrl)) {
      throw new Error(unsupportedHubUrlMessage());
    }

    if (isWorkersDevHubUrl(normalizedHubUrl)) {
      await ensureControlCredential({
        hubUrlOverride: normalizedHubUrl,
        localRunnerImageOverride: options.localRunnerImageOverride,
      });
      await verifySavedHubAccess(normalizedHubUrl, true);
      return;
    }

    const bootstrap = await connectAndPersistCredentials(
      normalizedHubUrl,
      options.localRunnerImageOverride,
    );
    process.stderr.write(`[tiller] Wrote ${CONFIG_PATH}\n`);
    process.stderr.write(
      bootstrap.protectionMode === "cf-access"
        ? "[tiller] Saved browser-authenticated Cloudflare Access credentials.\n"
        : "[tiller] Saved localhost development configuration.\n",
    );
  } finally {
    rl?.close();
  }
}

export async function ensureControlCredential(
  options: {
    hubUrlOverride?: string;
    localRunnerImageOverride?: string;
    force?: boolean;
    quiet?: boolean;
  } = {},
): Promise<void> {
  const existing = loadConfig();
  const hubUrl = normalizeUrl(
    options.hubUrlOverride || HUB_URL || existing.hubUrl,
  );
  if (isLocalHubUrl(hubUrl)) return;
  const savedHubUrl = normalizeUrl(existing.hubUrl);
  if (
    !options.force &&
    isWorkersDevHubUrl(hubUrl) &&
    savedHubUrl === hubUrl &&
    existing.clientId?.trim() &&
    existing.clientSecret?.trim() &&
    existing.controlSecret?.trim()
  ) {
    if (
      options.localRunnerImageOverride &&
      options.localRunnerImageOverride !== existing.localRunnerImage
    ) {
      writeConfig({
        ...existing,
        localRunnerImage: options.localRunnerImageOverride,
      });
      reloadConfig();
    }
    return;
  }
  const instruction = `Run \`tiller init --hub-url ${hubUrl || "https://<exact-host>.workers.dev"}\` interactively to approve this installation.`;
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`The Tiller control credential is missing. ${instruction}`);
  }
  if (!isWorkersDevHubUrl(hubUrl)) throw new Error(unsupportedHubUrlMessage());
  if (!options.quiet) {
    process.stderr.write(
      "[tiller] This CLI needs one browser-owner approval for installation control.\n",
    );
  }
  await connectAndPersistCredentials(
    hubUrl,
    options.localRunnerImageOverride ?? existing.localRunnerImage,
  );
  if (!options.quiet) {
    process.stderr.write(
      `[tiller] Saved the control credential in ${CONFIG_PATH}.\n`,
    );
  }
}

export async function runInit(
  argv: string[],
  options: { hubUrlOverride?: string } = {},
): Promise<void> {
  const args = parseArgs(argv);
  if (args.help === "true" || args.h === "true") {
    printUsage();
    return;
  }

  if (
    argv.length === 0 &&
    !options.hubUrlOverride &&
    input.isTTY &&
    output.isTTY
  ) {
    await ensureInteractiveConfig({ forceHubPrompt: true });
    return;
  }

  const existing = loadConfig();
  const hubUrl =
    options.hubUrlOverride ||
    args["hub-url"] ||
    process.env.HUB_URL ||
    existing.hubUrl;
  const retiredOptions = ["public-hub", "client-id", "client-secret"].filter(
    (key) => args[key] !== undefined,
  );
  if (retiredOptions.length > 0 || process.env.TILLER_PUBLIC_HUB) {
    console.error(
      "[tiller] Public/custom-domain connection options were removed. " +
        "Use the exact workers.dev URL and complete the encrypted browser connection.",
    );
    process.exitCode = 1;
    return;
  }

  if (!hubUrl) {
    console.error("[tiller] init requires hubUrl.");
    printUsage();
    process.exitCode = 1;
    return;
  }

  const normalizedHubUrl = normalizeUrl(hubUrl);
  if (!isSupportedHubUrl(normalizedHubUrl)) {
    console.error(`[tiller] ${unsupportedHubUrlMessage()}`);
    process.exitCode = 1;
    return;
  }

  await ensureInteractiveConfig({
    hubUrlOverride: normalizedHubUrl,
    localRunnerImageOverride:
      args["host-pull-image"] ||
      process.env.TILLER_LOCAL_RUNNER_IMAGE ||
      existing.localRunnerImage ||
      DEFAULT_LOCAL_RUNNER_IMAGE,
  });
  process.stderr.write("[tiller] Next steps:\n");
  process.stderr.write("1. Run `tiller`\n");
  process.stderr.write(
    "2. Run `tiller host setup` when you want to use Your machine\n",
  );
  process.stderr.write("3. Run `tiller doctor` if you need troubleshooting\n");
}
