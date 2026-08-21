import {
  HUB_URL,
  hubControlHeaders,
} from "./config.js";
import {
  fetchHubSetupStatus,
  isHubSetupStatusAuthError,
  type HubSetupStatus,
} from "./codex-subscription.js";

export const HOST_CREDENTIAL_SETUP_INSTRUCTION =
  "Run `tiller host setup --hub-url https://<exact-host>.workers.dev`.";

/**
 * Noninteractive commands may validate saved credentials, but never launch a
 * browser. Transient Hub failures remain reconnectable; a definitive Access
 * rejection fails with the interactive setup instruction.
 */
export async function readSetupStatusWithValidatedCredential(
  hubUrl = HUB_URL,
  headers: Record<string, string> = hubControlHeaders,
): Promise<HubSetupStatus | null> {
  if (!hubUrl) return null;
  try {
    return await fetchHubSetupStatus(hubUrl, headers);
  } catch (error) {
    if (isHubSetupStatusAuthError(error)) {
      throw new Error(
        `The saved Hub service credential is invalid. ${HOST_CREDENTIAL_SETUP_INSTRUCTION}`,
        { cause: error },
      );
    }
    return null;
  }
}
