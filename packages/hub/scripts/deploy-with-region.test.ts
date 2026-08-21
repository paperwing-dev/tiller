import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assessContainerApplicationReadiness,
  buildDeployConfig,
  deriveContainerApplicationName,
  deriveBucketName,
  needsLiveContainerImageLookup,
  normalizeWorkerName,
  parseDotEnv,
  parseJsonc,
  parseWranglerJsonOutput,
  resolveContainerImages,
  resolveWorkerName,
  rewriteContainerApplicationNames,
  waitForContainerApplications,
} from "./deploy-with-region.mjs";

describe("Hub region contract", () => {
  it("does not expose a customer region input in the fixed topology config", () => {
    const wrangler = parseJsonc(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      "wrangler.jsonc",
    );
    expect(wrangler.vars?.TILLER_REGION).toBeUndefined();

    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.cloudflare?.bindings?.TILLER_REGION).toBeUndefined();
  });

  it("keeps installer config on tiller and maintainer deploys on tiller-dev", () => {
    const wrangler = parseJsonc(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
      "wrangler.jsonc",
    );
    expect(wrangler.name).toBe("tiller");

    const deployScript = new URL("../../../scripts/deploy-dev.sh", import.meta.url);
    expect(existsSync(deployScript)).toBe(true);
    const deploySource = readFileSync(deployScript, "utf8");
    expect(deploySource).toContain('MAINTAINER_DEV_WORKER_NAME="tiller-dev"');
    expect(deploySource).toContain(
      'TILLER_WORKER_NAME="$MAINTAINER_DEV_WORKER_NAME"',
    );
  });

  it("keeps the regional deploy helper internal to the root development workflow", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.scripts?.deploy).toBeUndefined();
  });

  it("forces both maintainer bootstrap root deploy paths through deploy:dev --full", () => {
    const source = readFileSync(
      new URL("./maintainer-dev-bootstrap.ts", import.meta.url),
      "utf8",
    );
    expect(source.match(/\["run", "deploy:dev", "--", "--full"\]/g)).toHaveLength(2);
    expect(source).toContain('TILLER_DEV_ALLOW_UNTRUSTED_SEED: "1"');
    expect(source).not.toContain(["DEPLOY", "MODE"].join("_"));
    expect(source).not.toContain("maintainerDevReadyDeployEnvironment");
  });
});
describe("deriveBucketName", () => {
  it("creates a deterministic bucket name from the worker name", () => {
    expect(deriveBucketName("Paperwing Tiller Hub")).toBe(
      "paperwing-tiller-hub-r2-d272aa20",
    );
  });
});

describe("normalizeWorkerName", () => {
  it("accepts lowercase Worker names with hyphens", () => {
    expect(normalizeWorkerName("  tiller-hub-sage ")).toBe("tiller-hub-sage");
  });

  it("rejects names Wrangler cannot safely deploy", () => {
    expect(() => normalizeWorkerName("Tiller Hub")).toThrow(
      /lowercase letters/,
    );
    expect(() => normalizeWorkerName("-tiller-hub")).toThrow(
      /cannot start or end/,
    );
  });
});

describe("resolveWorkerName", () => {
  it("uses the Workers Builds override before local fallback values", () => {
    expect(
      resolveWorkerName(
        { name: "tiller-hub" },
        {
          WRANGLER_CI_OVERRIDE_NAME: "tiller-hub-maple",
          TILLER_WORKER_NAME: "tiller-hub-local",
        },
      ),
    ).toBe("tiller-hub-maple");
  });

  it("supports a local explicit Worker name override", () => {
    expect(
      resolveWorkerName(
        { name: "tiller-hub" },
        {
          TILLER_WORKER_NAME: "tiller-hub-river",
        },
      ),
    ).toBe("tiller-hub-river");
  });

  it("falls back to the root Wrangler name", () => {
    expect(resolveWorkerName({ name: "tiller-hub" }, {})).toBe("tiller-hub");
  });
});

