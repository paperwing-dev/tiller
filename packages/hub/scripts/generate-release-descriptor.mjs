import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  INSTALLER_RUNTIME_BINDINGS,
  isV1ContainerImage,
  parseReleaseDescriptor,
} from "../../installer/src/release-contract.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");
const DEFAULT_CONFIG_PATH = path.join(packageRoot, "dist", "tiller", "wrangler.json");
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const SHA40 = /^[0-9a-f]{40}$/;
const SUPPORTED_CONTAINER_KEYS = new Set([
  "class_name",
  "name",
  "image",
  "instance_type",
  "max_instances",
]);

export { INSTALLER_RUNTIME_BINDINGS };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function containerImage(configContainer, args) {
  if (configContainer.class_name === "GitHubJobDO") return args.scmImage;
  if (configContainer.class_name === "SandboxDO" || configContainer.class_name === "PlannerRunDO" || configContainer.class_name === "CodexAuthDO") {
    return args.sandboxImage;
  }
  return configContainer.image;
}

function applicationSuffix(config, container) {
  const prefix = `${config.name}-`;
  assert(typeof container.name === "string" && container.name.startsWith(prefix),
    `Container ${container.class_name} is missing its generated application name`);
  const suffix = container.name.slice(prefix.length);
  assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(suffix),
    `Container ${container.class_name} has an invalid application suffix`);
  return suffix;
}

function buildContainers(config, args) {
  return (config.containers ?? []).map((container) => {
    const unsupportedKeys = Object.keys(container)
      .filter((key) => !SUPPORTED_CONTAINER_KEYS.has(key))
      .sort();
    assert(unsupportedKeys.length === 0,
      `Container ${String(container.class_name)} has unsupported fixed-topology fields: ${unsupportedKeys.join(", ")}`);
    assert(typeof container.class_name === "string" && container.class_name,
      "Container class_name is required");
    const image = containerImage(container, args);
    assert(isV1ContainerImage(image),
      `Container ${container.class_name} image must be hosted at docker.io and pinned by sha256 digest, not ${String(image)}`);
    assert(Number.isSafeInteger(container.max_instances) && container.max_instances > 0,
      `Container ${container.class_name} max_instances is invalid`);
    assert(typeof container.instance_type === "string" && container.instance_type,
      `Container ${container.class_name} instance_type is required`);
    return {
      className: container.class_name,
      applicationNameSuffix: applicationSuffix(config, container),
      image,
      instanceType: container.instance_type,
      maxInstances: container.max_instances,
    };
  });
}

function buildBindings(config) {
  const bindings = [];
  for (const binding of config.durable_objects?.bindings ?? []) {
    bindings.push({
      type: "durable_object_namespace",
      name: binding.name,
      className: binding.class_name,
    });
  }
  for (const binding of config.kv_namespaces ?? []) {
    assert(!binding.id && !binding.namespace_id,
      `Release config must not pin customer KV namespace ${binding.binding}`);
    bindings.push({ type: "kv_namespace", name: binding.binding, resourceSlot: "installation-kv" });
  }
  const r2Bindings = config.r2_buckets ?? [];
  if (r2Bindings.length === 0) {
    bindings.push({ type: "r2_bucket", name: "BUCKET", resourceSlot: "installation-r2" });
  } else {
    for (const binding of r2Bindings) {
      assert(!binding.bucket_name, `Release config must not pin customer R2 bucket ${binding.binding}`);
      bindings.push({ type: "r2_bucket", name: binding.binding, resourceSlot: "installation-r2" });
    }
  }
  if (config.ai?.binding) bindings.push({ type: "ai", name: config.ai.binding });
  if (config.assets?.binding) bindings.push({ type: "assets", name: config.assets.binding });
  for (const loader of config.worker_loaders ?? []) {
    bindings.push({ type: "worker_loader", name: loader.binding });
  }
  for (const [name, value] of Object.entries(config.vars ?? {})) {
    assert(name !== "TILLER_REGION" && name !== "DO_LOCATION_HINT",
      `${name} is forbidden in fixed-topology releases`);
    bindings.push({ type: "plain_text", name, text: String(value) });
  }
  bindings.push(...INSTALLER_RUNTIME_BINDINGS.map((binding) => ({ ...binding })));

  const names = bindings.map((binding) => binding.name);
  assert(new Set(names).size === names.length, "Release binding names must be unique");
  return bindings;
}

