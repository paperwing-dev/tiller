import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const releaseModuleUrl = pathToFileURL(
  path.join(repoRoot, "scripts", "release.mjs"),
).href;
const releaseScriptPath = path.join(repoRoot, "scripts", "release.mjs");
const releaseWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "release.yml",
);
const containerWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "container-image.yml",
);
const temporaryDirectories: string[] = [];

async function loadReleaseModule() {
  return (await import(releaseModuleUrl)) as {
    assertNoForbiddenText(input: {
      directory: string;
      forbidden?: string[];
    }): Promise<void>;
    canReuseReleaseImages(input: {
      sandboxImage: string | null;
      scmImage: string | null;
      successfulRun: boolean;
    }): boolean;
    githubRepositoryFromRemoteUrl(value: string): string | null;
    isApprovedPublicPath(pathname: string): boolean;
    lookupGitHubReleaseCoordinate(input: {
      repository: string;
      tag: string;
      token?: string;
      fetchImpl?: typeof fetch;
    }): Promise<{ release: boolean; tag: boolean }>;
    parseImageDigest(output: string, repository: string): string;
    parseInstallerDeploymentTraffic(
      value: unknown,
    ): Array<{ versionId: string; percentage: number }>;
    parseReleaseBump(args?: string[]): "patch" | "minor";
    parsePendingReleaseLog(value: string): {
      commit: string;
      releaseVersion: string;
    } | null;
    publicSnapshotCommitArgs(input: {
      desiredTree: string;
      publicBase: string;
      resetPublicHistory?: boolean;
    }): string[];
    scanExportedSnapshot(input: {
      directory: string;
      forbiddenShas?: string[];
    }): Promise<void>;
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("release orchestration safety helpers", () => {
  it("preflights before committing and promotes stable only after publication", async () => {
    const source = await readFile(releaseScriptPath, "utf8");
    const flow = source.slice(source.indexOf("async function release("));
    const preflight = flow.indexOf("await preflightReleaseAccess()");
    const commit = flow.indexOf("await commitPrivateRelease(plan)");
    const publishHub = flow.indexOf("await publishHubRelease(");
    const publishNpm = flow.indexOf("await publishNpmPackages(");
    const deployInstaller = flow.indexOf("await deployInstaller(");
    const promoteImages = flow.indexOf("await promoteStableImages(");
    const promoteNpm = flow.indexOf("await promoteNpmPackages(");
    const promoteHub = flow.indexOf("await promoteHubRelease(");
    const moveStable = flow.indexOf("await moveStableRef(");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(commit);
    expect(publishHub).toBeLessThan(publishNpm);
    expect(publishNpm).toBeLessThan(deployInstaller);
    expect(deployInstaller).toBeLessThan(promoteImages);
    expect(promoteImages).toBeLessThan(promoteNpm);
    expect(promoteNpm).toBeLessThan(promoteHub);
    expect(promoteHub).toBeLessThan(moveStable);
    expect(source).toContain(
      'const releaseCandidateImageTag = "release-candidate"',
    );
    expect(source).not.toContain("image_tag=stable");
    expect(source).toContain("WORKERS_CI_COMMIT_SHA: releaseId");
    expect(source).toContain("credential.helper=!gh auth git-credential");
    expect(source).toContain('"public-push-probe"');
    expect(source).toContain('"commit-tree"');
    expect(source).toContain("currentMatchesSnapshot");
    expect(source).toContain('"-p"');
    expect(source).toContain("Reset public snapshot must be a root commit.");
    expect(source).toContain(
      "Public snapshot must descend from the previous public release.",
    );
    expect(source).toContain("--force-with-lease=refs/heads/main:");
    expect(source).toContain(
      'const releaseCandidateNpmTag = "release-candidate"',
    );
    expect(source).toContain('"User-Agent": "tiller-release-verifier"');
    expect(source).toContain(
      "paperwing-tiller-installer.personal-infrastructure.workers.dev/stable",
    );
    expect(source).toContain('"--prerelease"');
    expect(source).toContain('"--prerelease=false"');
    expect(source).toContain('"--json"');
    expect(source).toContain("package is missing declared binary");
    expect(source).toContain("waitForNpmLatest(packageName, version)");
    expect(source).toContain('"--prefer-online"');
    expect(source).toContain("`${publicRelease}:refs/heads/main`");
    expect(source).not.toContain('requireEnv("GH_TOKEN")');
    expect(source).not.toContain('requireEnv("CLOUDFLARE_API_TOKEN")');
  });

  it("defaults the coordinator to patch and rejects major", async () => {
    const { parseReleaseBump } = await loadReleaseModule();

    expect(parseReleaseBump()).toBe("patch");
    expect(parseReleaseBump(["--bump", "minor"])).toBe("minor");
    expect(() => parseReleaseBump(["--bump", "major"])).toThrow(
      "patch or minor",
    );
  });

  it("defaults coordinated releases to patch and allows explicit minor", async () => {
    const source = await readFile(releaseWorkflowPath, "utf8");

    expect(source).toContain("workflow_dispatch:");
    expect(source).toContain("default: patch");
    expect(source).toContain("- patch");
    expect(source).toContain("- minor");
    expect(source).not.toContain("- major");
    expect(source).toContain(
      'npm run release -- --bump "$TILLER_RELEASE_BUMP"',
    );
    expect(source).toContain("reset_public_history:");
    expect(source).toContain("actions/create-github-app-token@v2");
    expect(source).toContain(
      "GH_TOKEN: ${{ steps.release-app-token.outputs.token }}",
    );
    expect(source).not.toContain(
      "GH_TOKEN: ${{ secrets.TILLER_RELEASE_TOKEN }}",
    );
    expect(source).toContain("uses: docker/login-action@v4");
  });

  it("reserves stable image promotion for the coordinated release", async () => {
    const source = await readFile(containerWorkflowPath, "utf8");

    expect(source).toContain('default: "manual"');
    expect(source).toContain('if [[ "$IMAGE_TAG" == "stable" ]]');
    expect(source).not.toContain('default: "stable"');
  });

  it("recognizes the public mirror from common GitHub remote URLs", async () => {
    const { githubRepositoryFromRemoteUrl } = await loadReleaseModule();

    expect(
      githubRepositoryFromRemoteUrl(
        "https://github.com/paperwing-dev/tiller.git",
      ),
    ).toBe("paperwing-dev/tiller");
    expect(
      githubRepositoryFromRemoteUrl("git@github.com:Paperwing-Dev/Tiller.git"),
    ).toBe("paperwing-dev/tiller");
    expect(
      githubRepositoryFromRemoteUrl(
        "ssh://git@github.com/paperwing-dev/tiller.git",
      ),
    ).toBe("paperwing-dev/tiller");
    expect(
      githubRepositoryFromRemoteUrl(
        "https://gitlab.com/paperwing-dev/tiller.git",
      ),
    ).toBeNull();
  });

  it("reruns partial images and reuses only a successful image pair", async () => {
    const { canReuseReleaseImages } = await loadReleaseModule();
    const sandboxImage = `docker.io/example/sandbox@sha256:${"a".repeat(64)}`;
    const scmImage = `docker.io/example/scm@sha256:${"b".repeat(64)}`;

    expect(
      canReuseReleaseImages({
        sandboxImage,
        scmImage: null,
        successfulRun: false,
      }),
    ).toBe(false);
    expect(
      canReuseReleaseImages({
        sandboxImage,
        scmImage,
        successfulRun: false,
      }),
    ).toBe(false);
    expect(
      canReuseReleaseImages({ sandboxImage, scmImage, successfulRun: true }),
    ).toBe(true);
  });

  it("resumes one unfinished release even when a fix follows it", async () => {
    const { parsePendingReleaseLog } = await loadReleaseModule();
    const releaseCommit = "a".repeat(40);
    const fixCommit = "b".repeat(40);

    expect(
      parsePendingReleaseLog(
        `${fixCommit}\tfix(release): repair Actions preflight\n${releaseCommit}\tchore(release): monorepo v0.3.0`,
      ),
    ).toEqual({ commit: releaseCommit, releaseVersion: "0.3.0" });
    expect(parsePendingReleaseLog(`${fixCommit}\tfix: unrelated`)).toBeNull();
    expect(() =>
      parsePendingReleaseLog(
        `${releaseCommit}\tchore(release): monorepo v0.3.0\n${fixCommit}\tchore(release): monorepo v0.4.0`,
      ),
    ).toThrow("Multiple unfinished release commits");
  });

  it("checks GitHub releases and tags independently and fails closed", async () => {
    const { lookupGitHubReleaseCoordinate } = await loadReleaseModule();
    const fetchImpl = async (input: string | URL | Request) =>
      new Response(null, {
        status: String(input).includes("/releases/tags/") ? 404 : 200,
      });

    await expect(
      lookupGitHubReleaseCoordinate({
        repository: "paperwing-dev/tiller",
        tag: "tiller-hub-v0.2.55",
        fetchImpl,
        token: "test-token",
      }),
    ).resolves.toEqual({ release: false, tag: true });

    await expect(
      lookupGitHubReleaseCoordinate({
        repository: "paperwing-dev/tiller",
        tag: "tiller-hub-v0.2.55",
        fetchImpl: async () => new Response(null, { status: 403 }),
        token: "test-token",
      }),
    ).rejects.toThrow("HTTP 403");
  });

  it("allows only the generated mirror export roots", async () => {
    const { isApprovedPublicPath } = await loadReleaseModule();

    expect(isApprovedPublicPath("packages/hub/package.json")).toBe(true);
    expect(isApprovedPublicPath(".github/workflows/release.yml")).toBe(true);
    expect(isApprovedPublicPath(".env.production")).toBe(false);
    expect(isApprovedPublicPath("internal/secrets.txt")).toBe(false);
  });

  it("keeps normal public snapshots linear and supports an explicit root reset", async () => {
    const { publicSnapshotCommitArgs } = await loadReleaseModule();
    const expectedMessage = [
      "-m",
      "chore(release): publish generated snapshot",
    ];

    expect(
      publicSnapshotCommitArgs({
        desiredTree: "tree-sha",
        publicBase: "previous-release",
      }),
    ).toEqual([
      "commit-tree",
      "tree-sha",
      "-p",
      "previous-release",
      ...expectedMessage,
    ]);
    expect(
      publicSnapshotCommitArgs({
        desiredTree: "tree-sha",
        publicBase: "previous-release",
        resetPublicHistory: true,
      }),
    ).toEqual(["commit-tree", "tree-sha", ...expectedMessage]);
  });

  it("rejects private commit identifiers and token-shaped secrets before publication", async () => {
    const { scanExportedSnapshot } = await loadReleaseModule();
    const directory = await mkdtemp(
      path.join(tmpdir(), "tiller-release-scan-"),
    );
    temporaryDirectories.push(directory);
    const privateSha = "1".repeat(40);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        source: privateSha,
        token: `github_pat_${"a".repeat(30)}`,
      }),
    );

    await expect(
      scanExportedSnapshot({ directory, forbiddenShas: [privateSha] }),
    ).rejects.toThrow("Public snapshot safety scan failed");
  });

  it("rejects private commit identifiers from generated release output", async () => {
    const { assertNoForbiddenText } = await loadReleaseModule();
    const directory = await mkdtemp(
      path.join(tmpdir(), "tiller-release-output-scan-"),
    );
    temporaryDirectories.push(directory);
    const privateSha = "2".repeat(40);
    await writeFile(path.join(directory, "index.js"), `build=${privateSha}`);

    await expect(
      assertNoForbiddenText({ directory, forbidden: [privateSha] }),
    ).rejects.toThrow("private commit identifiers");
  });

  it("extracts only immutable image digests", async () => {
    const { parseImageDigest } = await loadReleaseModule();
    const digest = "a".repeat(64);

    expect(
      parseImageDigest(
        `Name: image\nDigest: sha256:${digest}\n`,
        "docker.io/example/image",
      ),
    ).toBe(`docker.io/example/image@sha256:${digest}`);
    expect(() =>
      parseImageDigest("Name: image\n", "docker.io/example/image"),
    ).toThrow("immutable digest");
  });

  it("preserves exact Installer rollback traffic", async () => {
    const { parseInstallerDeploymentTraffic } = await loadReleaseModule();
    expect(
      parseInstallerDeploymentTraffic({
        versions: [
          { version_id: "old-a", percentage: 25 },
          { version_id: "old-b", percentage: 75 },
        ],
      }),
    ).toEqual([
      { versionId: "old-a", percentage: 25 },
      { versionId: "old-b", percentage: 75 },
    ]);
    expect(() =>
      parseInstallerDeploymentTraffic({
        versions: [{ version_id: "old-a", percentage: 80 }],
      }),
    ).toThrow("total 100%");
  });
});
