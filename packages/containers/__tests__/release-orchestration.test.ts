import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
async function loadReleaseModule() {
  return (await import(releaseModuleUrl)) as {
    canReuseReleaseImages(input: {
      sandboxImage: string | null;
      scmImage: string | null;
      successfulRun: boolean;
    }): boolean;
    githubRepositoryFromRemoteUrl(value: string): string | null;
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
    requiresSandboxBaseRebuild(changedFiles?: string[]): boolean;
    workflowRunIdFromDispatchOutput(value: string): string;
  };
}

describe("release orchestration safety helpers", () => {
  it("preflights before committing and promotes stable only after publication", async () => {
    const source = await readFile(releaseScriptPath, "utf8");
    const flow = source.slice(source.indexOf("async function release("));
    const preflight = flow.indexOf("await preflightReleaseAccess()");
    const commit = flow.indexOf("await commitRelease(plan)");
    const prepare = flow.indexOf("await prepareReleaseTree(releaseCommit)");
    const build = flow.indexOf("await buildAndTestReleaseTree()");
    const push = flow.indexOf("await pushReleaseCommit(");
    const publishHub = flow.indexOf("await publishHubRelease(");
    const publishNpm = flow.indexOf("await publishNpmPackages(");
    const deployInstaller = flow.indexOf("await deployInstaller(");
    const promoteImages = flow.indexOf("await promoteStableImages(");
    const promoteNpm = flow.indexOf("await promoteNpmPackages(");
    const promoteHub = flow.indexOf("await promoteHubRelease(");
    const moveStable = flow.indexOf("await moveStableRef(");

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeLessThan(commit);
    expect(commit).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(build);
    expect(build).toBeLessThan(push);
    expect(push).toBeLessThan(publishHub);
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
    expect(source).toContain('const publicRepository = "paperwing-dev/tiller"');
    expect(source).toContain(
      'const releaseDirectory = path.join(releaseRoot, "source")',
    );
    expect(source).toContain('"--no-hardlinks"');
    expect(source).toContain('"--no-checkout"');
    expect(source).toContain("async function buildAndTestReleaseTree()");
    expect(source).toContain("`${releaseCommit}:refs/heads/main`");
    expect(source).toContain("origin must be ${publicRepository}");
    expect(source).toContain("tiller-release/stable is missing");
    expect(source).toContain("`source_revision=${releaseId}`");
    expect(source).toContain("env: options.env");
    expect(source).not.toContain('"commit-tree"');
    expect(source).not.toContain("TILLER_PUBLIC_PUSH_TOKEN");
    expect(source).not.toContain("resetPublicHistory");
    expect(source).not.toContain("--force-with-lease");
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
    expect(source).not.toContain("reset_public_history:");
    expect(source).toContain("environment: production");
    expect(source).toContain(
      "if: ${{ github.repository == 'paperwing-dev/tiller' && github.ref == 'refs/heads/main' }}",
    );
    expect(source).toContain("actions/create-github-app-token@v2");
    expect(source).toContain(
      "GH_TOKEN: ${{ steps.release-app-token.outputs.token }}",
    );
    expect(source).toContain(
      "token: ${{ steps.release-app-token.outputs.token }}",
    );
    expect(source).not.toContain("TILLER_PUBLIC_PUSH_TOKEN");
    expect(source).not.toContain(
      "GH_TOKEN: ${{ secrets.TILLER_RELEASE_TOKEN }}",
    );
    expect(source).not.toContain("Pull pinned public-export scanner");
    expect(source).toContain("uses: docker/login-action@v4");
    expect(source).toContain("repositories: tiller");
    expect(source).not.toContain("TILLER_SOURCE_TOKEN");
  });

  it("reserves stable image promotion for the coordinated release", async () => {
    const source = await readFile(containerWorkflowPath, "utf8");

    expect(source).toContain('default: "manual"');
    expect(source).toContain('if [[ "$IMAGE_TAG" == "stable" ]]');
    expect(source).not.toContain('default: "stable"');
    expect(source).toContain("source_revision:");
    expect(source).toContain("image_revision:");
    expect(source).toContain("IMAGE_REVISION:");
    expect(source).toContain(
      "ref: ${{ inputs.source_revision || github.sha }}",
    );
    expect(source).toContain("TILLER_IMAGE_COMMIT=${{ env.IMAGE_REVISION }}");
  });

  it("recognizes the public release repository from common GitHub remote URLs", async () => {
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

  it("watches the exact image workflow run returned by dispatch", async () => {
    const { workflowRunIdFromDispatchOutput } = await loadReleaseModule();

    expect(
      workflowRunIdFromDispatchOutput(
        "https://github.com/paperwing-dev/tiller/actions/runs/123456789",
      ),
    ).toBe("123456789");
    expect(() => workflowRunIdFromDispatchOutput("dispatched")).toThrow(
      "GitHub CLI did not return the dispatched workflow run URL",
    );

    const source = await readFile(releaseScriptPath, "utf8");
    expect(source).not.toContain("entry.headSha === releaseId");
  });

  it("rebuilds the sandbox base for every declared base build input", async () => {
    const { requiresSandboxBaseRebuild } = await loadReleaseModule();

    expect(
      requiresSandboxBaseRebuild([
        "packages/containers/verify-codex-reviewer-contract.sh",
      ]),
    ).toBe(true);
    expect(
      requiresSandboxBaseRebuild(["packages/containers/Dockerfile.base"]),
    ).toBe(true);
    expect(
      requiresSandboxBaseRebuild([".github/workflows/container-image.yml"]),
    ).toBe(true);
    expect(requiresSandboxBaseRebuild(["packages/containers/Dockerfile"])).toBe(
      false,
    );
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
