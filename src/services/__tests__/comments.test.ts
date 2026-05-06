import { describe, it, expect } from "vitest";
import { renderPrScanComment, renderContributorTrustComment } from "../comments.js";
import { MARKERS } from "../../lib/types.js";
import type { PrScanResult, ContributorResult } from "../../lib/types.js";

describe("renderPrScanComment", () => {
  it("renders blocking comment with threats", () => {
    const result: PrScanResult = {
      score: 15,
      verdict: "dangerous",
      threats: [
        { type: "credential_exposure", detail: "Hardcoded API key in config.ts" },
        { type: "obfuscation", detail: "Base64-encoded payload in build script" },
      ],
    };
    const body = renderPrScanComment("blocking", result);

    expect(body).toContain(MARKERS.PR_SCAN);
    expect(body).toContain("### Brin PR Security Scan");
    expect(body).toContain("should block merge");
    expect(body).toContain("**Score:** 15/100");
    expect(body).toContain("**Verdict:** dangerous");
    expect(body).toContain("credential_exposure: Hardcoded API key in config.ts");
    expect(body).toContain("obfuscation: Base64-encoded payload in build script");
    expect(body).toContain("Analyzed by [Brin]");
  });

  it("renders review comment", () => {
    const result: PrScanResult = { score: 45, verdict: "suspicious" };
    const body = renderPrScanComment("review", result);

    expect(body).toContain("should be reviewed");
    expect(body).not.toContain("should block merge");
  });

  it("renders without threats section when none present", () => {
    const result: PrScanResult = { score: 40, verdict: "suspicious" };
    const body = renderPrScanComment("review", result);

    expect(body).not.toContain("**Findings:**");
  });
});

describe("renderContributorTrustComment", () => {
  it("renders full flagged contributor comment", () => {
    const result: ContributorResult = {
      score: 25,
      verdict: "suspicious",
      name: "sketchy-user",
      url: "https://brin.sh/contributor/sketchy-user",
      threats: [
        { type: "new_account", severity: "high", detail: "Account created less than 30 days ago" },
      ],
      sub_scores: {
        identity: 20,
        behavior: 30,
        content: 40,
      },
    };
    const body = renderContributorTrustComment(result);

    expect(body).toContain(MARKERS.CONTRIBUTOR_TRUST);
    expect(body).toContain("Contributor Trust Check");
    expect(body).toContain("Review Recommended");
    expect(body).toContain("[sketchy-user](https://github.com/sketchy-user)");
    expect(body).toContain("Score: **25**/100");
    expect(body).toContain("Why was this flagged?");
    expect(body).toContain("new_account");
    expect(body).toContain("high");
    expect(body).toContain("Dimension breakdown");
    expect(body).toContain("| Identity | 20 |");
    expect(body).toContain("| Behavior | 30 |");
    expect(body).toContain("| Content | 40 |");
    expect(body).not.toContain("| Graph |");
    expect(body).toContain("[Full profile](https://brin.sh/contributor/sketchy-user?details=true)");
  });

  it("renders without threats section when empty", () => {
    const result: ContributorResult = {
      score: 40,
      verdict: "caution",
      name: "some-user",
    };
    const body = renderContributorTrustComment(result);

    expect(body).not.toContain("Why was this flagged?");
    expect(body).toContain("Dimension breakdown");
  });

  it("renders dashes for missing sub_scores", () => {
    const result: ContributorResult = {
      score: 40,
      verdict: "caution",
      name: "some-user",
    };
    const body = renderContributorTrustComment(result);

    expect(body).toContain("| Identity | \u2014 |");
    expect(body).not.toContain("| Graph |");
  });

  it("omits full profile link when url is missing", () => {
    const result: ContributorResult = {
      score: 40,
      verdict: "caution",
      name: "some-user",
    };
    const body = renderContributorTrustComment(result);

    expect(body).not.toContain("Full profile");
    expect(body).toContain("Analyzed by [Brin]");
  });

  it("uses correct emoji for each verdict", () => {
    expect(renderContributorTrustComment({ score: 30, verdict: "caution", name: "a" }))
      .toContain("\u26A0\uFE0F");
    expect(renderContributorTrustComment({ score: 30, verdict: "suspicious", name: "a" }))
      .toContain("\u26D4");
    expect(renderContributorTrustComment({ score: 30, verdict: "dangerous", name: "a" }))
      .toContain("\uD83D\uDEA8");
    expect(renderContributorTrustComment({ score: 30, verdict: "unknown", name: "a" }))
      .toContain("\u2753");
  });
});
