import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { isAuthorizedBearer, requireAdminApiToken } from "../adminAuth.js";

function protectedApp() {
  const app = new Hono();
  app.get("/protected", requireAdminApiToken, (c) => c.json({ ok: true }));
  return app;
}

describe("admin API auth", () => {
  afterEach(() => {
    delete process.env.ADMIN_API_TOKEN;
  });

  it("authorizes exact bearer tokens", () => {
    expect(isAuthorizedBearer("Bearer secret-token", "secret-token")).toBe(true);
    expect(isAuthorizedBearer("bearer secret-token", "secret-token")).toBe(true);
  });

  it("rejects missing, malformed, and incorrect bearer tokens", () => {
    expect(isAuthorizedBearer(undefined, "secret-token")).toBe(false);
    expect(isAuthorizedBearer("Basic secret-token", "secret-token")).toBe(false);
    expect(isAuthorizedBearer("Bearer wrong-token", "secret-token")).toBe(false);
    expect(isAuthorizedBearer("Bearer secret-token", "")).toBe(false);
  });

  it("fails closed when the admin token is not configured", async () => {
    const res = await protectedApp().request("/protected", {
      headers: { authorization: "Bearer anything" },
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "admin_api_token_not_configured",
    });
  });

  it("rejects unauthenticated requests with a bearer challenge", async () => {
    process.env.ADMIN_API_TOKEN = "secret-token";

    const res = await protectedApp().request("/protected");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer realm="superagent-admin"',
    );
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("allows requests with the configured admin token", async () => {
    process.env.ADMIN_API_TOKEN = "secret-token";

    const res = await protectedApp().request("/protected", {
      headers: { authorization: "Bearer secret-token" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
