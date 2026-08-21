import { HUB_URL } from "./config.js";
import {
  readSetupStatusWithValidatedCredential,
} from "./host-auth.js";
import {
  checkLocalRunnerHealth,
} from "./local-stack.js";
import { collectHubHostChecks } from "./host-diagnostics.js";
import { CheckResult, hasFailures, hasWarnings, printCheckReport } from "./readiness.js";
import { collectSetupChecks } from "./setup.js";

export interface DoctorReport {
  checks: CheckResult[];
  healthy: boolean;
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const setup = await collectSetupChecks();
  const checks = [...setup.checks];
  const setupStatus = HUB_URL
    ? await readSetupStatusWithValidatedCredential()
    : null;

  // A machine is optional while Cloudflare Containers remains the default.
  // Once a machine has registered, surface its durable/live health.
  if (
    setupStatus
    && (setupStatus.hostRegistered || setupStatus.hostConnected)
  ) {
    checks.push(...collectHubHostChecks(setupStatus));
  }

  if (setupStatus?.enabledHarnesses.includes("codex")) {
    const selectedOpenAIMode = setupStatus.openaiBillingMode ?? null;
    const chatgptAuthStatus = setupStatus.chatgptAuthStatus ?? (setupStatus.hasChatGPTAuth ? "connected" : "missing");
    const hubCodexAuth = chatgptAuthStatus === "connected" || chatgptAuthStatus === "refreshing";
    const selectedCredentialReady = selectedOpenAIMode === "api"
      ? setupStatus.hasOpenAIKey
      : selectedOpenAIMode === "subscription" && hubCodexAuth;
    checks.push({
      id: "chatgpt-auth",
      label: selectedOpenAIMode === "api"
        ? "OpenAI API key"
        : selectedOpenAIMode === "subscription" ? "Codex subscription login" : "OpenAI billing mode",
      level: selectedCredentialReady ? "ok" : "warn",
      detail: selectedOpenAIMode === null
        ? "not selected"
        : selectedOpenAIMode === "api"
        ? setupStatus.hasOpenAIKey ? "configured in Tiller" : "not configured"
        : chatgptAuthStatus === "connected"
          ? "stored in Tiller"
          : chatgptAuthStatus === "refreshing"
            ? "refreshing connected Codex login"
            : chatgptAuthStatus === "needs_reconnect"
              ? "Codex login needs reconnection"
              : chatgptAuthStatus === "temporarily_unavailable"
                ? "Codex login is temporarily unavailable"
                : "not connected",
      fixHint: selectedCredentialReady
        ? undefined
        : selectedOpenAIMode === null
          ? "select an OpenAI billing mode in Global Settings"
          : selectedOpenAIMode === "api"
          ? "configure OPENAI_API_KEY in Settings"
          : "run `tiller auth connect codex`",
    });

    const routeStatus = setupStatus.codexRouteStatus ?? "unavailable";
    checks.push({
      id: "codex-route",
      label: "OpenAI route",
      level: selectedOpenAIMode !== null && (routeStatus === "available" || routeStatus === "direct_api") ? "ok" : "warn",
      detail: selectedOpenAIMode === null
        ? "no billing mode selected"
        : routeStatus === "available"
        ? "subscription app-server route available"
        : routeStatus === "direct_api"
        ? "direct API route available"
          : routeStatus === "backend_offline"
            ? "selected execution backend is offline"
            : routeStatus === "runtime_update_required"
              ? "connected runtime must be updated"
              : routeStatus === "environment_not_connected"
                ? "environment is not connected"
                : routeStatus === "authentication_unavailable"
                  ? "selected OpenAI authentication is unavailable"
                  : "no Codex route available",
      fixHint: selectedOpenAIMode !== null && (routeStatus === "available" || routeStatus === "direct_api")
        ? undefined
        : selectedOpenAIMode === null
          ? "select an OpenAI billing mode in Global Settings"
          : selectedOpenAIMode === "api"
          ? "configure OPENAI_API_KEY in Settings"
          : routeStatus === "runtime_update_required"
            ? "run `tiller host update`, then restart the persistent machine service"
            : routeStatus === "backend_offline"
              ? "start or reconnect the selected execution backend"
              : routeStatus === "environment_not_connected"
                ? "start the environment and wait for it to connect"
                : chatgptAuthStatus === "temporarily_unavailable"
                  ? "retry shortly; if the problem persists, run `tiller auth connect codex`"
                  : "run `tiller auth connect codex`",
    });
  }

  const runnerHealth = await checkLocalRunnerHealth();
  checks.push({
    id: "runner-health",
    label: "host container control health",
    level: runnerHealth.ok ? "ok" : "warn",
    detail: runnerHealth.ok ? runnerHealth.detail : runnerHealth.detail ?? "host container control is not responding on localhost",
    fixHint: runnerHealth.ok ? undefined : "run `tiller host setup` to install or restart the execution-machine service",
  });

  return {
    checks,
    healthy: !hasFailures(checks),
  };
}

export async function runDoctor(): Promise<void> {
  const report = await collectDoctorReport();
  printCheckReport("Doctor", report.checks);
  const summary = !report.healthy
    ? "[tiller] Doctor found required setup issues. Fix the failing items above.\n"
    : hasWarnings(report.checks)
      ? "[tiller] Setup looks healthy. Your machine is currently unavailable; run `tiller host setup` if you want to use it.\n"
      : "[tiller] Setup and execution-machine services look healthy.\n";
  process.stderr.write(summary);
  process.exitCode = report.healthy ? 0 : 1;
}
