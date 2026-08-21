import workspacePolicy from "./workspace-policy.json" with { type: "json" };

export const runtimeExcludes = workspacePolicy.runtimeExcludes;
export const runtimeExactFiles = workspacePolicy.runtimeExactFiles ?? [];

export function normalizeRelativePath(relPath) {
  if (!relPath) return "/";
  return relPath.startsWith("/") ? relPath : `/${relPath}`;
}

export function matchesExcludePattern(relPath, pattern) {
  const normalizedPath = normalizeRelativePath(relPath);
  const normalizedPattern = normalizeRelativePath(pattern);
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`) ||
    normalizedPath.includes(`${normalizedPattern}/`) ||
    normalizedPath.endsWith(normalizedPattern)
  );
}

export function isExcluded(relPath) {
  const normalizedPath = normalizeRelativePath(relPath);
  if (runtimeExactFiles.includes(normalizedPath)) {
    return true;
  }
  return runtimeExcludes.some((pattern) => matchesExcludePattern(normalizedPath, pattern));
}
