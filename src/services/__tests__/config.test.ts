import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "../config.js";
import { DEFAULT_CONFIG } from "../../lib/types.js";

vi.mock("../../lib/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

function mockOctokit(content?: string, error?: { status: number }) {
  const getContent = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue({
        data: {
          content: Buffer.from(content ?? "").toString("base64"),
        },
      });

  return { rest: { repos: { getContent } } } as any;
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const octokit = mockOctokit(undefined, { status: 404 });
    const config = await loadConfig(octokit, "owner", "repo");
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial config with defaults", async () => {
    const yaml = `
prScan:
  blockBelowScore: 50
contributorTrust:
  trustedAuthors:
    - mybot[bot]
`;
    const octokit = mockOctokit(yaml);
    const config = await loadConfig(octokit, "owner", "repo");

    expect(config.prScan.blockBelowScore).toBe(50);
    expect(config.prScan.enabled).toBe(true);
    expect(config.prScan.tolerance).toBe("conservative");
    expect(config.contributorTrust.trustedAuthors).toEqual(["mybot[bot]"]);
    expect(config.contributorTrust.blockBelowScore).toBe(30);
  });

  it("handles disabled scans", async () => {
    const yaml = `
prScan:
  enabled: false
contributorTrust:
  enabled: false
`;
    const octokit = mockOctokit(yaml);
    const config = await loadConfig(octokit, "owner", "repo");

    expect(config.prScan.enabled).toBe(false);
    expect(config.contributorTrust.enabled).toBe(false);
  });

  it("returns defaults on non-404 API error", async () => {
    const octokit = mockOctokit(undefined, { status: 500 });
    const config = await loadConfig(octokit, "owner", "repo");
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults for empty YAML file", async () => {
    const octokit = mockOctokit("");
    const config = await loadConfig(octokit, "owner", "repo");
    expect(config).toEqual(DEFAULT_CONFIG);
  });
});
