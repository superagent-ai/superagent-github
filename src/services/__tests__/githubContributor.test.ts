import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  batchCheckCommitHistory,
  collectContributorSignals,
  fetchActivitySummary,
  fetchUserProfile,
  fetchUserOrgs,
} from "../githubContributor.js";

const NOW = new Date("2026-01-15T12:00:00.000Z");

describe("githubContributor", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a user profile through GitHub GraphQL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          user: {
            id: "U_1",
            login: "octocat",
            createdAt: "2020-01-01T00:00:00Z",
            repositories: { totalCount: 8 },
            followers: { totalCount: 42 },
            company: "GitHub",
            email: "octo@github.com",
            websiteUrl: "https://github.blog",
            bio: "Mona",
            twitterUsername: "octocat",
            contributionsCollection: {
              contributionCalendar: { totalContributions: 100 },
            },
            repositoriesContributedTo: { nodes: [{ nameWithOwner: "github/docs" }] },
            publicKeys: { totalCount: 1 },
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const profile = await fetchUserProfile("octocat", "ghs_token", NOW);

    expect(profile).toMatchObject({
      nodeId: "U_1",
      login: "octocat",
      publicRepos: 8,
      followers: 42,
      company: "GitHub",
      email: "octo@github.com",
      orgs: [],
      reposContributedTo: ["github/docs"],
      hasGpgKeys: true,
    });
    expect(profile.accountAgeDays).toBeGreaterThan(2000);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer ghs_token" }),
      }),
    );
  });

  it("fetches public orgs through REST separately from the profile query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ login: "github" }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUserOrgs("octocat", "ghs_token")).resolves.toEqual(["github"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/octocat/orgs",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghs_token" }),
      }),
    );
  });

  it("parses public activity and batches PR detail lookup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          event("PushEvent", "owner/repo", "2026-01-14T12:00:00Z"),
          prEvent("opened", "target/repo", 7, false, "2026-01-15T06:00:00Z"),
          prEvent("closed", "target2/repo", 8, false, "2026-01-12T00:00:00Z"),
          event("PullRequestReviewEvent", "review/repo", "2026-01-10T00:00:00Z"),
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            pr0: {
              pullRequest: {
                title: "Fix docs",
                body: "Fixes #123",
              },
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const activity = await fetchActivitySummary("octocat", "ghs_token", NOW);

    expect(activity.totalEvents).toBe(4);
    expect(activity.pushCount).toBe(1);
    expect(activity.prOpenedCount).toBe(1);
    expect(activity.prOpened24h).toBe(1);
    expect(activity.prClosedNotMerged).toBe(1);
    expect(activity.prRejectedRepos).toBe(1);
    expect(activity.prTargetRepos).toEqual(["target/repo"]);
    expect(activity.recentPrs).toEqual([
      { title: "Fix docs", bodyLen: 10, hasIssueRef: true, repo: "target/repo" },
    ]);
  });

  it("checks commit history with one GraphQL batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          repo0: { defaultBranchRef: { target: { history: { totalCount: 0 } } } },
          repo1: { defaultBranchRef: { target: { history: { totalCount: 4 } } } },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const counts = await batchCheckCommitHistory("U_1", [["a", "one"], ["b", "two"]], "token");

    expect(counts.get("a/one")).toBe(0);
    expect(counts.get("b/two")).toBe(4);
  });

  it("collects profile, activity, commits, and unsolicited PR ratio", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.endsWith("/graphql") && body.includes("user(login")) {
        return jsonResponse({
          data: {
            user: {
              id: "U_1",
              login: "octocat",
              createdAt: "2020-01-01T00:00:00Z",
              repositories: { totalCount: 1 },
              followers: { totalCount: 1 },
              contributionsCollection: {
                contributionCalendar: { totalContributions: 10 },
              },
              repositoriesContributedTo: { nodes: [] },
              publicKeys: { totalCount: 0 },
            },
          },
        });
      }
      if (url.includes("/search/commits")) {
        return jsonResponse({ total_count: 1234 });
      }
      if (url.includes("/users/octocat/orgs")) {
        return jsonResponse([{ login: "github" }]);
      }
      if (url.includes("/events/public")) {
        return jsonResponse([prEvent("opened", "target/repo", 7, false, "2026-01-15T06:00:00Z")]);
      }
      if (url.endsWith("/graphql") && body.includes("pullRequest")) {
        return jsonResponse({
          data: { pr0: { pullRequest: { title: "Fix typo", body: "" } } },
        });
      }
      if (url.endsWith("/graphql") && body.includes("history(author")) {
        return jsonResponse({
          data: { repo0: { defaultBranchRef: { target: { history: { totalCount: 0 } } } } },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const signals = await collectContributorSignals("octocat", { githubToken: "token" }, NOW);

    expect(signals.profile?.totalContributions).toBe(1234);
    expect(signals.profile?.orgs).toEqual(["github"]);
    expect(signals.activity.unsolicitedPrRatio).toBe(1);
    expect(signals.activity.unsolicitedPrRepoCount).toBe(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function event(type: string, repo: string, createdAt: string) {
  return {
    type,
    created_at: createdAt,
    repo: { name: repo },
    payload: {},
  };
}

function prEvent(
  action: string,
  repo: string,
  number: number,
  merged: boolean,
  createdAt: string,
) {
  return {
    type: "PullRequestEvent",
    created_at: createdAt,
    repo: { name: repo },
    payload: {
      action,
      pull_request: {
        number,
        merged,
        base: { repo: { full_name: repo } },
      },
    },
  };
}
