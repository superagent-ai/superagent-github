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
  get logLevel() {
    return process.env.LOG_LEVEL ?? "info";
  },
  get dbPath() {
    return process.env.DB_PATH ?? "/data/brin.db";
  },
} as const;