describe("buildDeployConfig", () => {
  it.each(["tiller", "tiller-hub"])(
    "preserves public-fetch routing when deploying as %s",
    (workerName) => {
      const compatibilityFlags = [
        "nodejs_compat",
        "global_fetch_strictly_public",
      ];
      const config = buildDeployConfig(
        {
          name: "tiller",
          compatibility_flags: compatibilityFlags,
          vars: { TILLER_REGION: "wnam" },
        },
        {
          bucketName: `${workerName}-r2-12345678`,
          region: "wnam",
          workerName,
        },
      );

      expect(config.compatibility_flags).toEqual(compatibilityFlags);
    },
  );

  it("injects BUCKET while removing legacy placement inputs", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          SOME_OTHER_VAR: "keep-me",
        },
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
      },
    );

    expect(config.vars).toEqual({
      SOME_OTHER_VAR: "keep-me",
    });
    expect(config.r2_buckets).toEqual([
      {
        binding: "BUCKET",
        bucket_name: "tiller-hub-r2-12345678",
      },
    ]);
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
  });

  it("adds generated dev trust vars while preserving remote secrets", () => {
    const config = buildDeployConfig(
      { name: "tiller", vars: { SOME_OTHER_VAR: "keep-me" } },
      {
        bucketName: "tiller-dev-r2-12345678",
        workerName: "tiller-dev",
        runtimeVars: {
          TILLER_MAINTAINER_DEV_SCHEMA: "1",
          TILLER_INSTALLER_SCHEMA: "",
          TILLER_WORKERS_DEV_HOSTNAME:
            "tiller-dev.maintainer-preview.workers.dev",
        },
        placementRegion: "wnam",
        keepVars: true,
      },
    );

    expect(config.name).toBe("tiller-dev");
    expect(config.keep_vars).toBe(true);
    expect(config.vars).toMatchObject({
      SOME_OTHER_VAR: "keep-me",
      TILLER_MAINTAINER_DEV_SCHEMA: "1",
      TILLER_INSTALLER_SCHEMA: "",
      TILLER_WORKERS_DEV_HOSTNAME: "tiller-dev.maintainer-preview.workers.dev",
      DO_LOCATION_HINT: "wnam",
    });
    expect(config.vars).not.toHaveProperty("CF_ACCESS_SERVICE_CLIENT_SECRET");
  });

  it("materializes the checkpointed dev region into the binding and every Container", () => {
    const config = buildDeployConfig(
      {
        name: "tiller",
        vars: {},
        containers: [
          { class_name: "SandboxDO", image: "sandbox:sha", max_instances: 2 },
          { class_name: "GitHubJobDO", image: "scm:sha", max_instances: 4 },
        ],
      },
      {
        bucketName: "tiller-dev-r2-12345678",
        workerName: "tiller-dev",
        placementRegion: "wnam",
      },
    );

    expect(config.vars.DO_LOCATION_HINT).toBe("wnam");
    expect(config.containers).toEqual([
      expect.objectContaining({ constraints: { regions: ["WNAM"] } }),
      expect.objectContaining({ constraints: { regions: ["WNAM"] } }),
    ]);
  });

  it("derives the location hint only from the checkpointed placement region", () => {
    const regional = buildDeployConfig(
      { name: "tiller", vars: {} },
      {
        bucketName: "tiller-dev-r2-12345678",
        placementRegion: "wnam",
        runtimeVars: { DO_LOCATION_HINT: "enam" },
      },
    );
    expect(regional.vars.DO_LOCATION_HINT).toBe("wnam");

    const automatic = buildDeployConfig(
      { name: "tiller", vars: { DO_LOCATION_HINT: "wnam" } },
      {
        bucketName: "tiller-dev-r2-12345678",
        runtimeVars: { DO_LOCATION_HINT: "enam" },
      },
    );
    expect(automatic.vars).not.toHaveProperty("DO_LOCATION_HINT");
  });

  it("always emits a workers.dev deployment without direct custom-domain routing", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          HUB_PUBLIC_URL: "https://tiller.example.com",
          WORKER_SERVICE_NAME: "tiller-hub",
          WORKERS_DEV_ALIAS_DISABLED: "false",
        },
        routes: [{ pattern: "tiller.example.com", custom_domain: true }],
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub",
      },
    );

    expect(config.vars).toEqual({});
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toBeUndefined();
  });

  it("can rewrite the generated config to the selected Worker name", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: {
          TILLER_REGION: "wnam",
          TILLER_WORKER_NAME: "tiller-hub-ignore-runtime",
        },
      },
      {
        bucketName: "tiller-hub-river-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub-river",
      },
    );

    expect(config.name).toBe("tiller-hub-river");
    expect(config.vars).toEqual({});
  });

  it("rewrites generated container application names to the selected Worker name", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: { TILLER_REGION: "wnam" },
        containers: [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
        ],
      },
      {
        bucketName: "tiller-hub-river-r2-12345678",
        region: "wnam",
        workerName: "tiller-hub-river",
      },
    );

    expect(config.containers).toEqual([
      {
        class_name: "SandboxDO",
        name: "tiller-hub-river-sandboxdo",
        image: "docker.io/jamieatlason/tiller-sandbox:stable",
      },
    ]);
  });

  it("overrides the SandboxDO container image when CONTAINER_IMAGE_TAG is set", () => {
    const prev = process.env.CONTAINER_IMAGE_TAG;
    process.env.CONTAINER_IMAGE_TAG =
      "docker.io/jamieatlason/tiller-sandbox:abc123";
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            {
              class_name: "SandboxDO",
              image: "docker.io/jamieatlason/tiller-sandbox:stable",
              max_instances: 2,
            },
            {
              class_name: "PlannerRunDO",
              image: "docker.io/jamieatlason/tiller-sandbox:stable",
              max_instances: 10,
            },
            {
              class_name: "CodexAuthDO",
              image: "docker.io/jamieatlason/tiller-sandbox:stable",
              max_instances: 1,
            },
            {
              class_name: "GitHubJobDO",
              image: "docker.io/jamieatlason/tiller-scm:stable",
              max_instances: 4,
            },
            {
              class_name: "OtherDO",
              image: "docker.io/other/image:v1",
              max_instances: 1,
            },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        {
          class_name: "SandboxDO",
          image: "docker.io/jamieatlason/tiller-sandbox:abc123",
          max_instances: 2,
        },
        {
          class_name: "PlannerRunDO",
          image: "docker.io/jamieatlason/tiller-sandbox:abc123",
          max_instances: 10,
        },
        {
          class_name: "CodexAuthDO",
          image: "docker.io/jamieatlason/tiller-sandbox:abc123",
          max_instances: 1,
        },
        {
          class_name: "GitHubJobDO",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 4,
        },
        {
          class_name: "OtherDO",
          image: "docker.io/other/image:v1",
          max_instances: 1,
        },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
    }
  });

  it("overrides the GitHubJobDO image when GITHUB_JOB_IMAGE_TAG is set", () => {
    const prev = process.env.GITHUB_JOB_IMAGE_TAG;
    process.env.GITHUB_JOB_IMAGE_TAG =
      "docker.io/jamieatlason/tiller-scm:def456";
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            {
              class_name: "SandboxDO",
              image: "docker.io/jamieatlason/tiller-sandbox:stable",
              max_instances: 2,
            },
            {
              class_name: "GitHubJobDO",
              image: "docker.io/jamieatlason/tiller-scm:stable",
              max_instances: 4,
            },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        {
          class_name: "SandboxDO",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 2,
        },
        {
          class_name: "GitHubJobDO",
          image: "docker.io/jamieatlason/tiller-scm:def456",
          max_instances: 4,
        },
      ]);
    } finally {
      if (prev == null) delete process.env.GITHUB_JOB_IMAGE_TAG;
      else process.env.GITHUB_JOB_IMAGE_TAG = prev;
    }
  });

  it("leaves containers unchanged when image override env vars are not set", () => {
    const prev = process.env.CONTAINER_IMAGE_TAG;
    const prevGitHubJob = process.env.GITHUB_JOB_IMAGE_TAG;
    delete process.env.CONTAINER_IMAGE_TAG;
    delete process.env.GITHUB_JOB_IMAGE_TAG;
    try {
      const config = buildDeployConfig(
        {
          name: "tiller-hub",
          vars: { TILLER_REGION: "wnam" },
          containers: [
            {
              class_name: "SandboxDO",
              image: "docker.io/jamieatlason/tiller-sandbox:stable",
              max_instances: 2,
            },
            {
              class_name: "GitHubJobDO",
              image: "docker.io/jamieatlason/tiller-scm:stable",
              max_instances: 4,
            },
          ],
        },
        { bucketName: "tiller-hub-r2-12345678", region: "wnam" },
      );
      expect(config.containers).toEqual([
        {
          class_name: "SandboxDO",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 2,
        },
        {
          class_name: "GitHubJobDO",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 4,
        },
      ]);
    } finally {
      if (prev == null) delete process.env.CONTAINER_IMAGE_TAG;
      else process.env.CONTAINER_IMAGE_TAG = prev;
      if (prevGitHubJob == null) delete process.env.GITHUB_JOB_IMAGE_TAG;
      else process.env.GITHUB_JOB_IMAGE_TAG = prevGitHubJob;
    }
  });

  it("preserves live container images when provided", () => {
    const config = buildDeployConfig(
      {
        name: "tiller-hub",
        vars: { TILLER_REGION: "wnam" },
        containers: [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
            max_instances: 2,
          },
          {
            class_name: "GitHubJobDO",
            name: "tiller-hub-githubjobdo",
            image: "docker.io/jamieatlason/tiller-scm:stable",
            max_instances: 4,
          },
        ],
      },
      {
        bucketName: "tiller-hub-r2-12345678",
        region: "wnam",
        liveContainerImages: new Map([
          [
            "tiller-hub-sandboxdo",
            "docker.io/jamieatlason/tiller-sandbox:abc123",
          ],
          [
            "tiller-hub-githubjobdo",
            "docker.io/jamieatlason/tiller-scm:def456",
          ],
        ]),
      },
    );

    expect(config.containers).toEqual([
      {
        class_name: "SandboxDO",
        name: "tiller-hub-sandboxdo",
        image: "docker.io/jamieatlason/tiller-sandbox:abc123",
        max_instances: 2,
      },
      {
        class_name: "GitHubJobDO",
        name: "tiller-hub-githubjobdo",
        image: "docker.io/jamieatlason/tiller-scm:def456",
        max_instances: 4,
      },
    ]);
  });
});

