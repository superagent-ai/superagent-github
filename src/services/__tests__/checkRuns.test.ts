import { describe, expect, it, vi } from "vitest";
import { SUPERAGENT_URL } from "../../lib/types.js";
import { completeCheck, createInProgressCheck } from "../checkRuns.js";

describe("checkRuns", () => {
  it("sets Superagent as the check run details URL", async () => {
    const octokit = {
      rest: {
        checks: {
          create: vi.fn().mockResolvedValue({ data: { id: 42 } }),
          update: vi.fn().mockResolvedValue({}),
        },
      },
    };

    const checkRunId = await createInProgressCheck(
      octokit as never,
      "acme",
      "repo",
      "abc123",
      "Security scan",
    );

    expect(checkRunId).toBe(42);
    expect(octokit.rest.checks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        details_url: SUPERAGENT_URL,
      }),
    );

    await completeCheck(octokit as never, "acme", "repo", checkRunId, "success", {
      title: "PR scan passed",
      summary: "No suspicious PR changes were detected.",
    });

    expect(octokit.rest.checks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        details_url: SUPERAGENT_URL,
      }),
    );
  });
});
