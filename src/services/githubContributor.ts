import {
  emptyActivitySummary,
  type ActivitySummary,
  type PrSummary,
  type UserProfile,
} from "../lib/contributorScoring.js";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "superagent-github/0.1";
const REQUEST_TIMEOUT_MS = 30_000;
const ISSUE_REF_RE = /#\d+/;

export interface ContributorSignals {
  profile?: UserProfile;
  activity: ActivitySummary;
}

export async function collectContributorSignals(
  login: string,
  options: { githubToken?: string } = {},
  now: Date = new Date(),
): Promise<ContributorSignals> {
  const profileResult = await Promise.allSettled([
    fetchUserProfile(login, options.githubToken, now),
    fetchUserOrgs(login, options.githubToken),
    fetchTotalCommitCount(login, options.githubToken),
    fetchActivitySummary(login, options.githubToken, now),
  ]);

  const [profileSettled, orgsSettled, commitCountSettled, activitySettled] = profileResult;
  if (profileSettled.status === "rejected") {
    return { activity: emptyActivitySummary() };
  }

  const profile = profileSettled.value;
  if (orgsSettled.status === "fulfilled") {
    profile.orgs = orgsSettled.value;
  }
  if (commitCountSettled.status === "fulfilled" && commitCountSettled.value != null) {
    profile.totalContributions = commitCountSettled.value;
  }

  let activity =
    activitySettled.status === "fulfilled" ? activitySettled.value : emptyActivitySummary();
  for (const repo of activity.repos) {
    if (!profile.reposContributedTo.includes(repo)) {
      profile.reposContributedTo.push(repo);
    }
  }

  if (profile.nodeId && activity.prTargetRepos.length > 0) {
    const repos = activity.prTargetRepos
      .slice(0, 10)
      .map(parseRepoIdentifier)
      .filter((repo): repo is [string, string] => repo != null);
    const commitCounts = await batchCheckCommitHistory(profile.nodeId, repos, options.githubToken);
    if (repos.length > 0) {
      const unsolicitedCount = repos.filter(([owner, repo]) => {
        return (commitCounts.get(`${owner}/${repo}`) ?? 0) === 0;
      }).length;
      activity = {
        ...activity,
        unsolicitedPrRatio: unsolicitedCount / repos.length,
        unsolicitedPrRepoCount: unsolicitedCount,
      };
    }
  }

  return { profile, activity };
}

export async function fetchUserProfile(
  login: string,
  githubToken?: string,
  now: Date = new Date(),
): Promise<UserProfile> {
  const query = `
    query($login: String!) {
      user(login: $login) {
        id
        login
        createdAt
        repositories(privacy: PUBLIC) { totalCount }
        followers { totalCount }
        company
        email
        websiteUrl
        bio
        twitterUsername
        contributionsCollection {
          contributionCalendar { totalContributions }
        }
        repositoriesContributedTo(first: 10, contributionTypes: COMMIT) {
          nodes { nameWithOwner }
        }
        publicKeys(first: 1) { totalCount }
      }
    }
  `;
  const data = await graphqlQuery<GqlUserData>(query, { login }, githubToken);
  if (!data.user) {
    throw new Error(`User ${login} not found`);
  }

  const user = data.user;
  const createdAt = parseDate(user.createdAt);
  const accountAgeDays = createdAt ? daysBetween(now, createdAt) : undefined;

  return {
    nodeId: user.id,
    login: user.login ?? login,
    accountAgeDays,
    publicRepos: user.repositories?.totalCount ?? 0,
    followers: user.followers?.totalCount ?? 0,
    company: optionalString(user.company),
    email: optionalString(user.email),
    blog: optionalString(user.websiteUrl),
    bio: optionalString(user.bio),
    xUsername: optionalString(user.twitterUsername),
    totalContributions:
      user.contributionsCollection?.contributionCalendar?.totalContributions,
    reposContributedTo:
      user.repositoriesContributedTo?.nodes
        ?.map((node) => node?.nameWithOwner)
        .filter((repo): repo is string => Boolean(repo)) ?? [],
    orgs: [],
    hasGpgKeys: (user.publicKeys?.totalCount ?? 0) > 0,
  };
}

