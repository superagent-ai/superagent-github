import { describe, it, expect } from "vitest";
import { evaluatePrScan, evaluateContributor } from "../policy.js";
import { DEFAULT_CONFIG } from "../types.js";
import type { PrScanResult, ContributorResult, RepoConfig } from "../types.js";

describe("evaluatePrScan", () => {
  const config = DEFAULT_CONFIG;

  it("returns review when the scan has findings", () => {
    const result: PrScanResult = {
      findings: [
        {
          category: "malicious_intent",
          severity: "high",
          title: "Suspicious network exfiltration",
          file: "src/index.ts",
          evidence: "New code sends process.env to an external host.",
          recommendation: "Remove the exfiltration path and rotate exposed credentials.",
        },
      ],
    };

    expect(evaluatePrScan(result, config)).toEqual({
      status: "review",
      shouldFail: false,
    });
  });

  it("returns clean when the scan has no findings", () => {
    const result: PrScanResult = { findings: [] };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "clean",
      shouldFail: false,
    });
  });

  it("returns inconclusive when the scan reports an error", () => {
    const result: PrScanResult = { error: "Flue scan failed" };
    expect(evaluatePrScan(result, config)).toEqual({
      status: "inconclusive",
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
