import { INSTALLER_RUNTIME_BINDINGS } from "./release";
import type { ReleaseDescriptorV1 } from "./types";

/** A compact descriptor for focused topology tests. */
export function releaseDescriptorFixture(): ReleaseDescriptorV1 {
  return {
    schemaVersion: 1,
    releaseId: "a".repeat(40),
    version: "1.0.0-test",
    releaseNotesUrl: "https://github.com/paperwing-dev/tiller/releases/tag/test",
    bundle: {
      url: "https://github.com/paperwing-dev/tiller/releases/download/test/tiller-hub-test.tar.gz",
      size: 1,
      sha256: "b".repeat(64),
    },
    uploadTemplate: {
      mainModule: "index.js",
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: false, headSamplingRate: 0 },
      assets: { notFoundHandling: "single-page-application" },
      bindings: [
        { type: "durable_object_namespace", name: "SANDBOX", className: "SandboxDO" },
        { type: "kv_namespace", name: "ENVS_KV", resourceSlot: "installation-kv" },
        { type: "r2_bucket", name: "BUCKET", resourceSlot: "installation-r2" },
        ...INSTALLER_RUNTIME_BINDINGS.map((binding) => ({ ...binding })),
      ],
      exports: {
        SandboxDO: { type: "durable-object", storage: "sqlite" },
      },
    },
    containers: [{
      className: "SandboxDO",
      applicationNameSuffix: "sandbox",
      image: `docker.io/example/tiller@sha256:${"c".repeat(64)}`,
      instanceType: "basic",
      maxInstances: 2,
    }],
  };
}

/** A complete production-shaped replacement for the generated installer build input. */
export function productionReleaseDescriptorFixture(): ReleaseDescriptorV1 {
  const durableObjects = [
    ["SCHEDULED_RUN_CAPACITY", "ScheduledRunCapacityDO"],
    ["ENV_LIFECYCLE", "EnvLifecycleDO"],
    ["ENV_REVIEW", "EnvReviewDO"],
    ["ARTIFACT_STORE", "ArtifactStoreDO"],
    ["HUB", "HubDO"],
    ["CODEX_AUTH", "CodexAuthDO"],
    ["SANDBOX", "SandboxDO"],
    ["TILLER_VOICE", "TillerVoice"],
    ["GITHUB_JOB", "GitHubJobDO"],
    ["PLANNER_RUN", "PlannerRunDO"],
    ["THREAD", "ThreadDO"],
    ["WORKSPACE", "WorkspaceDO"],
    ["REVIEWER_CHAT", "ReviewerChatAgent"],
  ] as const;
  return {
    schemaVersion: 1,
    releaseId: "a".repeat(40),
    version: "1.0.0-test",
    releaseNotesUrl: "https://github.com/paperwing-dev/tiller/releases/tag/test",
    bundle: {
      url: "https://github.com/paperwing-dev/tiller/releases/download/test/tiller-hub-test.tar.gz",
      size: 1,
      sha256: "b".repeat(64),
    },
    uploadTemplate: {
      mainModule: "index.js",
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: true, headSamplingRate: 1 },
      assets: { notFoundHandling: "single-page-application" },
      bindings: [
        ...durableObjects.map(([name, className]) => ({
          type: "durable_object_namespace" as const,
          name,
          className,
        })),
        { type: "kv_namespace", name: "ENVS_KV", resourceSlot: "installation-kv" },
        { type: "r2_bucket", name: "BUCKET", resourceSlot: "installation-r2" },
        ...INSTALLER_RUNTIME_BINDINGS.map((binding) => ({ ...binding })),
      ],
      exports: Object.fromEntries(durableObjects.map(([, className]) => [
        className,
        { type: "durable-object" as const, storage: "sqlite" as const },
      ])),
    },
    containers: [
      {
        className: "SandboxDO",
        applicationNameSuffix: "sandboxdo",
        image: `docker.io/jamieatlason/tiller-sandbox@sha256:${"c".repeat(64)}`,
        instanceType: "standard-1",
        maxInstances: 30,
      },
      {
        className: "GitHubJobDO",
        applicationNameSuffix: "githubjobdo",
        image: `docker.io/jamieatlason/tiller-scm@sha256:${"d".repeat(64)}`,
        instanceType: "basic",
        maxInstances: 4,
      },
      {
        className: "PlannerRunDO",
        applicationNameSuffix: "plannerrundo",
        image: `docker.io/jamieatlason/tiller-sandbox@sha256:${"c".repeat(64)}`,
        instanceType: "standard-1",
        maxInstances: 10,
      },
      {
        className: "CodexAuthDO",
        applicationNameSuffix: "codexauthdo",
        image: `docker.io/jamieatlason/tiller-sandbox@sha256:${"c".repeat(64)}`,
        instanceType: "basic",
        maxInstances: 1,
      },
    ],
  };
}
