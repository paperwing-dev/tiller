import { describe, expect, it } from "vitest";
import type { TillerConfig } from "../src/config";
import { buildSavedConfig } from "../src/init";

describe("buildSavedConfig", () => {
  it("preserves extra config keys when updating saved config", () => {
    const existing = {
      hubUrl: "https://old.example.com",
      localRunnerImage: "docker.io/example/tiller:stable",
      ["themePreference"]: "dark",
    } as TillerConfig & Record<string, unknown>;

    const next = buildSavedConfig(existing, {
      hubUrl: "https://new.example.com",
      publicHub: false,
      localRunnerImage: "docker.io/example/tiller:next",
    }) as TillerConfig & Record<string, unknown>;

    expect(next.hubUrl).toBe("https://new.example.com");
    expect(next.localRunnerImage).toBe("docker.io/example/tiller:next");
    expect(next["themePreference"]).toBe("dark");
  });
});
