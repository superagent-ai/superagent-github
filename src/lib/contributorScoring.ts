import type { ContributorResult } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.jp",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
  "aol.com",
  "mail.com",
  "yandex.com",
  "gmx.com",
  "gmx.de",
]);

export interface ContributorDimensions {
  identity: number;
  behavior: number;
  content: number;
}

export interface ContributorThreat {
  type: string;
  severity: string;
  detail: string;
}

export interface UserProfile {
  nodeId?: string;
  login: string;
  accountAgeDays?: number;
  publicRepos: number;
  followers: number;
  company?: string;
  email?: string;
  blog?: string;
  bio?: string;
  xUsername?: string;
  totalContributions?: number;
  reposContributedTo: string[];
  orgs: string[];
  hasGpgKeys: boolean;
}

export interface PrSummary {
  title: string;
  bodyLen: number;
  hasIssueRef: boolean;
  repo: string;
}

export interface ActivitySummary {
  repos: string[];
  totalEvents: number;
  lastEventAt?: Date;
  oldestEventAt?: Date;
  pushCount: number;
  prCount: number;
  reviewCount: number;
  distinctRepos7d: number;
  hasForkOnlyActivity: boolean;
  prOpenedCount: number;
  prTargetRepos7d: number;
  prOpened24h: number;
  prTargetRepos: string[];
  prClosedNotMerged: number;
  prMergedCount: number;
  prRejectedRepos: number;
  unsolicitedPrRatio: number;
  unsolicitedPrRepoCount: number;
  recentPrs: PrSummary[];
}

export interface ContributorScoreResult {
  dimensions: ContributorDimensions;
  score: number;
  verdict: string;
  confidence: string;
  threats: ContributorThreat[];
}

export function emptyActivitySummary(): ActivitySummary {
  return {
    repos: [],
    totalEvents: 0,
    pushCount: 0,
    prCount: 0,
    reviewCount: 0,
    distinctRepos7d: 0,
    hasForkOnlyActivity: false,
    prOpenedCount: 0,
    prTargetRepos7d: 0,
    prOpened24h: 0,
    prTargetRepos: [],
    prClosedNotMerged: 0,
    prMergedCount: 0,
    prRejectedRepos: 0,
    unsolicitedPrRatio: 0,
    unsolicitedPrRepoCount: 0,
    recentPrs: [],
  };
}

export function scoreContributorIdentity(
  profile: UserProfile,
  hasGpg: boolean = profile.hasGpgKeys,
  orgs: string[] = profile.orgs,
): [number, ContributorThreat[]] {
  const threats: ContributorThreat[] = [];
  const age = profile.accountAgeDays;
  let score =
    age == null ? 30 : age < 30 ? 10 : age < 90 ? 25 : age < 365 ? 40 : age < 1095 ? 65 : 85;

  if (profile.email) {
    const domain = profile.email.includes("@")
      ? profile.email.split("@").at(-1)?.toLowerCase()
      : undefined;
    score += domain && !FREE_EMAIL_DOMAINS.has(domain) ? 10 : 5;
  } else {
    score -= 5;
  }

  if (hasGpg) score += 10;
  score += Math.min(orgs.length * 10, 20);
  if (profile.company) score += 5;

  if (profile.followers >= 1000) {
    score += 10;
  } else if (profile.followers >= 100) {
    score += 5;
  } else if (profile.followers >= 10) {
    score += 3;
  }

  if ((profile.totalContributions ?? 0) >= 5000) {
    score += 10;
  } else if ((profile.totalContributions ?? 0) >= 1000) {
    score += 7;
  } else if ((profile.totalContributions ?? 0) >= 100) {
    score += 3;
  }

  if (profile.blog) score += 3;
  if (profile.xUsername) score += 3;
  if (profile.bio) score += 2;

  if (age != null && age < 30 && !hasGpg && orgs.length === 0) {
    threats.push({
      type: "malicious_new_account",
      severity: "high",
      detail: `Account is ${age} days old with no GPG keys and no org memberships`,
    });
  }

  return [clampScore(score), threats];
}

