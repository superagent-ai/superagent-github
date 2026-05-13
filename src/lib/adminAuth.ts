import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { env } from "./env.js";
import { logger } from "./logger.js";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isAuthorizedBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;

  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  return timingSafeEqual(sha256(match[1]), sha256(expectedToken));
}

export const requireAdminApiToken: MiddlewareHandler = async (c, next) => {
  const adminApiToken = env.adminApiToken;
  if (!adminApiToken) {
    logger.error("ADMIN_API_TOKEN is required for installation API routes");
    return c.json({ error: "admin_api_token_not_configured" }, 503);
  }

  if (!isAuthorizedBearer(c.req.header("authorization"), adminApiToken)) {
    c.header("WWW-Authenticate", 'Bearer realm="superagent-admin"');
    return c.json({ error: "unauthorized" }, 401);
  }

  await next();
};
