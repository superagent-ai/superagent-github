const DEFAULT_PROVIDER_ID = "azure-foundry-base-models";

type EnvSource = Record<string, string | undefined>;

export interface AzureKimiModelConfig {
  providerId: string;
  modelId: string;
  model: string;
}

export interface AzureKimiProviderConfig extends AzureKimiModelConfig {
  apiKey: string;
  baseUrl: string;
  registration: {
    api: "openai-completions";
    baseUrl: string;
    apiKey: string;
    provider: string;
  };
}

export function normalizeAzureOpenAIBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/responses\/?$/, "");

  if (url.hostname.endsWith(".services.ai.azure.com")) {
    url.hostname = url.hostname.replace(
      ".services.ai.azure.com",
      ".cognitiveservices.azure.com",
    );
    url.pathname = "/openai/v1";
    url.search = "";
    url.hash = "";
  } else if (url.hostname.endsWith(".openai.azure.com")) {
    url.hostname = url.hostname.replace(
      ".openai.azure.com",
      ".cognitiveservices.azure.com",
    );
    url.pathname = "/openai/v1";
    url.search = "";
    url.hash = "";
  } else if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/openai/v1";
  } else if (url.pathname.endsWith("/openai")) {
    url.pathname = `${url.pathname}/v1`;
  }

  return url.toString().replace(/\/$/, "");
}

export function getAzureKimiModel(source: EnvSource = process.env): string {
  return resolveAzureKimiModel(source).model;
}

export function resolveAzureKimiModel(source: EnvSource = process.env): AzureKimiModelConfig {
  const providerId = source.FLUE_PROVIDER_ID?.trim() || DEFAULT_PROVIDER_ID;
  const deployment = requiredFrom(source, "AZURE_OPENAI_DEPLOYMENT");
  const rawModel = source.FLUE_MODEL?.trim();

  if (!rawModel) {
    return {
      providerId,
      modelId: deployment,
      model: `${providerId}/${deployment}`,
    };
  }

  const slashIndex = rawModel.indexOf("/");
  if (slashIndex === -1) {
    return {
      providerId,
      modelId: rawModel,
      model: `${providerId}/${rawModel}`,
    };
  }

  const modelProviderId = rawModel.slice(0, slashIndex).trim();
  const modelId = rawModel.slice(slashIndex + 1).trim();
  if (!modelProviderId || !modelId) {
    throw new Error("FLUE_MODEL must be formatted as <provider>/<model>");
  }

  return {
    providerId: modelProviderId,
    modelId,
    model: `${modelProviderId}/${modelId}`,
  };
}

export function getAzureKimiProviderConfig(
  source: EnvSource = process.env,
): AzureKimiProviderConfig {
  const modelConfig = resolveAzureKimiModel(source);
  const apiKey = requiredFrom(source, "AZURE_OPENAI_API_KEY");
  const baseUrl = normalizeAzureOpenAIBaseUrl(
    requiredFrom(source, "AZURE_OPENAI_BASE_URL"),
  );

  return {
    ...modelConfig,
    apiKey,
    baseUrl,
    registration: {
      api: "openai-completions",
      baseUrl,
      apiKey,
      provider: modelConfig.providerId,
    },
  };
}

function requiredFrom(source: EnvSource, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}
