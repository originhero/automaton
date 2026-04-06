import { describe, it, expect, afterEach } from "vitest";
import { resolveProviderConfigs, type ResolvedProviderConfig } from "../../config.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Provider Config Resolution", () => {
  describe("new providers section", () => {
    it("parses providers from config", () => {
      const config = {
        providers: {
          openai: { apiKey: "sk-new-openai" },
          anthropic: { apiKey: "sk-ant-new" },
          deepseek: { apiKey: "sk-ds-new", baseUrl: "https://custom.deepseek.com/v1" },
        },
      };

      const result = resolveProviderConfigs(config);

      expect(result.openai?.apiKey).toBe("sk-new-openai");
      expect(result.openai?.baseUrl).toBe("https://api.openai.com/v1");
      expect(result.anthropic?.apiKey).toBe("sk-ant-new");
      expect(result.deepseek?.apiKey).toBe("sk-ds-new");
      expect(result.deepseek?.baseUrl).toBe("https://custom.deepseek.com/v1");
    });

    it("fills in default base URLs when not specified", () => {
      const config = {
        providers: {
          google: { apiKey: "AIza-test" },
        },
      };

      const result = resolveProviderConfigs(config);
      expect(result.google?.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    });

    it("parses Ollama with custom baseUrl", () => {
      const config = {
        providers: {
          ollama: { baseUrl: "http://gpu-server:11434" },
        },
      };

      const result = resolveProviderConfigs(config);
      expect(result.ollama?.baseUrl).toBe("http://gpu-server:11434");
    });

    it("parses custom provider entries", () => {
      const config = {
        providers: {
          custom: [
            {
              name: "my-corp-llm",
              protocol: "openai-compatible",
              baseUrl: "https://llm.internal.corp/v1",
              apiKey: "corp-key-123",
              tier: "balanced",
            },
          ],
        },
      };

      const result = resolveProviderConfigs(config);
      expect(result.custom).toHaveLength(1);
      expect(result.custom![0].name).toBe("my-corp-llm");
      expect(result.custom![0].apiKey).toBe("corp-key-123");
    });
  });

  describe("legacy key migration", () => {
    it("migrates openaiApiKey to providers.openai.apiKey", () => {
      const config = {
        openaiApiKey: "sk-old-openai",
      };

      const result = resolveProviderConfigs(config);
      expect(result.openai?.apiKey).toBe("sk-old-openai");
    });

    it("migrates anthropicApiKey to providers.anthropic.apiKey", () => {
      const config = {
        anthropicApiKey: "sk-ant-old",
      };

      const result = resolveProviderConfigs(config);
      expect(result.anthropic?.apiKey).toBe("sk-ant-old");
    });

    it("migrates googleApiKey to providers.google.apiKey", () => {
      const config = {
        googleApiKey: "AIza-old",
      };

      const result = resolveProviderConfigs(config);
      expect(result.google?.apiKey).toBe("AIza-old");
    });

    it("migrates ollamaBaseUrl to providers.ollama.baseUrl", () => {
      const config = {
        ollamaBaseUrl: "http://my-ollama:11434",
      };

      const result = resolveProviderConfigs(config);
      expect(result.ollama?.baseUrl).toBe("http://my-ollama:11434");
    });
  });

  describe("environment variable fallback", () => {
    it("falls back to OPENAI_API_KEY env var", () => {
      process.env.OPENAI_API_KEY = "sk-env-openai";
      const config = {};

      const result = resolveProviderConfigs(config);
      expect(result.openai?.apiKey).toBe("sk-env-openai");
    });

    it("falls back to ANTHROPIC_API_KEY env var", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-env";
      const config = {};

      const result = resolveProviderConfigs(config);
      expect(result.anthropic?.apiKey).toBe("sk-ant-env");
    });

    it("falls back to GOOGLE_API_KEY env var", () => {
      process.env.GOOGLE_API_KEY = "AIza-env";
      const config = {};

      const result = resolveProviderConfigs(config);
      expect(result.google?.apiKey).toBe("AIza-env");
    });
  });

  describe("priority order", () => {
    it("config providers > config legacy > env vars", () => {
      process.env.OPENAI_API_KEY = "sk-env";
      const config = {
        openaiApiKey: "sk-legacy",
        providers: {
          openai: { apiKey: "sk-providers" },
        },
      };

      const result = resolveProviderConfigs(config);
      expect(result.openai?.apiKey).toBe("sk-providers");
    });

    it("config legacy > env vars", () => {
      process.env.OPENAI_API_KEY = "sk-env";
      const config = {
        openaiApiKey: "sk-legacy",
      };

      const result = resolveProviderConfigs(config);
      expect(result.openai?.apiKey).toBe("sk-legacy");
    });
  });
});