describe("rewriteContainerApplicationNames", () => {
  it("derives names from class names", () => {
    expect(
      deriveContainerApplicationName("tiller-hub-maple", "SandboxDO"),
    ).toBe("tiller-hub-maple-sandboxdo");
  });

  it("preserves custom container names", () => {
    expect(
      rewriteContainerApplicationNames(
        [
          {
            class_name: "SandboxDO",
            name: "custom-sandbox",
            image: "docker.io/example/sandbox:stable",
          },
        ],
        {
          workerName: "tiller-hub-maple",
          previousWorkerName: "tiller-hub",
        },
      ),
    ).toEqual([
      {
        class_name: "SandboxDO",
        name: "custom-sandbox",
        image: "docker.io/example/sandbox:stable",
      },
    ]);
  });
});

describe("Container deployment readiness", () => {
  const containers = [
    {
      class_name: "SandboxDO",
      name: "tiller-dev-sandboxdo",
      image: "docker.io/example/sandbox:new",
    },
    {
      class_name: "GitHubJobDO",
      name: "tiller-dev-githubjobdo",
      image: "docker.io/example/scm:new",
    },
  ];

  it("requires every exact target image to reach a serving state", () => {
    expect(
      assessContainerApplicationReadiness(
        [
          {
            name: "tiller-dev-sandboxdo",
            image: "docker.io/example/sandbox:new",
            state: "active",
          },
          {
            name: "tiller-dev-githubjobdo",
            configuration: { image: "docker.io/example/scm:new" },
            state: "ready",
          },
        ],
        containers,
      ),
    ).toEqual({ ready: true, pending: [], failed: [] });
  });

  it("prefers authoritative detail configuration over stale list image data", () => {
    expect(
      assessContainerApplicationReadiness(
        [
          {
            name: "tiller-dev-sandboxdo",
            image: "docker.io/example/sandbox:old",
            configuration: { image: "docker.io/example/sandbox:new" },
            state: "ready",
          },
          {
            name: "tiller-dev-githubjobdo",
            image: "docker.io/example/scm:old",
            configuration: { image: "docker.io/example/scm:new" },
            state: "active",
          },
        ],
        containers,
      ).ready,
    ).toBe(true);
  });

  it("keeps old, missing, and provisioning applications pending", () => {
    const result = assessContainerApplicationReadiness(
      [
        {
          name: "tiller-dev-sandboxdo",
          image: "docker.io/example/sandbox:old",
          state: "ready",
        },
      ],
      containers,
    );

    expect(result.ready).toBe(false);
    expect(result.failed).toEqual([]);
    expect(result.pending).toEqual([
      expect.stringContaining("waiting for image"),
      "tiller-dev-githubjobdo: not visible yet",
    ]);

    expect(
      assessContainerApplicationReadiness(
        [
          {
            name: "tiller-dev-sandboxdo",
            image: "docker.io/example/sandbox:new",
            state: "provisioning",
          },
          {
            name: "tiller-dev-githubjobdo",
            image: "docker.io/example/scm:new",
            state: "ready",
          },
        ],
        containers,
      ).pending,
    ).toContain(
      "tiller-dev-sandboxdo: image is current; deployment state is provisioning",
    );
  });

  it("reports terminal and ambiguous application states as failures", () => {
    const result = assessContainerApplicationReadiness(
      [
        {
          name: "tiller-dev-sandboxdo",
          image: "docker.io/example/sandbox:new",
          state: "failed",
        },
        {
          name: "tiller-dev-githubjobdo",
          image: "docker.io/example/scm:new",
          state: "ready",
        },
        {
          name: "tiller-dev-githubjobdo",
          image: "docker.io/example/scm:new",
          state: "ready",
        },
      ],
      containers,
    );

    expect(result.ready).toBe(false);
    expect(result.failed).toEqual([
      "tiller-dev-sandboxdo: deployment state is failed",
      "tiller-dev-githubjobdo: Cloudflare returned 2 applications with this name",
    ]);
  });

  it("waits for two consecutive ready observations", async () => {
    const observations = [
      [
        {
          name: "tiller-dev-sandboxdo",
          image: "docker.io/example/sandbox:new",
          state: "provisioning",
        },
      ],
      [
        {
          name: "tiller-dev-sandboxdo",
          image: "docker.io/example/sandbox:new",
          state: "ready",
        },
      ],
      [
        {
          name: "tiller-dev-sandboxdo",
          image: "docker.io/example/sandbox:new",
          state: "active",
        },
      ],
    ];
    const singleContainer = [containers[0]];
    const sleeps = [];
    const logs = { log: vi.fn() };

    await waitForContainerApplications(singleContainer, {
      listApplications: vi.fn(async () => observations.shift()),
      sleep: vi.fn(async (ms) => {
        sleeps.push(ms);
      }),
      now: vi.fn(() => 0),
      pollIntervalMs: 17,
      requiredReadyConfirmations: 2,
      log: logs,
    });

    expect(sleeps).toEqual([17, 17]);
    expect(logs.log).toHaveBeenLastCalledWith(
      "All Container applications are running their expected images.",
    );
  });

  it("times out instead of accepting an old image in a ready application", async () => {
    let clock = 0;
    const oldApplication = [
      {
        name: "tiller-dev-sandboxdo",
        image: "docker.io/example/sandbox:old",
        state: "ready",
      },
    ];

    await expect(
      waitForContainerApplications([containers[0]], {
        listApplications: vi.fn(async () => oldApplication),
        sleep: vi.fn(async (ms) => {
          clock += ms;
        }),
        now: () => clock,
        timeoutMs: 20,
        pollIntervalMs: 10,
        log: { log: vi.fn() },
      }),
    ).rejects.toThrow(
      /Timed out waiting for Container rollouts.*currently docker\.io\/example\/sandbox:old/,
    );
  });
});

