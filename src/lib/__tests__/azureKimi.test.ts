import { describe, expect, it } from "vitest";
import {
  getAzureKimiModel,
  getAzureKimiProviderConfig,
  normalizeAzureOpenAIBaseUrl,
} from "../azureKimi.js";

describe("azureKimi", () => {
  it("normalizes Azure Foundry and OpenAI endpoint shapes", () => {
    expect(
      normalizeAzureOpenAIBaseUrl("https://team.services.ai.azure.com"),
    ).toBe("https://team.cognitiveservices.azure.com/openai/v1");
    expect(
      normalizeAzureOpenAIBaseUrl("https://team.openai.azure.com/responses"),
    ).toBe("https://team.cognitiveservices.azure.com/openai/v1");
    expect(
      normalizeAzureOpenAIBaseUrl("https://team.cognitiveservices.azure.com/openai"),
    ).toBe("https://team.cognitiveservices.azure.com/openai/v1");
    expect(
      normalizeAzureOpenAIBaseUrl("https://team.cognitiveservices.azure.com/openai/v1/"),
    ).toBe("https://team.cognitiveservices.azure.com/openai/v1");
  });

  it("builds the default Flue model and provider registration", () => {
    const config = getAzureKimiProviderConfig({
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_BASE_URL: "https://team.services.ai.azure.com",
      AZURE_OPENAI_DEPLOYMENT: "Kimi-K2.6",
    });

    expect(config.providerId).toBe("azure-foundry-base-models");
    expect(config.modelId).toBe("Kimi-K2.6");
    expect(config.model).toBe("azure-foundry-base-models/Kimi-K2.6");
    expect(config.registration).toEqual({
      api: "openai-completions",
      apiKey: "azure-key",
      baseUrl: "https://team.cognitiveservices.azure.com/openai/v1",
      provider: "azure-foundry-base-models",
    });
  });

  it("allows FLUE_MODEL to override provider and model", () => {
    const source = {
      AZURE_OPENAI_DEPLOYMENT: "Kimi-K2.6",
      FLUE_PROVIDER_ID: "ignored-when-model-has-provider",
      FLUE_MODEL: "custom-provider/custom-kimi",
    };

    expect(getAzureKimiModel(source)).toBe("custom-provider/custom-kimi");
  });

  it("throws when required Azure values are missing", () => {
    expect(() => getAzureKimiModel({})).toThrow(
      "Missing required environment variable: AZURE_OPENAI_DEPLOYMENT",
    );
    expect(() =>
      getAzureKimiProviderConfig({
        AZURE_OPENAI_DEPLOYMENT: "Kimi-K2.6",
        AZURE_OPENAI_BASE_URL: "https://team.services.ai.azure.com",
      }),
    ).toThrow("Missing required environment variable: AZURE_OPENAI_API_KEY");
  });
});
