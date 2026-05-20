import { describe, expect, it, vi } from "vitest";
import { MARKERS } from "../../lib/types.js";
import {
  isPrFindingComment,
  resolveFindingForUserReply,
  resolveRootFindingComment,
} from "../prFindings.js";

describe("isPrFindingComment", () => {
  it("matches finding comments but not acknowledgments", () => {
    expect(isPrFindingComment(`${MARKERS.PR_FINDING}\n**P2:** issue`)).toBe(true);
    expect(isPrFindingComment(`${MARKERS.PR_FINDING_ACK}\nThanks`)).toBe(false);
  });
});

describe("resolveRootFindingComment", () => {
  it("walks reply chains to the root finding", async () => {
    const octokit = {
      rest: {
        pulls: {
          getReviewComment: vi
            .fn()
            .mockResolvedValueOnce({
              data: {
                id: 11,
                body: "reply",
                in_reply_to_id: 10,
              },
            })
            .mockResolvedValueOnce({
              data: {
                id: 10,
                body: `${MARKERS.PR_FINDING}\n**P2:** root`,
                in_reply_to_id: null,
              },
            }),
        },
      },
    } as any;

    const root = await resolveRootFindingComment(octokit, "acme", "repo", {
      id: 11,
      body: "reply",
      in_reply_to_id: 10,
    });

    expect(root?.id).toBe(10);
  });
});

describe("resolveFindingForUserReply", () => {
  it("matches a finding on the same file line when the reply has no in_reply_to_id", async () => {
    const octokit = {
      paginate: vi.fn().mockResolvedValue([
        {
          id: 10,
          body: `${MARKERS.PR_FINDING}\n**P0:** issue`,
          path: ".github/workflows/test.yml",
          line: 17,
        },
      ]),
      rest: { pulls: { listReviewComments: vi.fn() } },
    } as any;

    const finding = await resolveFindingForUserReply(octokit, "acme", "repo", 12, {
      id: 11,
      body: "This is intentional",
      path: ".github/workflows/test.yml",
      line: 17,
    });

    expect(finding?.id).toBe(10);
  });
});
