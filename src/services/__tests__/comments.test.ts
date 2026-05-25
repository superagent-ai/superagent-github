import { describe, it, expect } from "vitest";
import { renderPrScanComment, renderContributorTrustComment } from "../comments.js";
import { MARKERS } from "../../lib/types.js";
import type { PrScanResult, ContributorResult } from "../../lib/types.js";

describe("renderPrScanComment", () => {
  it("renders an actionable findings comment", () => {
    const result: PrScanResult = {
      findings: [
        {
          category: "ci_cd",
          severity: "critical",
          title: "pull_request_target checks out fork code",
          file: ".github/workflows/ci.yml",
          line: 12,
          evidence: "Workflow uses pull_request_target with checkout of the PR head SHA.",
          recommendation: "Use pull_request for untrusted code or move privileged commenting into this GitHub App.",
        },
        {
          category: "malicious_intent",
          severity: "high",
          title: "Encoded payload added to build script",
          file: "scripts/build.js",
          evidence: "New build script decodes and executes a base64 payload.",
          recommendation: "Remove the encoded payload and replace it with reviewable source code.",
        },
      ],
    };
    const body = renderPrScanComment("review", result);

    expect(body).toContain(MARKERS.PR_SCAN);
    expect(body).toContain("### Superagent Security Scan");
    expect(body).toContain("suspicious changes");
    expect(body).not.toContain("Score");
    expect(body).not.toContain("Verdict");
    expect(body).toContain("**P0:** pull_request_target checks out fork code");
    expect(body).toContain("**Category:** CI/CD");
    expect(body).toContain("`.github/workflows/ci.yml:12`");
    expect(body).toContain("Use pull_request for untrusted code");
    expect(body).toContain("**P1:** Encoded payload added to build script");
    expect(body).toContain("Analyzed by [Superagent]");
  });

  it("renders without finding sections when none are present", () => {
    const result: PrScanResult = { findings: [] };
    const body = renderPrScanComment("review", result);

    expect(body).not.toContain("#### ");
  });
});

describe("renderContributorTrustComment", () => {
  it("renders full flagged contributor comment", () => {
    const result: ContributorResult = {
      score: 25,
      verdict: "suspicious",
      name: "sketchy-user",
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
    expect(body).toContain("Analyzed by [Superagent]");
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
