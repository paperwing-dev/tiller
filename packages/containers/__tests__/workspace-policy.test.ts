import { describe, expect, it } from "vitest";
import { isExcluded } from "../workspace-policy.mjs";

describe("workspace runtime policy", () => {
  it("excludes only the exact root core dump file", () => {
    expect(isExcluded("/core")).toBe(true);
    expect(isExcluded("/core/trace.txt")).toBe(false);
    expect(isExcluded("/src/core/index.ts")).toBe(false);
    expect(isExcluded("/packages/core-utils/index.ts")).toBe(false);
  });

  it("excludes only the exact workspace-local Claude settings file", () => {
    expect(isExcluded("/.claude/settings.local.json")).toBe(true);
    expect(isExcluded("/src/.claude/settings.local.json")).toBe(false);
    expect(isExcluded("/.claude/settings.json")).toBe(false);
  });

  it("still excludes generated directories anywhere in the tree", () => {
    expect(isExcluded("/node_modules/left-pad/index.js")).toBe(true);
    expect(isExcluded("/packages/app/node_modules/left-pad/index.js")).toBe(true);
    expect(isExcluded("/packages/app/dist/bundle.js")).toBe(true);
  });
});
