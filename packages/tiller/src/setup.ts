import {
  CF_ACCESS_CLIENT_ID,
  CF_ACCESS_CLIENT_SECRET,
  CONFIG_PATH,
  HUB_URL,
  LOCAL_RUNNER_IMAGE,
  configExists,
  isLocalHubUrl,
  isWorkersDevHubUrl,
  loadConfig,
} from "./config.js";
import {
  checkHubHealth,
  dockerInstalled,
  dockerReady,
  localImageExists,
} from "./local-stack.js";
import { CheckResult, hasFailures, hasWarnings, printCheckReport } from "./readiness.js";

export interface SetupReport {
  checks: CheckResult[];
  ready: boolean;
}

interface SetupOptions {
  local?: boolean;
}

function sourceLabel(envValue: string | undefined, configValue: string | undefined): string | undefined {
  if (envValue) return "via env";
  if (configValue) return `via ${CONFIG_PATH}`;
  return undefined;
}

function configHint(): string {
  return "run `tiller init --hub-url https://<exact-host>.workers.dev`";
}

export async function collectSetupChecks(options: SetupOptions = {}): Promise<SetupReport> {
  const config = loadConfig();
  const checks: CheckResult[] = [];
  const configPresent = configExists();
  const configuredHubUrl = (process.env.HUB_URL || config.hubUrl || "").trim();
  const accessSource = sourceLabel(process.env.CF_ACCESS_CLIENT_ID, config.clientId) ?? sourceLabel(process.env.CF_ACCESS_CLIENT_SECRET, config.clientSecret);
  const hasAccessCredentials = Boolean(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET);
  const hasConfiguredHubUrl = Boolean(configuredHubUrl);
  const supportedHubUrl = isWorkersDevHubUrl(configuredHubUrl)
    || isLocalHubUrl(configuredHubUrl);
  const localHub = isLocalHubUrl(configuredHubUrl);
  const hubHealth = supportedHubUrl ? await checkHubHealth() : null;
  const requireLocal = options.local === true;

  checks.push({
    id: "config-file",
    label: "config file",
    level: configPresent ? "ok" : hasAccessCredentials || hasConfiguredHubUrl ? "warn" : "fail",
    detail: configPresent ? CONFIG_PATH : `missing: ${CONFIG_PATH}`,
    fixHint: configPresent ? undefined : configHint(),
  });

  checks.push({
    id: "hub-url",
    label: "hub URL configured",
    level: supportedHubUrl ? "ok" : "fail",
    detail: supportedHubUrl
      ? `${configuredHubUrl}${sourceLabel(process.env.HUB_URL, config.hubUrl) ? ` (${sourceLabel(process.env.HUB_URL, config.hubUrl)})` : ""}`
      : hasConfiguredHubUrl
        ? "saved URL is not the exact workers.dev origin"
        : "hubUrl missing",
    fixHint: supportedHubUrl
      ? undefined
      : "run `tiller host setup --hub-url https://<exact-host>.workers.dev`",
  });

  checks.push({
    id: "access-creds",
    label: "Cloudflare Access credentials",
    level: hasAccessCredentials || localHub ? "ok" : "warn",
    detail: hasAccessCredentials
      ? accessSource ?? "configured"
      : localHub
        ? "not required for localhost development"
        : "not configured",
    fixHint: hasAccessCredentials || localHub
      ? undefined
      : "run `tiller init --hub-url https://<exact-host>.workers.dev` to renew the encrypted connection",
  });

  if (hubHealth) {
    checks.push({
      id: "hub-reachable",
      label: "hub reachable",
      level: hubHealth.ok ? "ok" : "fail",
      detail: hubHealth.ok ? HUB_URL : hubHealth.detail ?? HUB_URL,
      fixHint: hubHealth.ok
        ? undefined
        : hasAccessCredentials
          ? `check the tiller-hub deployment and Access service token for ${HUB_URL}`
          : `check the tiller-hub deployment at ${HUB_URL}, then reconnect through \`tiller init\``,
    });
  } else {
    checks.push({
      id: "hub-reachable",
      label: "hub reachable",
      level: "warn",
      detail: "skipped until hubUrl is configured",
    });
  }

  const hasDockerInstalled = dockerInstalled();
  checks.push({
    id: "docker-installed",
    label: "docker installed",
    level: hasDockerInstalled ? "ok" : requireLocal ? "fail" : "warn",
    detail: hasDockerInstalled ? "docker is on PATH" : "docker not found",
    fixHint: hasDockerInstalled
      ? undefined
      : requireLocal
        ? "install Docker Desktop or another Docker engine and re-run `tiller setup`"
        : "needed only for workloads on Your machine; install Docker Desktop or another Docker engine before selecting it",
  });

  const isDockerReady = hasDockerInstalled && dockerReady();
  const hasLocalImage = isDockerReady && localImageExists();
  checks.push({
    id: "docker-running",
    label: "docker running",
    level: hasDockerInstalled ? (isDockerReady ? "ok" : requireLocal ? "fail" : "warn") : "warn",
    detail: hasDockerInstalled ? (isDockerReady ? "daemon ready" : "Docker daemon is not responding") : "skipped until Docker is installed",
    fixHint: hasDockerInstalled && !isDockerReady
      ? requireLocal
        ? "start Docker Desktop or your Docker daemon and re-run `tiller setup`"
        : "needed only for workloads on Your machine; start Docker Desktop or your Docker daemon before selecting it"
      : undefined,
  });

  checks.push({
    id: "host-image",
    label: "host image present",
    level: isDockerReady ? (hasLocalImage ? "ok" : requireLocal ? "fail" : "warn") : "warn",
    detail: isDockerReady ? (hasLocalImage ? LOCAL_RUNNER_IMAGE : `${LOCAL_RUNNER_IMAGE} not found`) : "skipped until Docker is running",
    fixHint: isDockerReady && !hasLocalImage
      ? requireLocal
        ? "run `tiller host setup` to pull the image, or set localRunnerImage in config if using a custom image"
        : "needed only for workloads on Your machine; run `tiller host setup` to pull the image automatically"
      : undefined,
  });

  return {
    checks,
    ready: !hasFailures(checks),
  };
}

export async function runSetup(argv: string[] = []): Promise<void> {
  const requireLocal = argv.includes("--local");
  const report = await collectSetupChecks({ local: requireLocal });
  printCheckReport("Setup check", report.checks);
  const summary = !report.ready
    ? "[tiller] Setup incomplete. Fix the items above and re-run `tiller setup`.\n"
    : hasWarnings(report.checks)
      ? requireLocal
        ? "[tiller] Setup is usable but has warnings. Review the items above before selecting Your machine.\n"
        : "[tiller] Cloudflare Containers are ready. The warnings above only matter if you want to use Your machine later.\n"
      : "[tiller] Setup complete. You can run `tiller`.\n";
  process.stderr.write(summary);
  process.exitCode = report.ready ? 0 : 1;
}