export function scoreContributorBehavior(
  summary: ActivitySummary,
  accountAgeDays?: number,
  now: Date = new Date(),
): [number, ContributorThreat[]] {
  const threats: ContributorThreat[] = [];
  let score = 80;
  const age = accountAgeDays ?? 0;

  if (age > 180 && summary.totalEvents > 20 && summary.totalEvents < 90 && summary.oldestEventAt) {
    const eventSpanDays = daysBetween(now, summary.oldestEventAt);
    if (eventSpanDays <= 7) {
      score -= 25;
      threats.push({
        type: "sleeper_account",
        severity: "medium",
        detail: `Account is ${age} days old but all ${summary.totalEvents} events are within the last ${eventSpanDays} day(s)`,
      });
    }
  }

  if (summary.distinctRepos7d > 10) score -= 20;

  if (summary.lastEventAt) {
    const daysSince = daysBetween(now, summary.lastEventAt);
    if (daysSince <= 30) {
      score += 10;
    } else if (daysSince <= 90) {
      score += 5;
    }
  }

  if (summary.hasForkOnlyActivity && age < 90) score -= 10;

  const prSprayThreshold = age > 365 && summary.totalEvents >= 50 ? 15 : age > 180 ? 10 : 5;
  if (summary.prOpened24h >= prSprayThreshold && summary.prTargetRepos7d >= 4) {
    score -= 20;
    threats.push({
      type: "pr_spray",
      severity: "medium",
      detail: `${summary.prOpened24h} PRs opened in the last 24 hours across ${summary.prTargetRepos7d} repositories`,
    });
  }

  if (summary.prTargetRepos7d >= 8) score -= 15;

  if (summary.unsolicitedPrRatio > 0.8 && summary.prOpenedCount >= 3) {
    score -= 25;
    threats.push({
      type: "unsolicited_pr_pattern",
      severity: "high",
      detail: `${Math.round(summary.unsolicitedPrRatio * 100)}% of PRs target repos with zero prior commit history (${summary.unsolicitedPrRepoCount} of ${summary.prTargetRepos.length} repos)`,
    });
  } else if (summary.unsolicitedPrRatio > 0.5 && summary.prOpenedCount >= 5) {
    score -= 15;
  }

  if (summary.prRejectedRepos >= 3) {
    score -= 20;
    threats.push({
      type: "pr_rejected_across_repos",
      severity: "medium",
      detail: `PRs closed without merge in ${summary.prRejectedRepos} distinct repos`,
    });
  }

  if (
    summary.prClosedNotMerged >= 5 &&
    summary.prMergedCount === 0 &&
    summary.unsolicitedPrRatio > 0
  ) {
    score -= 15;
    threats.push({
      type: "low_merge_rate",
      severity: "low",
      detail: `${summary.prClosedNotMerged} PRs closed without merge, 0 merged`,
    });
  }

  return [clampScore(score), threats];
}

export function scoreContributorContent(
  summary: ActivitySummary,
  unsolicitedPrRatio: number,
): [number, ContributorThreat[]] {
  const threats: ContributorThreat[] = [];
  let score = 100;

  if (summary.recentPrs.length === 0) {
    return [score, threats];
  }

  if (summary.prOpenedCount >= 3) {
    const emptyCount = summary.recentPrs.filter((pr) => pr.bodyLen < 20).length;
    if (emptyCount / summary.recentPrs.length > 0.6) {
      score -= 20;
    }
  }

  if (summary.prOpenedCount >= 5 && !summary.recentPrs.some((pr) => pr.hasIssueRef)) {
    score -= 15;
    threats.push({
      type: "no_issue_linkage",
      severity: "low",
      detail: `None of ${summary.prOpenedCount} recent PRs reference an issue`,
    });
  }

  if (unsolicitedPrRatio > 0.5) {
    const lowEffortCount = summary.recentPrs.filter((pr) => pr.bodyLen < 20).length;
    if (lowEffortCount >= 3) {
      score -= 25;
      threats.push({
        type: "low_effort_pr",
        severity: "medium",
        detail: `${lowEffortCount} PRs with minimal descriptions sent to unfamiliar repos`,
      });
    }
  }

  return [clampScore(score), threats];
}

export function scoreContributor(
  profile: UserProfile,
  activity: ActivitySummary,
  now: Date = new Date(),
): ContributorScoreResult {
  const [identity, identityThreats] = scoreContributorIdentity(
    profile,
    profile.hasGpgKeys,
    profile.orgs,
  );
  const [behavior, behaviorThreats] = scoreContributorBehavior(
    activity,
    profile.accountAgeDays,
    now,
  );
  const [content, contentThreats] = scoreContributorContent(
    activity,
    activity.unsolicitedPrRatio,
  );
  const dimensions = { identity, behavior, content };
  const score = compositeScore(dimensions);
  const confidence = capConfidenceForContributor(deriveConfidence(dimensions, score));

  return {
    dimensions,
    score,
    verdict: verdictForScore(score),
    confidence,
    threats: [...identityThreats, ...behaviorThreats, ...contentThreats],
  };
}

export function toContributorResult(
  login: string,
  scoreResult: ContributorScoreResult,
): ContributorResult {
  return {
    name: login,
    score: scoreResult.score,
    verdict: scoreResult.verdict,
    confidence: scoreResult.confidence,
    threats: scoreResult.threats,
    sub_scores: scoreResult.dimensions,
  };
}

export function compositeScore(dimensions: ContributorDimensions): number {
  return clampScore(
    Math.round(dimensions.identity * 0.35 + dimensions.behavior * 0.4 + dimensions.content * 0.25),
  );
}

export function verdictForScore(score: number): string {
  if (score >= 80) return "safe";
  if (score >= 50) return "caution";
  if (score >= 20) return "suspicious";
  return "dangerous";
}

export function deriveConfidence(dimensions: ContributorDimensions, score: number): string {
  if (
    score >= 85 &&
    dimensions.identity >= 75 &&
    dimensions.behavior >= 70 &&
    dimensions.content >= 75
  ) {
    return "high";
  }
  return score >= 45 ? "medium" : "low";
}

function capConfidenceForContributor(confidence: string): string {
  return confidence === "high" ? "medium" : confidence;
}

function clampScore(score: number): number {
  return Math.min(100, Math.max(0, score));
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY));
}
