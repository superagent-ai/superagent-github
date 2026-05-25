import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_NAMES, LABEL_DEFS, MARKERS } from "../../lib/types.js";

const dismissedFindingIds = vi.hoisted(() => new Set<number>());
const dismissPrFindingMock = vi.hoisted(() => vi.fn());

vi.mock("../prFindingDismissals.js", () => ({
  dismissPrFinding: (params: { reviewCommentId: number }) => {
    dismissPrFindingMock(params);
    const { reviewCommentId } = params;
    dismissedFindingIds.add(reviewCommentId);
  },
  isPrFindingDismissed: (
    _owner: string,
    _repo: string,
    _prNumber: number,
    reviewCommentId: number,
  ) => dismissedFindingIds.has(reviewCommentId),
  clearPrFindingDismissals: () => {
    dismissedFindingIds.clear();
  },
}));

vi.mock("../../lib/logger.js", () => ({
  childLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("../../lib/dismissalEval.js", () => ({
  evaluateFindingDismissal: vi.fn(),
}));

vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    prScan: { enabled: true },
    contributorTrust: { enabled: true, blockBelowScore: 30, trustedAuthors: [] },
    comments: { mode: "detailed" },
  }),
}));

vi.mock("../trustedContributor.js", () => ({
  isTrustedRepoContributor: vi.fn().mockResolvedValue(false),
}));

import { evaluateFindingDismissal } from "../../lib/dismissalEval.js";
import { isTrustedRepoContributor } from "../trustedContributor.js";
import {
  handleFindingThreadResolved,
  handleFindingReply,
  persistReviewedFindingDismissals,
  reconcilePrScanAfterDismissals,
} from "../findingDismissal.js";

describe("handleFindingReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dismissedFindingIds.clear();
  });

  it("dismisses a finding, replies, and clears the check when all findings are addressed", async () => {
    vi.mocked(evaluateFindingDismissal).mockResolvedValue({
      dismiss: true,
      acknowledgment: "Thanks for clarifying, understood it's metadata only for now.",
    });

    const octokit = mockOctokit({
      findingComments: [
        {
          id: 10,
          body: `${MARKERS.PR_FINDING}\n**P2:** Sandbox scopes`,
          path: "pkg.ts",
          line: 1,
        },
      ],
    });

    await handleFindingReply(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      comment: {
        id: 11,
        body: "We're just using it for metadata for now.",
        in_reply_to_id: 10,
        user: { login: "marcindobry", type: "User" },
      },
    });

    expect(evaluateFindingDismissal).toHaveBeenCalled();
    expect(octokit.rest.reactions.createForPullRequestReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: 11,
        content: "eyes",
      }),
    );
    expect(octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        in_reply_to: 10,
        body: expect.stringContaining("metadata only for now"),
      }),
    );
    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "success",
        output: expect.objectContaining({
          summary: "All reported findings were reviewed and dismissed.",
        }),
      }),
    );
    expect(octokit.rest.issues.setLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: expect.arrayContaining([LABEL_DEFS.PR_VERIFIED.name]),
      }),
    );
  });

  it("uses permissive model evaluation for trusted contributor replies", async () => {
    vi.mocked(isTrustedRepoContributor).mockResolvedValueOnce(true);
    vi.mocked(evaluateFindingDismissal).mockResolvedValue({
      dismiss: true,
      acknowledgment: "Makes sense, treating this as an intentional test fixture.",
    });

    const octokit = mockOctokit();
    await handleFindingReply(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      comment: {
        id: 11,
        body: "This is intentional",
        in_reply_to_id: 10,
        author_association: "CONTRIBUTOR",
        user: { login: "homanp", type: "User" },
      },
    });

    expect(evaluateFindingDismissal).toHaveBeenCalledWith(
      expect.any(String),
      "This is intentional",
      { trustedContributor: true },
    );
    expect(octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("intentional test fixture"),
      }),
    );
  });

  it("replies when dismissal is not accepted", async () => {
    vi.mocked(evaluateFindingDismissal).mockResolvedValue({
      dismiss: false,
      acknowledgment: "Please explain why the PR title interpolation is safe here.",
    });

    const octokit = mockOctokit();
    await handleFindingReply(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      comment: {
        id: 11,
        body: "intentional",
        in_reply_to_id: 10,
        user: { login: "stranger", type: "User" },
      },
    });

    expect(octokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("PR title interpolation"),
      }),
    );
    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });

  it("ignores bot replies", async () => {
    const octokit = mockOctokit();
    await handleFindingReply(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      comment: {
        id: 11,
        body: "Thanks",
        in_reply_to_id: 10,
        user: { login: "superagent-security[bot]", type: "Bot" },
      },
    });
    expect(evaluateFindingDismissal).not.toHaveBeenCalled();
  });
});

