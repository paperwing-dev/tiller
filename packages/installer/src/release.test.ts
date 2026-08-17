import { describe, expect, it } from "vitest";
import {
  INSTALLER_BINDING_NAMES,
  INSTALLER_RUNTIME_BINDING_SCHEMA,
  INSTALLER_RUNTIME_BINDINGS,
  isV1ContainerImage,
  installerRuntimeBindingKey,
  parseReleaseDescriptor,
} from "./release";
import { productionReleaseDescriptorFixture, releaseDescriptorFixture } from "./release-fixture";

const stableJson = productionReleaseDescriptorFixture();

describe("fresh ReleaseDescriptorV1", () => {
  it("derives the reduced runtime bindings from one schema", () => {
    expect(INSTALLER_RUNTIME_BINDINGS).toEqual(Object.values(INSTALLER_RUNTIME_BINDING_SCHEMA));
    for (const [key, binding] of Object.entries(INSTALLER_RUNTIME_BINDING_SCHEMA)) {
      expect(INSTALLER_BINDING_NAMES[key as keyof typeof INSTALLER_BINDING_NAMES]).toBe(binding.name);
      expect(installerRuntimeBindingKey(binding.runtimeSlot)).toBe(key);
    }
    const serialized = JSON.stringify(INSTALLER_RUNTIME_BINDINGS);
    expect(serialized).not.toContain("TILLER_MAINTAINER_DEV_SCHEMA");
    expect(JSON.stringify(stableJson)).not.toContain("TILLER_MAINTAINER_DEV_SCHEMA");
    expect(JSON.stringify(stableJson)).not.toContain("tiller-dev.");
    for (const removed of ["PHASE", "OPERATION", "TOPOLOGY", "MANIFEST", "ATTESTATION"]) {
      expect(serialized).not.toContain(removed);
    }
  });

  it("accepts the embedded install descriptor without a topology fingerprint", () => {
    const descriptor = parseReleaseDescriptor(stableJson);
    expect(descriptor).not.toHaveProperty("topologyFingerprint");
    expect(descriptor.uploadTemplate.exports.GitHubJobDO).not.toHaveProperty("container");
    expect(Object.keys(descriptor).sort()).toEqual([
      "bundle", "containers", "releaseId", "releaseNotesUrl", "schemaVersion", "uploadTemplate", "version",
    ]);
  });

  it("uses one v1 Container image policy across parsing and release tooling", () => {
    expect(isV1ContainerImage(`docker.io/example/tiller@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isV1ContainerImage(`registry.example/tiller@sha256:${"a".repeat(64)}`)).toBe(false);
    expect(isV1ContainerImage("docker.io/example/tiller:latest")).toBe(false);
    expect(isV1ContainerImage(null)).toBe(false);
  });

  it("rejects unknown fields, floating images, and invalid container topology", () => {
    const fixture = releaseDescriptorFixture();
    expect(() => parseReleaseDescriptor({ ...structuredClone(fixture), historical: [] }))
      .toThrow(/unsupported shape/);
    const value = structuredClone(fixture) as Record<string, any>;
    value.containers[0].image = "registry.example/tiller:latest";
    expect(() => parseReleaseDescriptor(value)).toThrow(/digest-pinned/);
    value.containers[0].image = `docker.io/example/tiller@sha256:${"a".repeat(64)}`;
    value.containers[0].className = "MissingDO";
    expect(() => parseReleaseDescriptor(value)).toThrow(/missing from Durable Object exports/);
    value.containers[0].className = "SandboxDO";
    value.containers[0].applicationNameSuffix = "a".repeat(65);
    expect(() => parseReleaseDescriptor(value)).toThrow(/applicationNameSuffix|suffix is invalid/);

    value.containers[0].applicationNameSuffix = "sandbox";
    value.uploadTemplate.exports.SandboxDO.container = "ForeignDO";
    expect(() => parseReleaseDescriptor(value)).toThrow(/legacy Container association/);

    const unsupportedProfile = structuredClone(fixture);
    unsupportedProfile.containers[0].instanceType = "lite";
    expect(() => parseReleaseDescriptor(unsupportedProfile)).toThrow(/instanceType is unsupported/);

    const alternateRegistry = structuredClone(fixture);
    alternateRegistry.containers[0].image = `registry.example/tiller@sha256:${"a".repeat(64)}`;
    expect(() => parseReleaseDescriptor(alternateRegistry)).toThrow(/hosted at exactly docker\.io/);

    const unrelatedLegacyMarker = structuredClone(fixture) as unknown as {
      uploadTemplate: { bindings: unknown[]; exports: Record<string, unknown> };
    };
    unrelatedLegacyMarker.uploadTemplate.bindings.push({
      type: "durable_object_namespace",
      name: "OTHER",
      className: "OtherDO",
    });
    unrelatedLegacyMarker.uploadTemplate.exports.OtherDO = {
      type: "durable-object",
      storage: "sqlite",
      container: "OtherDO",
    };
    expect(() => parseReleaseDescriptor(unrelatedLegacyMarker)).toThrow(/invalid legacy Container association/);
  });
});
