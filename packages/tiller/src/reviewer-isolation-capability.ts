import { spawnSync } from "node:child_process";

const REVIEWER_ISOLATION_LABEL = "dev.tiller.reviewer-isolation-protocol";

export function resolveHostReviewerIsolationProtocol(
  image: string,
  imageSourceId: string | null,
  options: {
    inspectLabel?: (image: string) => string | null;
  } = {},
): 1 | null {
  if (!imageSourceId) return null;
  const inspectLabel = options.inspectLabel ?? ((candidate: string) => {
    const result = spawnSync("docker", [
      "image",
      "inspect",
      "--format",
      `{{ index .Config.Labels "${REVIEWER_ISOLATION_LABEL}" }}`,
      candidate,
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    return result.status === 0 ? result.stdout.trim() : null;
  });
  return inspectLabel(image) === "1" ? 1 : null;
}
