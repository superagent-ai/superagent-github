import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanPr } from "../brinApi.js";

vi.mock("../logger.js", () => ({
  childLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe("scanPr", () => {
  beforeEach(() => {
    process.env.BRIN_API_BASE = "https://brin.example";
    vi.unstubAllGlobals();
  });

  it("forwards a GitHub token for private PR access", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ score: 90, verdict: "safe" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await scanPr("acme", "private-repo", 123, {
      tolerance: "aggressive",
      githubToken: "ghs_installation_token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://brin.example/pr/acme/private-repo/123?details=true&mode=full&tolerance=aggressive",
      expect.objectContaining({
        headers: { "x-github-token": "ghs_installation_token" },
      }),
    );
  });
});
