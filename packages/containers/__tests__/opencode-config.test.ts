import { describe, expect, it } from "vitest";
import { HARNESS_MODEL_CATALOG } from "../../hub/shared/harness-catalog";
import { renderOpenCodeConfig } from "../../harness/src/opencode-config";

type RenderedOpenCodeConfig = {
  agent: Record<string, { color?: string }>;
  enabled_providers: string[];
  provider: Record<
    string,
    {
      npm: string;
      name: string;
      options: {
        baseURL: string;
        apiKey: string;
        headers?: Record<string, string>;
      };
      models: Record<
        string,
        {
          id: string;
          name: string;
          limit: { context: number; input?: number; output: number };
          options:
            | { reasoningEffort: string }
            | {
                thinking: { type: "adaptive"; display: "summarized" };
                effort: string;
              };
        }
      >;
    }
  >;
  model: string;
  small_model: string;
};

const openCodeModels = HARNESS_MODEL_CATALOG.filter(
  (entry) => entry.harness === "opencode" && entry.binding.kind === "opencode",
);

describe("OpenCode runtime configuration", () => {
  it("uses the bundled compatible provider identifier", () => {
    const config = JSON.parse(
      renderOpenCodeConfig({
        TILLER_OPENCODE_PROVIDER_KIND: "openai",
        TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-openai",
        TILLER_OPENCODE_PROVIDER_LABEL: "OpenAI",
        TILLER_OPENCODE_BASE_URL: "https://api.openai.com/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "secret",
        TILLER_OPENCODE_MODEL_ID: "gpt-test",
        TILLER_OPENCODE_MODEL_ALIAS: "gpt-test",
        TILLER_OPENCODE_MODEL_LABEL: "GPT Test",
        TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "1000000",
        TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "128000",
        TILLER_OPENCODE_REASONING_EFFORT: "high",
      }),
    ) as RenderedOpenCodeConfig;

    expect(config.provider["tiller-openai"].npm).toBe(
      "@ai-sdk/openai-compatible",
    );
    expect(config.agent.build.color).toBe("secondary");
  });

  for (const entry of openCodeModels) {
    if (entry.binding.kind !== "opencode") continue;
    for (const effort of entry.efforts) {
      it(`renders only ${entry.id}/${effort} and its selected provider credentials`, () => {
        const providerTokens = {
          openai: "openai-secret",
          anthropic: "anthropic-secret",
          "cloudflare-workers-ai": "workers-secret",
        } as const;
        const selectedToken = providerTokens[entry.binding.provider];
        const config = JSON.parse(
          renderOpenCodeConfig({
            TILLER_OPENCODE_PROVIDER_KIND: entry.binding.provider,
            TILLER_OPENCODE_PROVIDER_ALIAS: entry.binding.providerAlias,
            TILLER_OPENCODE_PROVIDER_LABEL: entry.binding.providerLabel,
            TILLER_OPENCODE_BASE_URL:
              entry.binding.baseUrl ??
              "https://hub.example.com/api/opencode/v1",
            TILLER_OPENCODE_AUTH_TOKEN: selectedToken,
            TILLER_OPENCODE_MODEL_ID: entry.binding.model,
            TILLER_OPENCODE_MODEL_ALIAS: entry.binding.modelAlias,
            TILLER_OPENCODE_MODEL_LABEL: entry.label,
            TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: String(entry.limits.context),
            ...(entry.limits.input
              ? {
                  TILLER_OPENCODE_MODEL_INPUT_LIMIT: String(entry.limits.input),
                }
              : {}),
            TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: String(entry.limits.output),
            TILLER_OPENCODE_REASONING_EFFORT: effort,
            CF_ACCESS_CLIENT_ID: "cf-client-id",
            CF_ACCESS_CLIENT_SECRET: "cf-client-secret",
            OPENAI_API_KEY: "must-not-appear",
            ANTHROPIC_API_KEY: "must-not-appear",
          }),
        ) as RenderedOpenCodeConfig;

        expect(Object.keys(config.provider)).toEqual([
          entry.binding.providerAlias,
        ]);
        expect(config.enabled_providers).toEqual([entry.binding.providerAlias]);
        const provider = config.provider[entry.binding.providerAlias];
        expect(Object.keys(provider.models)).toEqual([
          entry.binding.modelAlias,
        ]);
        const expectedPackage =
          entry.binding.provider === "anthropic"
            ? "@ai-sdk/anthropic"
            : "@ai-sdk/openai-compatible";
        const expectedModelOptions =
          entry.binding.provider === "anthropic"
            ? {
                thinking: { type: "adaptive", display: "summarized" },
                effort,
              }
            : { reasoningEffort: effort };
        expect(provider).toMatchObject({
          npm: expectedPackage,
          name: entry.binding.providerLabel,
          options: {
            baseURL:
              entry.binding.baseUrl ??
              "https://hub.example.com/api/opencode/v1",
            apiKey: selectedToken,
          },
          models: {
            [entry.binding.modelAlias]: {
              id: entry.binding.model,
              name: entry.label,
              limit: entry.limits,
              options: expectedModelOptions,
            },
          },
        });
        expect(config.model).toBe(
          `${entry.binding.providerAlias}/${entry.binding.modelAlias}`,
        );
        expect(config.small_model).toBe(config.model);

        if (entry.binding.provider === "cloudflare-workers-ai") {
          expect(provider.options.headers).toEqual({
            "CF-Access-Client-Id": "cf-client-id",
            "CF-Access-Client-Secret": "cf-client-secret",
          });
        } else {
          expect(provider.options.headers).toBeUndefined();
        }

        const serialized = JSON.stringify(config);
        expect(serialized).not.toContain("must-not-appear");
        for (const [providerKind, token] of Object.entries(providerTokens)) {
          if (providerKind !== entry.binding.provider)
            expect(serialized).not.toContain(token);
        }
      });
    }
  }

  it("does not emit partial Cloudflare Access headers", () => {
    const config = JSON.parse(
      renderOpenCodeConfig({
        TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
        TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
        TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
        TILLER_OPENCODE_BASE_URL: "https://hub.example.com/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "workers-secret",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
        TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
        TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
        TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "262144",
        TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
        TILLER_OPENCODE_REASONING_EFFORT: "high",
        CF_ACCESS_CLIENT_ID: "client-only",
      }),
    ) as RenderedOpenCodeConfig;

    expect(config.provider["tiller-hub"].options.headers).toBeUndefined();
  });

  it("rejects unknown provider kinds", () => {
    expect(() =>
      renderOpenCodeConfig({
        TILLER_OPENCODE_PROVIDER_KIND: "other-provider",
        TILLER_OPENCODE_BASE_URL: "https://provider.example.com/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "secret",
        TILLER_OPENCODE_MODEL_ID: "model",
      }),
    ).toThrow(/Unsupported TILLER_OPENCODE_PROVIDER_KIND/);
  });

  it.each([
    "TILLER_OPENCODE_BASE_URL",
    "TILLER_OPENCODE_AUTH_TOKEN",
    "TILLER_OPENCODE_PROVIDER_KIND",
    "TILLER_OPENCODE_PROVIDER_ALIAS",
    "TILLER_OPENCODE_PROVIDER_LABEL",
    "TILLER_OPENCODE_MODEL_ID",
    "TILLER_OPENCODE_MODEL_ALIAS",
    "TILLER_OPENCODE_MODEL_LABEL",
    "TILLER_OPENCODE_MODEL_CONTEXT_LIMIT",
    "TILLER_OPENCODE_MODEL_OUTPUT_LIMIT",
    "TILLER_OPENCODE_REASONING_EFFORT",
  ])("rejects a missing selected setting: %s", (missingName) => {
    const env: Record<string, string> = {
      TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
      TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
      TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
      TILLER_OPENCODE_BASE_URL: "https://hub.example.com/api/opencode/v1",
      TILLER_OPENCODE_AUTH_TOKEN: "workers-secret",
      TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
      TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
      TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
      TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "262144",
      TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
      TILLER_OPENCODE_REASONING_EFFORT: "high",
    };
    delete env[missingName];

    expect(() => renderOpenCodeConfig(env)).toThrow(
      `${missingName} is required`,
    );
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid model limit: %s",
    (limit) => {
      expect(() =>
        renderOpenCodeConfig({
          TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
          TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
          TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
          TILLER_OPENCODE_BASE_URL: "https://hub.example.com/api/opencode/v1",
          TILLER_OPENCODE_AUTH_TOKEN: "workers-secret",
          TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
          TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
          TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
          TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: limit,
          TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
          TILLER_OPENCODE_REASONING_EFFORT: "high",
        }),
      ).toThrow(/must be a positive integer/);
    },
  );
});
