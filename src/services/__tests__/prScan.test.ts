import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_NAMES, DEFAULT_CONFIG } from "../../lib/types.js";
import { runPrScan } from "../prScan.js";

vi.mock("../prFindingDismissals.js", () => ({
  clearPrFindingDismissals: vi.fn(),
}));

vi.mock("../../lib/logger.js", () => ({
  childLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe("runPrScan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("comments and flags the PR when local scanner returns findings", async () => {
    stubScanFetch({
      findings: [
        {
          category: "malicious_intent",
          severity: "high",
          title: "Suspicious lifecycle hook",
          file: "package.json",
          line: 1,
          evidence: "postinstall executes a remote script.",
          recommendation: "Remove the hook and vendor reviewed setup code.",
          short_evidence: "A new postinstall hook executes a remote script.",
          short_recommendation: "Remove the lifecycle hook or replace it with reviewed local setup code.",
        },
      ],
    });
    const octokit = mockOctokit();

    await runPrScan(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
      config: DEFAULT_CONFIG,
    });

    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: CHECK_NAMES.PR_SCAN,
        head_sha: "abc123",
        status: "in_progress",
      }),
    );
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        check_run_id: 42,
        conclusion: "action_required",
        output: expect.objectContaining({
          title: "PR requires security review",
          summary: "1 security concern(s) detected.",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 12,
        labels: ["keep", "pr:flagged"],
      }),
    );
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        commit_id: "abc123",
        event: "COMMENT",
        comments: [
          expect.objectContaining({
            path: "package.json",
            line: 1,
            side: "RIGHT",
            body: expect.stringContaining("Suspicious lifecycle hook"),
          }),
        ],
      }),
    );
    const body = octokit.rest.pulls.createReview.mock.calls[0][0].comments[0].body;
    expect(body).toContain("A new postinstall hook executes a remote script.");
    expect(body).toContain("Remove the lifecycle hook");
    expect(body).toContain("**P1:** Suspicious lifecycle hook");
    expect(body).not.toContain("Fix:");
    expect(body).not.toContain("Recommended fix");
  });

  it("verifies the PR and removes stale comments when no findings are found", async () => {
    stubScanFetch({ findings: [] });
    const octokit = mockOctokit([{ id: 99, body: "<!-- brin-pr-scan --> old comment" }]);

    await runPrScan(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
      config: DEFAULT_CONFIG,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "success",
        output: expect.objectContaining({
          title: "PR scan passed",
          summary: "No suspicious PR changes were detected.",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["keep", "pr:verified"] }),
    );
    expect(octokit.rest.issues.deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99 }),
    );
    expect(octokit.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 100 }),
    );
  });

  it("leaves the PR unverified when the scanner reports an inconclusive error", async () => {
    stubScanFetch({
      error: "PR patch for package.json exceeds the 8000 character per-file scan limit",
    });
    const octokit = mockOctokit([{ id: 99, body: "<!-- brin-pr-scan --> old comment" }]);

    await runPrScan(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
      config: DEFAULT_CONFIG,
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "neutral",
        output: expect.objectContaining({
          title: "Scan inconclusive",
          summary: "PR patch for package.json exceeds the 8000 character per-file scan limit",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({ labels: ["keep"] }),
    );
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  });
});

function stubScanFetch(scanResult: unknown) {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ title: "PR", body: "", user: { login: "octocat" } }))
      .mockResolvedValueOnce(jsonResponse([{ filename: "package.json", status: "modified", patch: "{}" }]))
      .mockResolvedValueOnce(jsonResponse(scanResult)),
  );
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mockOctokit(comments: Array<{ id: number; body: string }> = []) {
  const listReviewComments = vi.fn();
  return {
    auth: vi.fn().mockResolvedValue({ token: "ghs_installation_token" }),
    paginate: vi.fn((endpoint) => {
      if (endpoint === listReviewComments) {
        return Promise.resolve([{ id: 100, body: "<!-- brin-pr-finding --> old finding" }]);
      }
      return Promise.resolve(comments);
    }),
    rest: {
      pulls: {
        listReviewComments,
        createReview: vi.fn().mockResolvedValue({}),
        deleteReviewComment: vi.fn().mockResolvedValue({}),
      },
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