describe("handleFindingThreadResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dismissedFindingIds.clear();
  });

  it("dismisses a finding when a trusted contributor resolves the thread", async () => {
    vi.mocked(isTrustedRepoContributor).mockResolvedValueOnce(true);
    const octokit = mockOctokit({
      findingComments: [
        { id: 10, body: `${MARKERS.PR_FINDING}\n**P2:** one`, path: "a.ts", line: 1 },
      ],
    });

    await handleFindingThreadResolved(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      thread: { path: "a.ts", line: 1 },
      sender: { login: "maintainer", type: "User" },
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        conclusion: "success",
        output: expect.objectContaining({
          summary: "All reported findings were reviewed and dismissed.",
        }),
      }),
    );
    expect(evaluateFindingDismissal).not.toHaveBeenCalled();
  });

  it("ignores resolved threads from untrusted users", async () => {
    vi.mocked(isTrustedRepoContributor).mockResolvedValueOnce(false);
    const octokit = mockOctokit();

    await handleFindingThreadResolved(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      thread: { path: "pkg.ts", line: 1 },
      sender: { login: "drive-by", type: "User" },
    });

    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });
});

describe("reconcilePrScanAfterDismissals", () => {
  beforeEach(() => {
    dismissedFindingIds.clear();
  });

  it("does not clear the check while open findings remain", async () => {
    dismissedFindingIds.add(10);

    const octokit = mockOctokit({
      findingComments: [
        { id: 10, body: `${MARKERS.PR_FINDING}\n**P2:** one`, path: "a.ts", line: 1 },
        { id: 20, body: `${MARKERS.PR_FINDING}\n**P1:** two`, path: "b.ts", line: 2 },
      ],
    });

    await reconcilePrScanAfterDismissals(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "abc123",
    });

    expect(octokit.rest.checks.update).not.toHaveBeenCalled();
  });
});

describe("persistReviewedFindingDismissals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dismissedFindingIds.clear();
  });

  it("records reviewed findings against the review comment commit SHA", async () => {
    const octokit = mockOctokit({
      findingComments: [
        {
          id: 10,
          body: `${MARKERS.PR_FINDING}\n**P2:** one`,
          path: "a.ts",
          line: 1,
          commit_id: "comment-sha",
        },
        {
          id: 11,
          body: MARKERS.PR_FINDING_ACK,
          in_reply_to_id: 10,
          user: { login: "superagent-security[bot]", type: "Bot" },
        },
      ],
    });

    await persistReviewedFindingDismissals(octokit, {
      owner: "acme",
      repo: "repo",
      prNumber: 12,
      headSha: "current-sha",
    });

    expect(dismissPrFindingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewCommentId: 10,
        headSha: "comment-sha",
      }),
    );
  });
});

function mockOctokit(options?: {
  findingComments?: Array<{
    id: number;
    body: string;
    path?: string;
    line?: number;
    commit_id?: string;
    in_reply_to_id?: number;
    user?: { login?: string; type?: string };
  }>;
}) {
  const findingComments = options?.findingComments ?? [
    {
      id: 10,
      body: `${MARKERS.PR_FINDING}\n**P2:** Sandbox scopes`,
      path: "pkg.ts",
      line: 1,
    },
  ];
  const commentById = new Map(
    findingComments.map((comment) => [comment.id, comment]),
  );
  const listReviewComments = vi.fn();

  return {
    paginate: vi.fn((endpoint) => {
      if (endpoint === listReviewComments) {
        return Promise.resolve(findingComments);
      }
      return Promise.resolve([]);
    }),
    rest: {
      pulls: {
        listReviewComments,
        getReviewComment: vi.fn().mockImplementation(({ comment_id }) => {
          const comment = commentById.get(comment_id);
          if (!comment) throw new Error(`missing comment ${comment_id}`);
          return Promise.resolve({ data: comment });
        }),
        get: vi.fn().mockResolvedValue({ data: { head: { sha: "abc123" } } }),
        createReviewComment: vi.fn().mockResolvedValue({}),
        createReplyForReviewComment: vi.fn().mockResolvedValue({}),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [{ id: 99, name: CHECK_NAMES.PR_SCAN }],
          },
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      issues: {
        setLabels: vi.fn().mockResolvedValue({}),
        getLabel: vi.fn().mockResolvedValue({ data: { name: LABEL_DEFS.PR_VERIFIED.name } }),
        createLabel: vi.fn().mockResolvedValue({}),
        listLabelsOnIssue: vi.fn().mockResolvedValue({ data: [] }),
      },
      reactions: {
        createForPullRequestReviewComment: vi.fn().mockResolvedValue({}),
      },
    },
  } as any;
}
