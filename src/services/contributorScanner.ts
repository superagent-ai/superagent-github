import {
  compositeScore,
  deriveConfidence,
  scoreContributor,
  toContributorResult,
  verdictForScore,
  type ContributorDimensions,
  type ContributorScoreResult,
} from "../lib/contributorScoring.js";
import type { ContributorResult } from "../lib/types.js";
import { childLogger } from "../lib/logger.js";
import { collectContributorSignals } from "./githubContributor.js";
import {
  getCachedContributorScan,
  saveCachedContributorScan,
} from "./contributorScanCache.js";

export async function scanContributorLocally(
  login: string,
  options: { githubToken?: string } = {},
): Promise<ContributorResult> {
  const log = childLogger({ service: "contributor-scanner", login });
  const cached = getCachedContributorScan(login);
  if (cached) {
    log.info({ score: cached.score, verdict: cached.verdict }, "Contributor scan cache hit");
    return cached;
  }

  try {
    const { profile, activity } = await collectContributorSignals(login, options);
    const scoreResult = profile
      ? scoreContributor(profile, activity)
      : scoreContributorWithMissingProfile();
    const result = toContributorResult(login, scoreResult);

    saveCachedContributorScan(login, result);
    log.info({ score: result.score, verdict: result.verdict }, "Contributor scan completed");
    return result;
  } catch (err) {
    log.error({ err }, "Local contributor scan failed");
    return {};
  }
}

function scoreContributorWithMissingProfile(): ContributorScoreResult {
  const dimensions: ContributorDimensions = {
    identity: 30,
    behavior: 80,
    content: 100,
  };
  const score = compositeScore(dimensions);
  const confidence = capConfidenceForContributor(deriveConfidence(dimensions, score));

  return {
    dimensions,
    score,
    verdict: verdictForScore(score),
    confidence,
    threats: [],
  };
}

function capConfidenceForContributor(confidence: string): string {
  return confidence === "high" ? "medium" : confidence;
}
