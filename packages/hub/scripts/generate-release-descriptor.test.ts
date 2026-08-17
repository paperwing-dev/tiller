import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildReleaseDescriptor,
  INSTALLER_RUNTIME_BINDINGS,
} from "./generate-release-descriptor.mjs";

const RELEASE_ID = "a".repeat(40);
const DIGEST_ONE = "1".repeat(64);

function releaseConfig() {
  return {
    name: "tiller",
    main: "index.js",
    compatibility_date: "2025-01-29",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: true, head_sampling_rate: 1 },
    assets: {
      binding: "ASSETS",
      not_found_handling: "single-page-application",
    },
    ai: { binding: "AI" },
    worker_loaders: [{ binding: "LOADER" }],
    vars: { ENABLED_ENV_HARNESSES: "claude-code,codex,opencode" },
    kv_namespaces: [{ binding: "ENVS_KV" }],
    r2_buckets: [{ binding: "BUCKET" }],
    durable_objects: {
      bindings: [
        { name: "HUB", class_name: "HubDO" },
        { name: "SANDBOX", class_name: "SandboxDO" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["HubDO"] }],
    exports: {
      HubDO: { type: "durable-object", storage: "sqlite" },
      SandboxDO: { type: "durable-object", storage: "sqlite" },
    },
    containers: [{
      class_name: "SandboxDO",
      name: "tiller-sandboxdo",
      image: "ignored-by-release-generator",
      instance_type: "standard-1",
      max_instances: 2,
    }],
  };
}

describe("ReleaseDescriptorV1 generator", () => {
  let directory: string;
  let configPath: string;
  let bundlePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tiller-release-descriptor-"));
    configPath = path.join(directory, "wrangler.json");
    bundlePath = path.join(directory, "tiller.tar.gz");
    await Promise.all([
      writeFile(configPath, JSON.stringify(releaseConfig())),
      writeFile(bundlePath, "immutable release bundle"),
    ]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function args(overrides: Record<string, unknown> = {}) {
    return {
      releaseId: RELEASE_ID,
      version: "0.3.0",
      configPath,
      bundlePath,
      bundleUrl: "https://github.com/paperwing-dev/tiller/releases/download/v0.3.0/tiller.tar.gz",
      sandboxImage: `docker.io/example/tiller-sandbox@sha256:${DIGEST_ONE}`,
      scmImage: `docker.io/example/tiller-scm@sha256:${DIGEST_ONE}`,
      ...overrides,
    };
  }

  it("emits a complete typed upload template and verified bundle identity", async () => {
    const descriptor = await buildReleaseDescriptor(args());

    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      releaseId: RELEASE_ID,
      version: "0.3.0",
      releaseNotesUrl: "https://github.com/paperwing-dev/tiller/releases/tag/tiller-hub-v0.3.0",
      uploadTemplate: {
        mainModule: "index.js",
        observability: { enabled: true, headSamplingRate: 1 },
        exports: {
          HubDO: { type: "durable-object", storage: "sqlite" },
          SandboxDO: { type: "durable-object", storage: "sqlite" },
        },
      },
      containers: [{
        className: "SandboxDO",
        applicationNameSuffix: "sandboxdo",
        image: `docker.io/example/tiller-sandbox@sha256:${DIGEST_ONE}`,
        instanceType: "standard-1",
        maxInstances: 2,
      }],
    });
    expect(descriptor.bundle.size).toBe(Buffer.byteLength("immutable release bundle"));
    expect(descriptor.bundle.sha256).toBe(createHash("sha256").update("immutable release bundle").digest("hex"));
    expect(descriptor.uploadTemplate).not.toHaveProperty("migrations");
    expect(descriptor.uploadTemplate.bindings.map((binding) => binding.name)).toEqual(expect.arrayContaining([
      "HUB",
      "SANDBOX",
      "ENVS_KV",
      "BUCKET",
      "AI",
      "ASSETS",
      "LOADER",
      ...INSTALLER_RUNTIME_BINDINGS.map((binding) => binding.name),
    ]));
  });

  it("rejects incomplete exports and floating Container images", async () => {
    await expect(buildReleaseDescriptor(args({ releaseId: "0".repeat(40) })))
      .rejects.toThrow(/nonzero 40-character/);

    const incomplete = releaseConfig();
    delete (incomplete.exports as Partial<typeof incomplete.exports>).HubDO;
    await writeFile(configPath, JSON.stringify(incomplete));
    await expect(buildReleaseDescriptor(args())).rejects.toThrow(/Every Durable Object binding/);

    await writeFile(configPath, JSON.stringify(releaseConfig()));
    await expect(buildReleaseDescriptor(args({ sandboxImage: "docker.io/example/tiller:latest" })))
      .rejects.toThrow(/pinned by sha256 digest/);
    await expect(buildReleaseDescriptor(args({
      sandboxImage: `registry.example/tiller@sha256:${DIGEST_ONE}`,
    }))).rejects.toThrow(/hosted at docker\.io/);
  });

  it("maps CodexAuthDO to the pinned sandbox image and singleton topology", async () => {
    const config = releaseConfig();
    config.durable_objects.bindings.push({ name: "CODEX_AUTH", class_name: "CodexAuthDO" });
    (config.exports as Record<string, { type: string; storage: string }>).CodexAuthDO = {
      type: "durable-object",
      storage: "sqlite",
    };
    config.containers.push({
      class_name: "CodexAuthDO",
      name: "tiller-codexauthdo",
      image: "ignored-by-release-generator",
      instance_type: "basic",
      max_instances: 1,
    });
    await writeFile(configPath, JSON.stringify(config));

    const descriptor = await buildReleaseDescriptor(args());

    expect(descriptor.containers).toContainEqual({
      className: "CodexAuthDO",
      applicationNameSuffix: "codexauthdo",
      image: `docker.io/example/tiller-sandbox@sha256:${DIGEST_ONE}`,
      instanceType: "basic",
      maxInstances: 1,
    });
  });

  it("rejects every Container topology field the fixed descriptor cannot represent", async () => {
    const unsupported = {
      constraints: { regions: ["WNAM"] },
      affinities: { colocation: "regional" },
      rollout_active_grace_period: 30,
      custom_instance_type: { memory_mb: 1024 },
      ssh_public_key: "ssh-ed25519 example",
      observability: { logs: { enabled: true } },
    };

    for (const [field, value] of Object.entries(unsupported)) {
      const config = releaseConfig();
      Object.assign(config.containers[0], { [field]: value });
      await writeFile(configPath, JSON.stringify(config));
      await expect(buildReleaseDescriptor(args())).rejects.toThrow(
        new RegExp(`unsupported fixed-topology fields: ${field}`),
      );
    }
  });

});
