import type { Octokit } from "octokit";

const TRUSTED_ASSOCIATIONS = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
]);

const TRUSTED_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export function isTrustedAssociation(authorAssociation?: string | null): boolean {
  return !!authorAssociation && TRUSTED_ASSOCIATIONS.has(authorAssociation);
}

export async function isTrustedRepoContributor(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    login: string;
    authorAssociation?: string | null;
  },
): Promise<boolean> {
  const { owner, repo, prNumber, login, authorAssociation } = params;

  if (isTrustedAssociation(authorAssociation)) return true;

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  if (pr.user?.login === login) return true;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: login,
    });
    return TRUSTED_PERMISSIONS.has(data.permission);
  } catch {
    return false;
  }
}
