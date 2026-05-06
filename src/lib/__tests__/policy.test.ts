import { describe, it, expect } from "vitest";
import { evaluatePrScan, evaluateContributor } from "../policy.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { PrScanResult, ContributorResult, RepoConfig } from "../types.js";

describe("evaluatePrScan", () => {
  const config = DEFAULT_CONFIG;

  it("returns blocking when verdict is dangerous", () => {
    const result: PrScanResult = { score: 20, verdict: "dangerous" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "blocking",
      shouldFail: true,
    });
  });

  it("returns blocking when score is below threshold", () => {
    const result: PrScanResult = { score: 15, verdict: "suspicious" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "blocking",
      shouldFail: true,
    });
  });

  it("returns blocking for score 0", () => {
    const result: PrScanResult = { score: 0, verdict: "unknown" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "blocking",
      shouldFail: true,
    });
  });

  it("returns review when verdict is suspicious and score is above threshold", () => {
    const result: PrScanResult = { score: 45, verdict: "suspicious" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "review",
      shouldFail: false,
    });
  });

  it("returns clean for a safe PR", () => {
    const result: PrScanResult = { score: 85, verdict: "safe" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "clean",
      shouldFail: false,
    });
  });

  it("returns inconclusive when score is null", () => {
    const result: PrScanResult = {};
    expect(evaluatePrScan(result, config)).toEqual({
      status: "inconclusive",
      shouldFail: false,
    });
  });

  it("returns inconclusive when pending_deep_scan is true", () => {
    const result: PrScanResult = { score: 50, verdict: "safe", pending_deep_scan: true };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "inconclusive",
      shouldFail: false,
    });
  });

  it("returns inconclusive when Brin reports an internal scan error", () => {
    const result: PrScanResult = {
      score: 0,
      verdict: "dangerous",
      threats: [
        {
          type: "scan_error",
          detail: "failed to fetch PR: GitHub API returned 404",
        },
      ],
    };

    expect(evaluatePrScan(result, config)).toEqual({
      status: "inconclusive",
      shouldFail: false,
    });
  });

  it("respects custom blockBelowScore threshold", () => {
    const custom: RepoConfig = {
      ...config,
      prScan: { ...config.prScan, blockBelowScore: 50 },
    };
    const result: PrScanResult = { score: 45, verdict: "safe" };
    expect(evaluatePrScan(result, custom)).toEqual({
      status: "blocking",
      shouldFail: true,
    });
  });

  it("respects custom suspiciousVerdicts", () => {
    const custom: RepoConfig = {
      ...config,
      prScan: { ...config.prScan, suspiciousVerdicts: ["suspicious", "caution"] },
    };
    const result: PrScanResult = { score: 60, verdict: "caution" };
    expect(evaluatePrScan(result, custom)).toEqual({
      status: "review",
      shouldFail: false,
    });
  });

  it("score exactly at threshold is not blocking", () => {
    const result: PrScanResult = { score: 30, verdict: "safe" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "clean",
      shouldFail: false,
    });
  });
});

describe("evaluateContributor", () => {
  const config = DEFAULT_CONFIG;

  it("returns safe for a safe verdict", () => {
    const result: ContributorResult = { score: 90, verdict: "safe" };
    expect(evaluateContributor(result, config)).toEqual({ isSafe: true });
  });

  it("returns safe for a suspicious verdict when score is above threshold", () => {
    const result: ContributorResult = { score: 68, verdict: "suspicious" };
    expect(evaluateContributor(result, config)).toEqual({ isSafe: true });
  });

  it("returns safe for a caution verdict when score is above threshold", () => {
    const result: ContributorResult = { score: 50, verdict: "caution" };
    expect(evaluateContributor(result, config)).toEqual({ isSafe: true });
  });

  it("returns not safe when score is below threshold", () => {
    const result: ContributorResult = { score: 10, verdict: "dangerous" };
    expect(evaluateContributor(result, config)).toEqual({ isSafe: false });
  });

  it("fails open when score is missing", () => {
    const result: ContributorResult = {};
    expect(evaluateContributor(result, config)).toEqual({ isSafe: true });
  });

  it("respects custom blockBelowScore threshold", () => {
    const custom: RepoConfig = {
      ...config,
      contributorTrust: { ...config.contributorTrust, blockBelowScore: 70 },
    };
    const result: ContributorResult = { score: 68, verdict: "safe" };
    expect(evaluateContributor(result, custom)).toEqual({ isSafe: false });
  });
});
