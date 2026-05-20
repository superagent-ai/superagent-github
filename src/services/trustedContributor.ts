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
  const { owner, repo, login, authorAssociation } = params;

  if (isTrustedAssociation(authorAssociation)) return true;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username: login,
    });
    if (TRUSTED_PERMISSIONS.has(data.permission)) return true;
  } catch {
    // Public contributors are not always collaborators, so fall through.
  }

  try {
    const contributors = await octokit.paginate(octokit.rest.repos.listContributors, {
      owner,
      repo,
      per_page: 100,
    });
    return contributors.some((contributor) => contributor.login === login);
  } catch {
    return false;
  }
}
