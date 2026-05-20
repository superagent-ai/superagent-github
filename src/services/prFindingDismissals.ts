import { queries } from "../lib/db.js";

export function dismissPrFinding(params: {
  owner: string;
  repo: string;
  prNumber: number;
  reviewCommentId: number;
  dismissedBy: string;
  headSha: string;
}): void {
  queries.dismissPrFinding.run(params);
}

export function isPrFindingDismissed(
  owner: string,
  repo: string,
  prNumber: number,
  reviewCommentId: number,
): boolean {
  return !!queries.isPrFindingDismissed.get({
    owner,
    repo,
    prNumber,
    reviewCommentId,
  });
}

export function clearPrFindingDismissals(
  owner: string,
  repo: string,
  prNumber: number,
): void {
  queries.clearPrFindingDismissals.run({ owner, repo, prNumber });
}
