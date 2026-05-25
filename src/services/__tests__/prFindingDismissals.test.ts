import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPrFindingDismissals,
  dismissPrFinding,
  isPrFindingFingerprintDismissed,
} from "../prFindingDismissals.js";

describe("PR finding dismissals", () => {
  const owner = "dismissal-owner";
  const repo = "dismissal-repo";
  const prNumber = 6191;

  beforeEach(() => {
    clearPrFindingDismissals(owner, repo, prNumber);
  });

  it("keeps a finding fingerprint dismissed across later PR heads", () => {
    dismissPrFinding({
      owner,
      repo,
      prNumber,
      reviewCommentId: 3298017416,
      findingFingerprint: "same-finding-fingerprint",
      dismissedBy: "maintainer",
      headSha: "old-head-sha",
    });

    expect(
      isPrFindingFingerprintDismissed(
        owner,
        repo,
        prNumber,
        "same-finding-fingerprint",
      ),
    ).toBe(true);
  });
});