describe("resolveContainerImages", () => {
  const containers = [
    {
      class_name: "SandboxDO",
      name: "tiller-hub-sandboxdo",
      image: "docker.io/jamieatlason/tiller-sandbox:stable",
      max_instances: 2,
    },
    {
      class_name: "PlannerRunDO",
      name: "tiller-hub-plannerrundo",
      image: "docker.io/jamieatlason/tiller-sandbox:stable",
      max_instances: 10,
    },
    {
      class_name: "GitHubJobDO",
      name: "tiller-hub-githubjobdo",
      image: "docker.io/jamieatlason/tiller-scm:stable",
      max_instances: 4,
    },
  ];

  it("uses explicit overrides ahead of live images", () => {
    const resolutions = resolveContainerImages(containers, {
      sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:override",
      githubJobImageTag: "docker.io/jamieatlason/tiller-scm:override",
      liveContainerImages: new Map([
        ["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:live"],
        [
          "tiller-hub-plannerrundo",
          "docker.io/jamieatlason/tiller-sandbox:live",
        ],
        ["tiller-hub-githubjobdo", "docker.io/jamieatlason/tiller-scm:live"],
      ]),
    });

    expect(resolutions).toEqual([
      {
        container: {
          class_name: "SandboxDO",
          name: "tiller-hub-sandboxdo",
          image: "docker.io/jamieatlason/tiller-sandbox:override",
          max_instances: 2,
        },
        source: "override",
      },
      {
        container: {
          class_name: "PlannerRunDO",
          name: "tiller-hub-plannerrundo",
          image: "docker.io/jamieatlason/tiller-sandbox:override",
          max_instances: 10,
        },
        source: "override",
      },
      {
        container: {
          class_name: "GitHubJobDO",
          name: "tiller-hub-githubjobdo",
          image: "docker.io/jamieatlason/tiller-scm:override",
          max_instances: 4,
        },
        source: "override",
      },
    ]);
  });

  it("falls back to the config image when no live image matches", () => {
    const resolutions = resolveContainerImages(containers, {
      liveContainerImages: new Map([
        ["tiller-hub-sandboxdo", "docker.io/jamieatlason/tiller-sandbox:live"],
      ]),
    });

    expect(resolutions).toEqual([
      {
        container: {
          class_name: "SandboxDO",
          name: "tiller-hub-sandboxdo",
          image: "docker.io/jamieatlason/tiller-sandbox:live",
          max_instances: 2,
        },
        source: "live",
      },
      {
        container: {
          class_name: "PlannerRunDO",
          name: "tiller-hub-plannerrundo",
          image: "docker.io/jamieatlason/tiller-sandbox:stable",
          max_instances: 10,
        },
        source: "default",
      },
      {
        container: {
          class_name: "GitHubJobDO",
          name: "tiller-hub-githubjobdo",
          image: "docker.io/jamieatlason/tiller-scm:stable",
          max_instances: 4,
        },
        source: "default",
      },
    ]);
  });
});

