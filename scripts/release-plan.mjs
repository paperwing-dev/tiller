export const RELEASE_WORKSPACES = Object.freeze({
  hub: Object.freeze({
    workspace: "packages/hub",
    packageName: "tiller-hub",
  }),
  tiller: Object.freeze({
    workspace: "packages/tiller",
    packageName: "@paperwing-dev/tiller",
  }),
  harness: Object.freeze({
    workspace: "packages/harness",
    packageName: "@paperwing-dev/tiller-harness",
  }),
  containers: Object.freeze({
    workspace: "packages/containers",
    packageName: "tiller-containers",
  }),
  installer: Object.freeze({
    workspace: "packages/installer",
    packageName: "@paperwing/tiller-installer",
  }),
});

export const RELEASE_WORKSPACE_KEYS = Object.freeze(
  Object.keys(RELEASE_WORKSPACES),
);

const RELEASE_BUMPS = new Set(["patch", "minor"]);

const DOCUMENTATION_OR_TEST =
  /(^|\/)(?:docs?|__tests__)(?:\/|$)|(?:^|\/)(?:README|CONTRIBUTING|AGENTS)\.md$|\.(?:md|test\.[cm]?[jt]sx?|spec\.[cm]?[jt]sx?)$/i;

function normalizedPaths(values) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) =>
          String(value ?? "")
            .trim()
            .replace(/^\.\//, ""),
        )
        .filter(Boolean),
    ),
  ].sort();
}

export function parseWorkspaceVersion(value, workspace = "workspace") {
  const version = String(value ?? "").trim();
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) {
    throw new Error(
      `${workspace} version ${version || "<missing>"} must be major.minor.patch.`,
    );
  }
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function assertCoordinatedVersionLine(versions) {
  const parsed = RELEASE_WORKSPACE_KEYS.filter(
    (workspace) => workspace !== "tiller",
  ).map((workspace) => ({
    workspace,
    ...parseWorkspaceVersion(versions?.[workspace], workspace),
  }));
  const expected = parsed[0];
  if (
    parsed.some(
      (entry) =>
        entry.major !== expected.major ||
        entry.minor !== expected.minor ||
        entry.patch !== expected.patch,
    )
  ) {
    throw new Error(
      `Coordinated workspace version drift detected: ${parsed
        .map((entry) => `${entry.workspace}=${entry.version}`)
        .join(", ")}.`,
    );
  }
  return {
    version: expected.version,
    major: expected.major,
    minor: expected.minor,
    patch: expected.patch,
  };
}

export function normalizeReleaseBump(value = "patch") {
  const bump = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!RELEASE_BUMPS.has(bump)) {
    throw new Error(
      `Release bump must be patch or minor, not ${bump || "<missing>"}.`,
    );
  }
  return bump;
}

function nextReleaseVersion(line, bump) {
  return bump === "minor"
    ? `${line.major}.${line.minor + 1}.0`
    : `${line.major}.${line.minor}.${line.patch + 1}`;
}

export function inferReleaseBump({ versions, releaseVersion }) {
  const line = assertCoordinatedVersionLine(versions);
  for (const bump of RELEASE_BUMPS) {
    if (nextReleaseVersion(line, bump) === releaseVersion) return bump;
  }
  throw new Error(
    `Pending release ${releaseVersion} is neither the next patch nor the next minor after ${line.version}.`,
  );
}

export function detectCliChanges(changedFiles) {
  return normalizedPaths(changedFiles).some((pathname) => {
    if (DOCUMENTATION_OR_TEST.test(pathname)) return false;
    return (
      /^configs\//.test(pathname) ||
      /^packages\/tiller\/(?:src\/|package\.json$|tsconfig\.json$)/.test(
        pathname,
      )
    );
  });
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
}

export function resolveReleasePlan({
  bump = "patch",
  changedFiles = [],
  forceCli = false,
  versions,
} = {}) {
  const line = assertCoordinatedVersionLine(versions);
  const releaseVersion = nextReleaseVersion(line, normalizeReleaseBump(bump));
  const releaseVersionParts = parseWorkspaceVersion(releaseVersion, "release");
  const currentCliVersion = parseWorkspaceVersion(versions?.tiller, "tiller");
  const publishCli = Boolean(forceCli) || detectCliChanges(changedFiles);
  if (
    publishCli &&
    compareVersions(releaseVersionParts, currentCliVersion) <= 0
  ) {
    throw new Error(
      `Next coordinated release ${releaseVersion} must be newer than CLI ${currentCliVersion.version}.`,
    );
  }

  return {
    releaseVersion,
    targetVersions: Object.fromEntries(
      RELEASE_WORKSPACE_KEYS.map((workspace) => [
        workspace,
        workspace === "tiller" && !publishCli
          ? currentCliVersion.version
          : releaseVersion,
      ]),
    ),
    publishCli,
  };
}
