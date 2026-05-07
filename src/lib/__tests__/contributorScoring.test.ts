import { describe, expect, it } from "vitest";
import {
  compositeScore,
  emptyActivitySummary,
  scoreContributor,
  scoreContributorBehavior,
  scoreContributorContent,
  scoreContributorIdentity,
  verdictForScore,
  type ActivitySummary,
  type PrSummary,
  type UserProfile,
} from "../contributorScoring.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function profile(ageDays?: number, email?: string): UserProfile {
  return {
    login: "testuser",
    accountAgeDays: ageDays,
    publicRepos: 10,
    followers: 50,
    email,
    reposContributedTo: [],
    orgs: [],
    hasGpgKeys: false,
  };
}

function activity(
  totalEvents: number,
  lastEventDaysAgo: number | undefined,
  oldestEventDaysAgo: number | undefined,
  distinctRepos7d: number,
  hasForkOnly: boolean,
): ActivitySummary {
  return {
    ...emptyActivitySummary(),
    repos: ["owner/repo"],
    totalEvents,
    lastEventAt:
      lastEventDaysAgo == null
        ? undefined
        : new Date(NOW.getTime() - lastEventDaysAgo * MS_PER_DAY),
    oldestEventAt:
      oldestEventDaysAgo == null
        ? undefined
        : new Date(NOW.getTime() - oldestEventDaysAgo * MS_PER_DAY),
    pushCount: totalEvents,
    prCount: hasForkOnly ? 0 : 1,
    distinctRepos7d,
    hasForkOnlyActivity: hasForkOnly,
  };
}

describe("contributor identity scoring", () => {
  it("scores established contributors high", () => {
    const p = profile(2000, "user@example.com");
    const [score, threats] = scoreContributorIdentity(p, true, ["rust-lang", "tokio-rs"]);
    expect(score).toBe(100);
    expect(threats).toEqual([]);
  });

  it("flags new accounts with no trust signals", () => {
    const [score, threats] = scoreContributorIdentity(profile(5), false, []);
    expect(score).toBe(8);
    expect(threats).toHaveLength(1);
    expect(threats[0]?.type).toBe("malicious_new_account");
  });

  it("caps org bonus and distinguishes corporate email", () => {
    const manyOrgs = Array.from({ length: 5 }, (_, i) => `org-${i}`);
    const [orgScore] = scoreContributorIdentity(profile(400, "dev@gmail.com"), false, manyOrgs);
    const [freeScore] = scoreContributorIdentity(profile(1000, "dev@gmail.com"));
    const [corpScore] = scoreContributorIdentity(profile(1000, "dev@acme.co"));

    expect(orgScore).toBe(93);
    expect(freeScore).toBe(73);
    expect(corpScore).toBe(78);
  });

  it("counts profile metadata and contribution volume bonuses", () => {
    const p = profile(4000, "dev@company.io");
    p.company = "Company Inc";
    p.followers = 5000;
    p.totalContributions = 20000;
    p.blog = "https://dev.company.io";
    p.xUsername = "devhandle";
    p.bio = "Staff engineer";

    const [score, threats] = scoreContributorIdentity(p, true, ["rust-lang"]);
    expect(score).toBe(100);
    expect(threats).toEqual([]);
  });
});

