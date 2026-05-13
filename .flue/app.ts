import { flue, registerProvider } from "@flue/sdk/app";
import { getAzureKimiProviderConfig } from "../src/lib/azureKimi.js";

export default {
  fetch(req: Request, env?: unknown, ctx?: unknown) {
    const provider = getAzureKimiProviderConfig(toEnvSource(env));
    registerProvider(provider.providerId, provider.registration);

    return flue().fetch(req, env, ctx);
  },
};

function toEnvSource(env: unknown): Record<string, string | undefined> {
  const source: Record<string, string | undefined> = { ...process.env };

  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") source[key] = value;
    }
  }

  return source;
}