describe("needsLiveContainerImageLookup", () => {
  it("only requires live lookup for unpinned known containers", () => {
    expect(
      needsLiveContainerImageLookup(
        [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
          {
            class_name: "PlannerRunDO",
            name: "tiller-hub-plannerrundo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
          {
            class_name: "GitHubJobDO",
            name: "tiller-hub-githubjobdo",
            image: "docker.io/jamieatlason/tiller-scm:stable",
          },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          githubJobImageTag: "",
        },
      ),
    ).toBe(true);

    expect(
      needsLiveContainerImageLookup(
        [
          {
            class_name: "SandboxDO",
            name: "tiller-hub-sandboxdo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
          {
            class_name: "PlannerRunDO",
            name: "tiller-hub-plannerrundo",
            image: "docker.io/jamieatlason/tiller-sandbox:stable",
          },
          {
            class_name: "GitHubJobDO",
            name: "tiller-hub-githubjobdo",
            image: "docker.io/jamieatlason/tiller-scm:stable",
          },
        ],
        {
          sandboxImageTag: "docker.io/jamieatlason/tiller-sandbox:abc123",
          githubJobImageTag: "docker.io/jamieatlason/tiller-scm:def456",
        },
      ),
    ).toBe(false);
  });
});

describe("parseDotEnv", () => {
  it("parses basic .env content", () => {
    expect(
      parseDotEnv(
        "CLOUDFLARE_ACCOUNT_ID=account-123\nCONTAINER_IMAGE_TAG=image:sha\n",
      ),
    ).toEqual({
      CLOUDFLARE_ACCOUNT_ID: "account-123",
      CONTAINER_IMAGE_TAG: "image:sha",
    });
  });
});

describe("parseWranglerJsonOutput", () => {
  it("ignores Wrangler notices before JSON output", () => {
    expect(
      parseWranglerJsonOutput(
        'Cloudflare agent skills are available for: Claude Code, Cursor, Codex.\n{"location":"WNAM"}\n',
        "wrangler output",
      ),
    ).toEqual({ location: "WNAM" });
  });
});
