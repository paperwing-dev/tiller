import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const STARTUP_PLAN_SUFFIXES = ["", ".executed", ".runtime"] as const;

export type StartupPlanGitExcludeResult =
  | { status: "updated" | "unchanged" | "not-applicable" }
  | { status: "failed"; error: string };

function readGitPath(workspaceDir: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd: workspaceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return childPath !== ""
    && childPath !== ".."
    && !childPath.startsWith(`..${sep}`)
    && !isAbsolute(childPath);
}

function resolveCanonicalPath(pathValue: string): string {
  const absolutePath = resolve(pathValue);
  let existingAncestor = absolutePath;
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return absolutePath;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

/**
 * Keeps generated startup-plan files out of an implementor's local Git view.
 * The repository's tracked .gitignore is intentionally left unchanged.
 */
export function ensureStartupPlanGitExcludes(
  workspaceDir: string,
  planFile: string,
): StartupPlanGitExcludeResult {
  const repoRootValue = readGitPath(workspaceDir, ["rev-parse", "--show-toplevel"]);
  const excludePathValue = readGitPath(workspaceDir, ["rev-parse", "--git-path", "info/exclude"]);
  if (!repoRootValue || !excludePathValue) {
    return { status: "not-applicable" };
  }

  let repoRoot: string;
  let resolvedPlanFile: string;
  try {
    repoRoot = resolveCanonicalPath(repoRootValue);
    resolvedPlanFile = resolveCanonicalPath(planFile);
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isPathInside(repoRoot, resolvedPlanFile)) {
    return { status: "not-applicable" };
  }

  const relativePlanFile = relative(repoRoot, resolvedPlanFile).split(sep).join("/");
  const patterns = STARTUP_PLAN_SUFFIXES.map((suffix) => `/${relativePlanFile}${suffix}`);
  const excludePath = isAbsolute(excludePathValue)
    ? excludePathValue
    : resolve(workspaceDir, excludePathValue);

  try {
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const existingLines = new Set(existing.split(/\r?\n/));
    const missing = patterns.filter((pattern) => !existingLines.has(pattern));
    if (missing.length === 0) {
      return { status: "unchanged" };
    }

    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${separator}${missing.join("\n")}\n`);
    return { status: "updated" };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
