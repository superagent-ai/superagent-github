import { describe, expect, it, vi } from "vitest";
import {
  isTrustedAssociation,
  isTrustedRepoContributor,
} from "../trustedContributor.js";

describe("isTrustedAssociation", () => {
  it("trusts repository contributors and maintainers", () => {
    expect(isTrustedAssociation("OWNER")).toBe(true);
    expect(isTrustedAssociation("MEMBER")).toBe(true);
    expect(isTrustedAssociation("COLLABORATOR")).toBe(true);
    expect(isTrustedAssociation("CONTRIBUTOR")).toBe(true);
  });

  it("does not trust first-time authors", () => {
    expect(isTrustedAssociation("NONE")).toBe(false);
    expect(isTrustedAssociation("FIRST_TIMER")).toBe(false);
    expect(isTrustedAssociation("FIRST_TIME_CONTRIBUTOR")).toBe(false);
    expect(isTrustedAssociation(undefined)).toBe(false);
  });
});

describe("isTrustedRepoContributor", () => {
  function mockOctokit(options?: {
    permission?: string;
    permissionError?: boolean;
    contributors?: Array<{ login?: string }>;
  }) {
    return {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: vi.fn().mockImplementation(() => {
            if (options?.permissionError) throw new Error("not a collaborator");
            return Promise.resolve({
              data: { permission: options?.permission ?? "read" },
            });
          }),
          listContributors: vi.fn(),
        },
      },
      paginate: vi.fn().mockResolvedValue(options?.contributors ?? []),
    } as any;
  }

  it("does not trust a first-time PR author by ownership alone", async () => {
    const octokit = mockOctokit({
      permission: "read",
      contributors: [],
    });

    await expect(
      isTrustedRepoContributor(octokit, {
        owner: "acme",
        repo: "repo",
        prNumber: 1,
        login: "first-timer",
        authorAssociation: "FIRST_TIME_CONTRIBUTOR",
      }),
    ).resolves.toBe(false);

    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalled();
    expect(octokit.paginate).toHaveBeenCalled();
  });

  it("trusts prior contributors even without write permission", async () => {
    const octokit = mockOctokit({
      permission: "read",
      contributors: [{ login: "prior-contributor" }],
    });

    await expect(
      isTrustedRepoContributor(octokit, {
        owner: "acme",
        repo: "repo",
        prNumber: 1,
        login: "prior-contributor",
        authorAssociation: "FIRST_TIME_CONTRIBUTOR",
      }),
    ).resolves.toBe(true);
  });

  it("trusts users with write-level repository permissions", async () => {
    const octokit = mockOctokit({ permission: "write" });

    await expect(
      isTrustedRepoContributor(octokit, {
        owner: "acme",
        repo: "repo",
        prNumber: 1,
        login: "maintainer",
      }),
    ).resolves.toBe(true);

    expect(octokit.paginate).not.toHaveBeenCalled();
  });
});
