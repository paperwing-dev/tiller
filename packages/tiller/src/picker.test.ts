import { describe, expect, it } from "vitest";
import {
  authBadge,
  authDetailLabel,
  authLabel,
  envDisplayLabel,
  type EnvMeta,
} from "./picker.js";

function openCodeEnv(harnessPresentation?: EnvMeta["harnessPresentation"]): EnvMeta {
  return {
    slug: "legacy-env",
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    backend: "cf",
    harness: "opencode",
    ...(harnessPresentation ? { harnessPresentation } : {}),
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    status: "stopped",
  };
}

describe("OpenCode picker model presentation", () => {
  it("presents a committed Kimi model without reconstructing catalog data", () => {
    const env = openCodeEnv({
      modelLabel: "Kimi K2.7 Code",
      credentialRequirement: "workers-ai",
      providerKind: "cloudflare-workers-ai",
      providerLabel: "Tiller Hub",
    });
    expect(authBadge(env)).toContain("workers ai");
    expect(authDetailLabel(env)).toBe("Tiller Hub · Kimi K2.7 Code");
  });

  it("presents committed GPT models as OpenAI-backed", () => {
    const env = openCodeEnv({
      modelLabel: "GPT-5.5",
      credentialRequirement: "openai-api-key",
      providerKind: "openai",
      providerLabel: "OpenAI",
    });
    expect(authBadge(env)).toContain("openai api key");
    expect(authLabel(env)).toBe("openai api key");
    expect(authDetailLabel(env)).toBe("OpenAI · GPT-5.5");
  });

  it("uses the exact projected label for future models", () => {
    const env = openCodeEnv({
      modelLabel: "Sol Preview",
      credentialRequirement: "openai-api-key",
      providerKind: "openai",
      providerLabel: "OpenAI",
    });
    expect(authDetailLabel(env)).toBe("OpenAI · Sol Preview");
  });

  it("omits OpenCode presentation for older hubs instead of inferring from legacy metadata", () => {
    const env = openCodeEnv() as EnvMeta & {
      opencodeProvider: string;
      opencodeModel: string;
      harnessSettings: { model: string; effort: string };
    };
    env.opencodeProvider = "cloudflare-workers-ai";
    env.opencodeModel = "@cf/moonshotai/kimi-k2.5";
    env.harnessSettings = { model: "kimi-k2.7-code", effort: "high" };

    expect(authLabel(env)).toBeNull();
    expect(authBadge(env)).toBe("");
    expect(authDetailLabel(env)).toBeNull();
  });
});

describe("environment picker display labels", () => {
  it("strips unsafe controls and includes the authoritative slug when requested", () => {
    const env = openCodeEnv();
    env.displayName = "  \u001B[31mImplement\nsettings\u200B  ";

    expect(envDisplayLabel(env)).toBe("[31mImplement settings");
    expect(envDisplayLabel(env, true)).toBe("[31mImplement settings (slug: legacy-env)");
    expect(env.slug).toBe("legacy-env");
  });

  it("falls back to the slug for missing or empty display names", () => {
    expect(envDisplayLabel(openCodeEnv(), true)).toBe("legacy-env");
    expect(envDisplayLabel({ ...openCodeEnv(), displayName: "\u0000\u200B" }, true))
      .toBe("legacy-env");
  });

  it("limits untrusted labels by Unicode code point", () => {
    const env = openCodeEnv();
    env.displayName = `${"😀".repeat(80)}x`;

    expect(envDisplayLabel(env)).toBe(`${"😀".repeat(79)}…`);
    expect(Array.from(envDisplayLabel(env))).toHaveLength(80);
  });
});
