import type { PrScanResult, ContributorResult, RepoConfig, PrStatus } from "./types.js";

export function evaluatePrScan(
  result: PrScanResult,
  config: RepoConfig,
): { status: PrStatus; shouldFail: boolean } {
  if (result.error) {
    return { status: "inconclusive", shouldFail: false };
  }
  if (result.findings?.length) {
    return { status: "review", shouldFail: false };
  }
  return { status: "clean", shouldFail: false };
}

export function evaluateContributor(
  result: ContributorResult,
  config: RepoConfig,
): { isSafe: boolean } {
  if (result.score == null) {
    return { isSafe: true };
  }
  return { isSafe: result.score >= config.contributorTrust.blockBelowScore };
}