function buildExports(config) {
  assert(config.exports && typeof config.exports === "object" && !Array.isArray(config.exports),
    "Release config is missing the complete declarative exports map");
  const durableClasses = new Set((config.durable_objects?.bindings ?? []).map((binding) => binding.class_name));
  const exportClasses = Object.keys(config.exports);
  assert(durableClasses.size === exportClasses.length
    && exportClasses.every((className) => durableClasses.has(className)),
  "Every Durable Object binding must have exactly one export entry");

  return Object.fromEntries(exportClasses.sort().map((className) => {
    const entry = config.exports[className];
    assert(entry?.type === "durable-object" && entry.storage === "sqlite"
      && (entry.state === undefined || entry.state === "created")
      && Object.keys(entry).every((key) => ["type", "storage", "state"].includes(key)),
    `Export ${className} must be a live SQLite Durable Object`);
    return [className, {
      type: "durable-object",
      storage: "sqlite",
    }];
  }));
}

export async function buildReleaseDescriptor(args) {
  const releaseId = args.releaseId?.trim();
  assert(SHA40.test(releaseId) && !/^0{40}$/.test(releaseId),
    "releaseId must be a nonzero 40-character lowercase public snapshot SHA");
  const version = args.version?.trim();
  assert(version, "version is required");
  const bundlePath = path.resolve(args.bundlePath);
  const bundleStat = await stat(bundlePath);
  assert(bundleStat.isFile() && bundleStat.size > 0, "Release bundle must be a non-empty file");
  assert(bundleStat.size <= MAX_BUNDLE_BYTES,
    `Release bundle exceeds the ${MAX_BUNDLE_BYTES}-byte installer limit`);
  const bundleBytes = await readFile(bundlePath);
  const config = JSON.parse(await readFile(path.resolve(args.configPath ?? DEFAULT_CONFIG_PATH), "utf8"));
  assert(config.name === "tiller", "Release Worker name must remain fixed as tiller");
  assert(config.workers_dev !== false, "Release config must support the final workers.dev route");
  assert(config.preview_urls === false, "Release config must disable preview URLs");
  assert(!config.placement, "Release config must use default Cloudflare placement");
  assert(typeof config.observability?.enabled === "boolean"
    && typeof config.observability?.head_sampling_rate === "number"
    && Number.isFinite(config.observability.head_sampling_rate)
    && config.observability.head_sampling_rate >= 0
    && config.observability.head_sampling_rate <= 1,
  "Release config must declare complete observability settings");
  const containers = buildContainers(config, args);
  const exportsMap = buildExports(config);
  const uploadTemplate = {
    mainModule: config.main,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    observability: {
      enabled: config.observability.enabled,
      headSamplingRate: config.observability.head_sampling_rate,
    },
    assets: {
      notFoundHandling: config.assets?.not_found_handling ?? "none",
    },
    bindings: buildBindings(config),
    exports: exportsMap,
  };
  const descriptor = {
    schemaVersion: 1,
    releaseId,
    version,
    releaseNotesUrl: args.releaseNotesUrl
      ?? `https://github.com/paperwing-dev/tiller/releases/tag/tiller-hub-v${version}`,
    bundle: {
      url: args.bundleUrl,
      size: bundleStat.size,
      sha256: sha256(bundleBytes),
    },
    uploadTemplate,
    containers,
  };
  assert(new URL(descriptor.bundle.url).protocol === "https:", "bundleUrl must be HTTPS");
  return parseReleaseDescriptor(descriptor);
}
