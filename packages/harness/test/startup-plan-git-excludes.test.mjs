import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStartupPlanGitExcludes } from "../dist/startup-plan-git-excludes.js";

function makeRepository() {
  const root = mkdtempSync(join(tmpdir(), "tiller-plan-git-excludes-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const nestedCwd = join(root, "packages", "app");
  const planFile = join(root, ".tiller", "plan.md");
  mkdirSync(nestedCwd, { recursive: true });
  mkdirSync(join(root, ".tiller"), { recursive: true });
  writeFileSync(planFile, "Implement the approved plan.\n");
  return {
    root,
    nestedCwd,
    planFile,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function checkIgnored(root, path) {
  return spawnSync("git", ["check-ignore", "--quiet", "--", path], { cwd: root }).status === 0;
}

test("locally ignores only generated startup-plan files", () => {
  const repo = makeRepository();
  try {
    const result = ensureStartupPlanGitExcludes(repo.nestedCwd, repo.planFile);
    assert.deepEqual(result, { status: "updated" });

    assert.equal(checkIgnored(repo.root, ".tiller/plan.md"), true);
    assert.equal(checkIgnored(repo.root, ".tiller/plan.md.executed"), true);
    assert.equal(checkIgnored(repo.root, ".tiller/plan.md.runtime"), true);
    assert.equal(checkIgnored(repo.root, ".tiller/github-deleted-paths.json"), false);

    const status = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
      cwd: repo.root,
      encoding: "utf8",
    });
    assert.equal(status, "");
  } finally {
    repo.cleanup();
  }
});

test("preserves existing local excludes and is idempotent", () => {
  const repo = makeRepository();
  try {
    const excludePath = join(repo.root, ".git", "info", "exclude");
    writeFileSync(excludePath, "/local-only.txt");

    assert.deepEqual(
      ensureStartupPlanGitExcludes(repo.nestedCwd, repo.planFile),
      { status: "updated" },
    );
    const firstContent = readFileSync(excludePath, "utf8");
    assert.match(firstContent, /^\/local-only\.txt\n/);

    assert.deepEqual(
      ensureStartupPlanGitExcludes(repo.nestedCwd, repo.planFile),
      { status: "unchanged" },
    );
    assert.equal(readFileSync(excludePath, "utf8"), firstContent);
  } finally {
    repo.cleanup();
  }
});

test("canonicalizes symlinked repository paths before comparing the plan location", () => {
  const repo = makeRepository();
  const aliasContainer = mkdtempSync(join(tmpdir(), "tiller-plan-git-excludes-alias-"));
  const aliasRoot = join(aliasContainer, "repo");
  try {
    symlinkSync(repo.root, aliasRoot, process.platform === "win32" ? "junction" : "dir");
    assert.deepEqual(
      ensureStartupPlanGitExcludes(
        join(aliasRoot, "packages", "app"),
        join(aliasRoot, ".tiller", "plan.md"),
      ),
      { status: "updated" },
    );
    assert.equal(checkIgnored(repo.root, ".tiller/plan.md"), true);
  } finally {
    rmSync(aliasContainer, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("does nothing when the plan is outside the repository", () => {
  const repo = makeRepository();
  const externalRoot = mkdtempSync(join(tmpdir(), "tiller-external-plan-"));
  try {
    const excludePath = join(repo.root, ".git", "info", "exclude");
    const before = readFileSync(excludePath, "utf8");
    assert.deepEqual(
      ensureStartupPlanGitExcludes(repo.nestedCwd, join(externalRoot, "plan.md")),
      { status: "not-applicable" },
    );
    assert.equal(readFileSync(excludePath, "utf8"), before);
  } finally {
    repo.cleanup();
    rmSync(externalRoot, { recursive: true, force: true });
  }
});
