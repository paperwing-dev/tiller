import { describe, expect, it } from "vitest";
import { resolveDescriptorInput } from "../scripts/generate-stable-release.mjs";

describe("Installer release build input", () => {
  it("requires an explicit descriptor for production deployment", () => {
    expect(() =>
      resolveDescriptorInput({ development: false, sourcePath: undefined }),
    ).toThrow("Production Installer deployment requires");
    expect(
      resolveDescriptorInput({
        development: false,
        sourcePath: " /tmp/release-descriptor.json ",
      }),
    ).toBe("/tmp/release-descriptor.json");
  });

  it("keeps development fixture generation explicit and isolated", () => {
    expect(
      resolveDescriptorInput({ development: true, sourcePath: undefined }),
    ).toBeNull();
    expect(() =>
      resolveDescriptorInput({
        development: true,
        sourcePath: "/tmp/release-descriptor.json",
      }),
    ).toThrow("cannot also use");
  });
});
