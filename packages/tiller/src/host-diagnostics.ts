import type { HubSetupStatus } from "./codex-subscription.js";
import type { CheckResult } from "./readiness.js";

export function collectHubHostChecks(status: HubSetupStatus): CheckResult[] {
  const connection: CheckResult = status.hostConnected
    ? {
        id: "hub-host-connection",
        label: "Hub execution-machine connection",
        level: "ok",
        detail: "connected",
      }
    : {
        id: "hub-host-connection",
        label: "Hub execution-machine connection",
        level: "fail",
        detail: status.hostRegistered ? "registered, but the Hub reports the live machine session disconnected" : "no execution machine is registered with the Hub",
        fixHint: status.hostRegistered
          ? "restart `tiller-host.service`; if it stays disconnected, inspect `journalctl -u tiller-host` for reconnect errors"
          : "run `tiller host setup`, then start or restart `tiller-host.service`",
      };

  return [connection];
}
