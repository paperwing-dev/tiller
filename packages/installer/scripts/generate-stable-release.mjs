import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseReleaseDescriptor } from "../src/release-contract.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputPath = path.join(packageRoot, "stable-release.generated.json");

function developmentFixture() {
  return {
    schemaVersion: 1,
    releaseId: "0".repeat(40),
    version: "0.0.0-development",
    releaseNotesUrl: "https://github.com/paperwing-dev/tiller",
    bundle: {
      url: "https://github.com/paperwing-dev/tiller/releases/download/development/tiller-hub-development.tar.gz",
      size: 1,
      sha256: "0".repeat(64),
    },
    uploadTemplate: {
      mainModule: "index.js",
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      observability: { enabled: false, headSamplingRate: 0 },
      assets: { notFoundHandling: "single-page-application" },
      bindings: [
        {
          type: "durable_object_namespace",
          name: "SANDBOX",
          className: "SandboxDO",
        },
      ],
      exports: { SandboxDO: { type: "durable-object", storage: "sqlite" } },
    },
    containers: [
      {
        className: "SandboxDO",
        applicationNameSuffix: "sandbox",
        image: `docker.io/jamieatlason/tiller-sandbox@sha256:${"0".repeat(64)}`,
        instanceType: "basic",
        maxInstances: 1,
      },
    ],
  };
}

export function resolveDescriptorInput({ development, sourcePath }) {
  const normalizedSource = String(sourcePath ?? "").trim();
  if (development && normalizedSource) {
    throw new Error(
      "Development Installer input cannot also use TILLER_INSTALLER_DESCRIPTOR_PATH.",
    );
  }
  if (!development && !normalizedSource) {
    throw new Error(
      "Production Installer deployment requires TILLER_INSTALLER_DESCRIPTOR_PATH.",
    );
  }
  return normalizedSource || null;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const development = argumentsList.includes("--development");
  if (argumentsList.some((argument) => argument !== "--development")) {
    throw new Error(
      "Usage: node scripts/generate-stable-release.mjs [--development]",
    );
  }
  const sourcePath = resolveDescriptorInput({
    development,
    sourcePath: process.env.TILLER_INSTALLER_DESCRIPTOR_PATH,
  });
  const descriptor = parseReleaseDescriptor(
    sourcePath
      ? JSON.parse(await readFile(path.resolve(sourcePath), "utf8"))
      : developmentFixture(),
  );
  await writeFile(outputPath, `${JSON.stringify(descriptor, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
