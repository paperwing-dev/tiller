export const MANAGED_LOCAL_RUNNER_IMAGE_PREFIX = "docker.io/jamieatlason/tiller-sandbox";

const MANAGED_LOCAL_RUNNER_IMAGE_RE = /^(?:docker\.io\/)?jamieatlason\/tiller-sandbox(?::[^\s/]+|@sha256:[0-9a-f]{64})$/;
const PINNED_MANAGED_LOCAL_RUNNER_IMAGE_RE = /^docker\.io\/jamieatlason\/tiller-sandbox@(sha256:[0-9a-f]{64})$/;
const LEGACY_PINNED_MANAGED_LOCAL_RUNNER_IMAGE_RE = /^docker\.io\/jamieatlason\/tiller-sandbox:([0-9a-f]{40})$/;

export function isManagedLocalRunnerImageRef(image: string): boolean {
  return MANAGED_LOCAL_RUNNER_IMAGE_RE.test(image.trim());
}

export function parseManagedLocalRunnerImageSourceId(image: string): string | null {
  const normalized = image.trim();
  return normalized.match(PINNED_MANAGED_LOCAL_RUNNER_IMAGE_RE)?.[1]
    ?? normalized.match(LEGACY_PINNED_MANAGED_LOCAL_RUNNER_IMAGE_RE)?.[1]
    ?? null;
}
