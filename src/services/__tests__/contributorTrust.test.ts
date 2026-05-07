import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_NAMES, DEFAULT_CONFIG } from "../../lib/types.js";
import { scanContributorLocally } from "../contributorScanner.js";
import { runContributorTrust } from "../contributorTrust.js";

vi.mock("../contributorScanner.js", () => ({
  scanContributorLocally: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  childLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

const scanContributorLocallyMock = vi.mocked(scanContributorLocally);

describe("runContributorTrust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the local scanner result to flag contributors", async () => {
    scanContributorLocallyMock.mockResolvedValue({
      name: "sketchy-user",
      score: 20,
      verdict: "suspicious",
      confidence: "low",
      threats: [
        {
          type: "malicious_new_account",
          severity: "high",
          detail: "Account is new",
        },
      ],
      sub_scores: { identity: 10, behavior: 50, content: 40 },
    });
    const octokit = mockOctokit();

    await runContributorTrust(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
      authorLogin: "sketchy-user",
      config: DEFAULT_CONFIG,
    });

    expect(scanContributorLocallyMock).toHaveBeenCalledWith("sketchy-user", {
      githubToken: "ghs_installation_token",
    });
    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: CHECK_NAMES.CONTRIBUTOR_TRUST,
        head_sha: "abc123",
        status: "in_progress",
      }),
    );
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 42,
        conclusion: "failure",
        output: expect.objectContaining({
          title: "Contributor flagged for review",
          summary: "Score: 20/100 \u00b7 Verdict: suspicious",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 12,
        labels: ["keep", "contributor:flagged"],
      }),
    );
    expect(octokit.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Contributor Trust Check"),
      }),
    );
    const commentBody = vi.mocked(octokit.rest.issues.createComment).mock.calls[0]?.[0].body;
    expect(commentBody).toContain("| Identity | 10 |");
    expect(commentBody).not.toContain("| Graph |");
  });

  it("uses the local scanner result to verify contributors", async () => {
    scanContributorLocallyMock.mockResolvedValue({
      name: "trusted-user",
      score: 90,
      verdict: "safe",
      confidence: "medium",
      sub_scores: { identity: 90, behavior: 90, content: 90 },
    });
    const octokit = mockOctokit([{ id: 99, body: "<!-- brin-check --> old comment" }]);

    await runContributorTrust(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
      authorLogin: "trusted-user",
      config: DEFAULT_CONFIG,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "success",
        output: expect.objectContaining({
          title: "Contributor verified",
          summary: "Score: 90/100 \u00b7 Verdict: safe",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["keep", "contributor:verified"] }),
    );
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 }),
    );
  });
});

function mockOctokit(comments: Array<{ id: number; body: string }> = []) {
  return {
    auth: vi.fn().mockResolvedValue({ token: "ghs_installation_token" }),
    paginate: vi.fn().mockResolvedValue(comments),
    rest: {
      checks: {
        create: vi.fn().mockResolvedValue({ data: { id: 42 } }),
        update: vi.fn().mockResolvedValue({}),
      },
      issues: {
        getLabel: vi.fn().mockRejectedValue({ status: 404 }),
        createLabel: vi.fn().mockResolvedValue({}),
        updateLabel: vi.fn().mockResolvedValue({}),
        listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [{ name: "keep" }] }),
        setLabels: vi.fn().mockResolvedValue({}),
        listComments: vi.fn(),
        updateComment: vi.fn().mockResolvedValue({}),
        createComment: vi.fn().mockResolvedValue({}),
        deleteComment: vi.fn().mockResolvedValue({}),
      },
    },
  } as any;
}