describe("contributor behavior scoring", () => {
  it("scores normal active contributors high", () => {
    const [score, threats] = scoreContributorBehavior(
      activity(30, 1, 60, 3, false),
      1000,
      NOW,
    );
    expect(score).toBe(90);
    expect(threats).toEqual([]);
  });

  it("detects dormant accounts with a narrow activity spike", () => {
    const [score, threats] = scoreContributorBehavior(
      activity(25, 0, 5, 4, false),
      365,
      NOW,
    );
    expect(score).toBe(65);
    expect(threats[0]?.type).toBe("sleeper_account");
  });

  it("penalizes cross-repo velocity and fork-only activity", () => {
    const [velocityScore] = scoreContributorBehavior(activity(50, 1, 30, 12, false), 500, NOW);
    const [forkOnlyScore] = scoreContributorBehavior(activity(10, 2, 20, 2, true), 30, NOW);

    expect(velocityScore).toBe(70);
    expect(forkOnlyScore).toBe(80);
  });

  it("detects PR spray, unsolicited PRs, rejected PRs, and low merge rate", () => {
    const spray = activity(10, 0, 1, 5, false);
    spray.prOpened24h = 7;
    spray.prOpenedCount = 7;
    spray.prTargetRepos7d = 5;
    expect(scoreContributorBehavior(spray, 90, NOW)[1].some((t) => t.type === "pr_spray"))
      .toBe(true);

    const unsolicited = activity(10, 0, 7, 3, false);
    unsolicited.prOpenedCount = 5;
    unsolicited.unsolicitedPrRatio = 0.9;
    unsolicited.unsolicitedPrRepoCount = 4;
    unsolicited.prTargetRepos = ["a/1", "b/2", "c/3", "d/4", "e/5"];
    expect(scoreContributorBehavior(unsolicited, 200, NOW)[0]).toBe(65);

    const rejected = activity(10, 0, 7, 3, false);
    rejected.prRejectedRepos = 4;
    rejected.prClosedNotMerged = 4;
    expect(scoreContributorBehavior(rejected, 200, NOW)[1].some((t) => t.type === "pr_rejected_across_repos"))
      .toBe(true);

    const lowMerge = activity(10, 0, 7, 3, false);
    lowMerge.prClosedNotMerged = 6;
    lowMerge.unsolicitedPrRatio = 0.5;
    expect(scoreContributorBehavior(lowMerge, 200, NOW)[1].some((t) => t.type === "low_merge_rate"))
      .toBe(true);
  });
});

describe("contributor content scoring", () => {
  it("keeps content at 100 when there are no recent PRs", () => {
    expect(scoreContributorContent(emptyActivitySummary(), 0)).toEqual([100, []]);
  });

  it("penalizes empty bodies and missing issue linkage", () => {
    const prs: PrSummary[] = [0, 5, 10, 2, 3].map((bodyLen, index) => ({
      title: `fix: typo ${index}`,
      bodyLen,
      hasIssueRef: false,
      repo: `a/${index}`,
    }));
    const summary = { ...emptyActivitySummary(), prOpenedCount: 5, recentPrs: prs };

    const [score, threats] = scoreContributorContent(summary, 0);
    expect(score).toBe(65);
    expect(threats.some((t) => t.type === "no_issue_linkage")).toBe(true);
  });

  it("penalizes low effort PRs to unfamiliar repos", () => {
    const summary = {
      ...emptyActivitySummary(),
      prOpenedCount: 4,
      recentPrs: [1, 2, 3, 80].map((bodyLen, index) => ({
        title: `fix: ${index}`,
        bodyLen,
        hasIssueRef: index === 3,
        repo: `a/${index}`,
      })),
    };

    const [score, threats] = scoreContributorContent(summary, 0.75);
    expect(score).toBe(55);
    expect(threats.some((t) => t.type === "low_effort_pr")).toBe(true);
  });
});

describe("contributor composite scoring", () => {
  it("uses only identity, behavior, and content weights", () => {
    expect(compositeScore({ identity: 90, behavior: 80, content: 70 })).toBe(81);
  });

  it("uses conservative verdict boundaries", () => {
    expect(verdictForScore(80)).toBe("safe");
    expect(verdictForScore(79)).toBe("caution");
    expect(verdictForScore(49)).toBe("suspicious");
    expect(verdictForScore(19)).toBe("dangerous");
  });

  it("caps high confidence because contributor graph is not used", () => {
    const p = profile(4000, "dev@company.io");
    p.followers = 5000;
    p.totalContributions = 20000;
    p.orgs = ["rust-lang", "tokio-rs"];
    p.hasGpgKeys = true;
    const result = scoreContributor(p, activity(30, 1, 60, 3, false), NOW);

    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.confidence).toBe("medium");
  });
});
