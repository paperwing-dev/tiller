#!/usr/bin/env node
import {
  HUB_URL,
  hubControlHeaders,
  ensureAuth,
  ensureHostAuth,
} from "./config.js";
import { fetchHubSetupStatus } from "./codex-subscription.js";
import { runDnsDoctorCommand } from "./dns-doctor.js";
import { runAttach } from "./attach-client.js";
import { runDoctor } from "./doctor.js";
import {
  runHostCommand,
  runHostDownCommand,
  runHostInstallServiceCommand,
  runHostSetupCommand,
  runHostStatusCommand,
} from "./host-stack.js";
import { parseHostUpdateArgs, runHostUpdateCommand } from "./host-update.js";
import {
  ensureControlCredential,
  ensureInteractiveConfig,
  runInit,
} from "./init.js";
import { shutdownAutoStartedLocalEnvs } from "./picker.js";
import { playSplash } from "./splash.js";
import { runSetup } from "./setup.js";
import { runAuthConnectCommand } from "./auth-connect.js";

function printHelp(): void {
  console.error(
    "Usage: tiller [auth connect [codex|claude]|host [setup|install-service|update]|setup|status|down|doctor [dns [status|repair|restore]]] [--hub-url https://<exact-host>.workers.dev] [--history]",
  );
  console.error("");
  console.error("Commands:");
  console.error("  host setup  Connect and install this execution machine");
  console.error("  host     Start the execution-machine daemon");
  console.error(
    "  host install-service  Install the persistent execution-machine service",
  );
  console.error(
    "  host update  Pin this machine's runtime image to the current Hub build (`--dry-run`, `--yes`)",
  );
  console.error(
    "  auth connect  Connect Codex and Claude subscriptions (or one named provider)",
  );
  console.error("  setup    Run setup checks");
  console.error("  status   Show execution-machine health");
  console.error("  down     Stop the running execution-machine daemon");
  console.error(
    "  doctor   Diagnose execution-machine setup and service health",
  );
  console.error(
    "  doctor dns  Diagnose hub DNS resolution and, on macOS, repair stale local DNS",
  );
  console.error("");
  console.error("Default:");
  console.error("  tiller   Open the env/session picker and attach");
}

function printHostHelp(): void {
  console.error(
    "Usage: tiller host [setup|install-service|update] [--hub-url https://<exact-host>.workers.dev]",
  );
  console.error("");
  console.error("Commands:");
  console.error("  host     Start the execution-machine daemon");
  console.error("  host setup  Connect and install this execution machine");
  console.error("  host install-service  Install the persistent service");
  console.error(
    "  host update  Pin this machine's runtime image to the current Hub build",
  );
}

const args = process.argv.slice(2);

function extractHubUrlArg(argv: string[]): {
  args: string[];
  hubUrlOverride?: string;
} {
  const cleaned: string[] = [];
  let hubUrlOverride: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hub-url") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--hub-url requires a value");
      }
      hubUrlOverride = value.trim();
      i += 1;
      continue;
    }

    if (arg.startsWith("--hub-url=")) {
      const value = arg.slice("--hub-url=".length).trim();
      if (!value) {
        throw new Error("--hub-url requires a value");
      }
      hubUrlOverride = value;
      continue;
    }

    cleaned.push(arg);
  }

  return { args: cleaned, ...(hubUrlOverride ? { hubUrlOverride } : {}) };
}

function extractHostServiceScopeArg(argv: string[]): {
  args: string[];
  hostServiceScope?: "system" | "user";
} {
  const cleaned: string[] = [];
  let hostServiceScope: "system" | "user" | undefined;

  for (const arg of argv) {
    if (arg === "--system") {
      hostServiceScope = "system";
      continue;
    }
    if (arg === "--user") {
      hostServiceScope = "user";
      continue;
    }
    cleaned.push(arg);
  }

  return {
    args: cleaned,
    ...(hostServiceScope ? { hostServiceScope } : {}),
  };
}

const parsedWithHubUrl = extractHubUrlArg(args);
const parsed = extractHostServiceScopeArg(parsedWithHubUrl.args);
const command = parsed.args[0];

const main = async (): Promise<void> => {
  switch (command) {
    case "auth":
      if (parsed.args[1] !== "connect") {
        throw new Error(
          "Unknown auth command. Supported auth command: connect.",
        );
      }
      await runAuthConnectCommand(parsed.args.slice(2), {
        hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
      });
      return;
    case "init":
      await runInit(parsed.args.slice(1), {
        hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
      });
      return;
    case "doctor":
      if (parsed.args[1] === "dns") {
        await runDnsDoctorCommand(parsed.args.slice(2), {
          hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
        });
        return;
      }
      await runDoctor();
      return;
    case "host":
      if (
        parsed.args[1] === "--help" ||
        parsed.args[1] === "-h" ||
        parsed.args[1] === "help"
      ) {
        printHostHelp();
        return;
      }
      if (parsed.args[1] === "setup") {
        await runHostSetupCommand({
          hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
        });
        return;
      }
      if (parsed.args[1] === "install-service") {
        await runHostInstallServiceCommand({
          scope: parsed.hostServiceScope,
        });
        return;
      }
      if (parsed.args[1] === "update") {
        await ensureControlCredential({
          hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
        });
        await runHostUpdateCommand({
          ...parseHostUpdateArgs(parsed.args.slice(2)),
          hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
        });
        return;
      }
      if (parsed.args[1]) {
        throw new Error(
          `Unknown host command: ${parsed.args[1]}. Supported host commands: setup, install-service, update. If you expected this command to work, update the Tiller CLI package first.`,
        );
      }
      ensureHostAuth();
      await runHostCommand();
      return;
    case "setup":
      await ensureInteractiveConfig({
        hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
      });
      ensureAuth();
      await runSetup(parsed.args.slice(1));
      return;
    case "status":
      await runHostStatusCommand();
      return;
    case "down":
      await runHostDownCommand();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      await ensureInteractiveConfig({
        hubUrlOverride: parsedWithHubUrl.hubUrlOverride,
      });
      ensureAuth();
      await playSplash(fetchHubSetupStatus().catch(() => null));
      try {
        await runAttach(parsed.args);
      } finally {
        await shutdownAutoStartedLocalEnvs(HUB_URL, hubControlHeaders);
      }
  }
};

main().catch((err) => {
  console.error(`[tiller] Fatal: ${err}`);
  process.exit(1);
});
