import os from "node:os";
import path from "node:path";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const env = {
  get appId() {
    return required("APP_ID");
  },
  get privateKey() {
    return required("PRIVATE_KEY").replace(/\\n/g, "\n");
  },
  get webhookSecret() {
    return required("WEBHOOK_SECRET");
  },
  get port() {
    return parseInt(process.env.PORT ?? "3000", 10);
  },
  get marketplaceWebhookSecret() {
    return process.env.MARKETPLACE_WEBHOOK_SECRET ?? "";
  },
  get adminApiToken() {
    return process.env.ADMIN_API_TOKEN ?? "";
  },
  get logLevel() {
    return process.env.LOG_LEVEL ?? "info";
  },
  get dbPath() {
    if (process.env.DB_PATH) return process.env.DB_PATH;
    if (process.env.NODE_ENV === "test") {
      return path.join(os.tmpdir(), "brin-github-test.db");
    }
    return "/data/brin.db";
  },
} as const;