export async function fetchUserOrgs(login: string, githubToken?: string): Promise<string[]> {
  const url = `${GITHUB_API}/users/${encodeURIComponent(login)}/orgs`;
  const response = await fetch(url, {
    headers: githubHeaders(githubToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return [];
  }

  const orgs = (await response.json()) as Array<{ login?: string }>;
  return Array.isArray(orgs)
    ? orgs.map((org) => org.login).filter((org): org is string => Boolean(org))
    : [];
}

export async function fetchActivitySummary(
  login: string,
  githubToken?: string,
  now: Date = new Date(),
): Promise<ActivitySummary> {
  const url = `${GITHUB_API}/users/${encodeURIComponent(login)}/events/public?per_page=100`;
  const response = await fetch(url, {
    headers: githubHeaders(githubToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return emptyActivitySummary();
  }

  const events = (await response.json()) as GitHubEvent[];
  if (!Array.isArray(events) || events.length === 0) {
    return emptyActivitySummary();
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const repos: string[] = [];
  const repos7d = new Set<string>();
  const prTargetRepos: string[] = [];
  const prTargetRepos7d = new Set<string>();
  const prRejectedRepos = new Set<string>();
  const prRefs: Array<[string, number]> = [];

  let pushCount = 0;
  let prCount = 0;
  let reviewCount = 0;
  let prOpenedCount = 0;
  let prOpened24h = 0;
  let prClosedNotMerged = 0;
  let prMergedCount = 0;
  let lastEventAt: Date | undefined;
  let oldestEventAt: Date | undefined;
  let hasUpstreamPr = false;

  for (const event of events) {
    const createdAt = parseDate(event.created_at);
    if (createdAt) {
      if (!lastEventAt || createdAt > lastEventAt) lastEventAt = createdAt;
      if (!oldestEventAt || createdAt < oldestEventAt) oldestEventAt = createdAt;
    }

    const repoName = event.repo?.name;
    if (event.type === "PushEvent") {
      pushCount += 1;
      addRepoSignals(repoName, createdAt, repos, repos7d, sevenDaysAgo);
      continue;
    }

    if (event.type === "PullRequestEvent") {
      prCount += 1;
      hasUpstreamPr = true;
      addRepoSignals(repoName, createdAt, repos, repos7d, sevenDaysAgo);

      const payload = event.payload ?? {};
      const action = typeof payload.action === "string" ? payload.action : "";
      const pr = payload.pull_request ?? {};
      const baseRepo =
        optionalString(pr.base?.repo?.full_name) ?? optionalString(repoName) ?? "";
      const prNumber = typeof pr.number === "number" ? pr.number : undefined;

      if (action === "opened") {
        prOpenedCount += 1;
        if (createdAt && createdAt > twentyFourHoursAgo) prOpened24h += 1;
        addUnique(prTargetRepos, baseRepo);
        if (baseRepo && createdAt && createdAt > sevenDaysAgo) {
          prTargetRepos7d.add(baseRepo);
        }
        if (baseRepo && prNumber != null && prRefs.length < 20) {
          prRefs.push([baseRepo, prNumber]);
        }
      } else if (action === "closed") {
        const merged = Boolean(pr.merged);
        if (merged) {
          prMergedCount += 1;
        } else {
          prClosedNotMerged += 1;
          if (baseRepo) prRejectedRepos.add(baseRepo);
        }
      }
      continue;
    }

    if (event.type === "PullRequestReviewEvent") {
      reviewCount += 1;
      hasUpstreamPr = true;
      addRepoSignals(repoName, createdAt, repos, repos7d, sevenDaysAgo);
    }
  }

  const recentPrs = await batchFetchPrDetails(prRefs, githubToken);

  return {
    repos,
    totalEvents: events.length,
    lastEventAt,
    oldestEventAt,
    pushCount,
    prCount,
    reviewCount,
    distinctRepos7d: repos7d.size,
    hasForkOnlyActivity: pushCount > 0 && !hasUpstreamPr && prCount === 0 && reviewCount === 0,
    prOpenedCount,
    prTargetRepos7d: prTargetRepos7d.size,
    prOpened24h,
    prTargetRepos,
    prClosedNotMerged,
    prMergedCount,
    prRejectedRepos: prRejectedRepos.size,
    unsolicitedPrRatio: 0,
    unsolicitedPrRepoCount: 0,
    recentPrs,
  };
}

export async function fetchTotalCommitCount(
  login: string,
  githubToken?: string,
): Promise<number | undefined> {
  const url = new URL(`${GITHUB_API}/search/commits`);
  url.searchParams.set("q", `author:${login}`);
  url.searchParams.set("per_page", "1");
  const response = await fetch(url, {
    headers: githubHeaders(githubToken),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    return undefined;
  }
  const body = (await response.json()) as { total_count?: number };
  return typeof body.total_count === "number" ? body.total_count : undefined;
}

export async function batchCheckCommitHistory(
  userNodeId: string,
  repos: Array<[string, string]>,
  githubToken?: string,
): Promise<Map<string, number>> {
  const results = new Map<string, number>();
  if (repos.length === 0) return results;

  const fragments = repos.map(([owner, repo], index) => {
    return `repo${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(author: { id: ${JSON.stringify(userNodeId)} }, first: 0) {
              totalCount
            }
          }
        }
      }
    }`;
  });

  try {
    const data = await graphqlQuery<Record<string, CommitHistoryNode>>(
      `query { ${fragments.join("\n")} }`,
      {},
      githubToken,
    );
    repos.forEach(([owner, repo], index) => {
      const totalCount =
        data[`repo${index}`]?.defaultBranchRef?.target?.history?.totalCount ?? 0;
      results.set(`${owner}/${repo}`, totalCount);
    });
  } catch {
    return results;
  }

  return results;
}

export async function batchFetchPrDetails(
  prRefs: Array<[string, number]>,
  githubToken?: string,
): Promise<PrSummary[]> {
  if (prRefs.length === 0) return [];

  const validRefs: Array<{ index: number; repoFull: string }> = [];
  const fragments = prRefs.flatMap(([repoFull, number], index) => {
    const parsed = parseRepoIdentifier(repoFull);
    if (!parsed) return [];
    const [owner, repo] = parsed;
    validRefs.push({ index, repoFull });
    return `pr${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
      pullRequest(number: ${number}) {
        title
        body
      }
    }`;
  });

  if (fragments.length === 0) return [];

  try {
    const data = await graphqlQuery<Record<string, PullRequestDetailNode>>(
      `query { ${fragments.join("\n")} }`,
      {},
      githubToken,
    );
    return validRefs.map(({ index, repoFull }) => {
      const pr = data[`pr${index}`]?.pullRequest;
      const title = pr?.title ?? "";
      const body = pr?.body ?? "";
      return {
        title,
        bodyLen: body.length,
        hasIssueRef: ISSUE_REF_RE.test(title) || ISSUE_REF_RE.test(body),
        repo: repoFull,
      };
    });
  } catch {
    return [];
  }
}

export function parseRepoIdentifier(repoFull: string): [string, string] | undefined {
  const parts = repoFull.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return [parts[0], parts[1]];
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  githubToken?: string,
): Promise<T> {
  const response = await fetch(`${GITHUB_API}/graphql`, {
    method: "POST",
    headers: {
      ...githubHeaders(githubToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL returned ${response.status}`);
  }

  const body = (await response.json()) as GqlResponse<T>;
  if (body.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("GitHub GraphQL response missing data");
  }
  return body.data;
}

function githubHeaders(githubToken?: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
    ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
  };
}

function addRepoSignals(
  repoName: string | undefined,
  createdAt: Date | undefined,
  repos: string[],
  repos7d: Set<string>,
  sevenDaysAgo: Date,
) {
  if (!repoName) return;
  addUnique(repos, repoName);
  if (createdAt && createdAt > sevenDaysAgo) repos7d.add(repoName);
}

function addUnique(values: string[], value: string) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? undefined : new Date(millis);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000)));
}

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface GqlUserData {
  user?: {
    id?: string;
    login?: string;
    createdAt?: string;
    repositories?: { totalCount?: number };
    followers?: { totalCount?: number };
    company?: string | null;
    email?: string | null;
    websiteUrl?: string | null;
    bio?: string | null;
    twitterUsername?: string | null;
    organizations?: { nodes?: Array<{ login?: string } | null> };
    contributionsCollection?: {
      contributionCalendar?: { totalContributions?: number };
    };
    repositoriesContributedTo?: { nodes?: Array<{ nameWithOwner?: string } | null> };
    publicKeys?: { totalCount?: number };
  } | null;
}

interface GitHubEvent {
  type?: string;
  created_at?: string;
  repo?: { name?: string };
  payload?: {
    action?: string;
    pull_request?: {
      number?: number;
      merged?: boolean;
      base?: { repo?: { full_name?: string } };
    };
  };
}

interface CommitHistoryNode {
  defaultBranchRef?: {
    target?: {
      history?: { totalCount?: number };
    };
  } | null;
}

interface PullRequestDetailNode {
  pullRequest?: {
    title?: string;
    body?: string;
  } | null;
}
