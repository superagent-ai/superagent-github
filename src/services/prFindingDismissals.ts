import { queries } from "../lib/db.js";

export function dismissPrFinding(params: {
  owner: string;
  repo: string;
  prNumber: number;
  reviewCommentId: number;
  findingFingerprint?: string | null;
  dismissedBy: string;
  headSha: string;
}): void {
  queries.dismissPrFinding.run({
    ...params,
    findingFingerprint: params.findingFingerprint ?? null,
  });
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

export function isPrFindingFingerprintDismissed(
  owner: string,
  repo: string,
  prNumber: number,
  findingFingerprint: string,
  headSha: string,
): boolean {
  return !!queries.isPrFindingFingerprintDismissed.get({
    owner,
    repo,
    prNumber,
    findingFingerprint,
    headSha,
  });
}

export function clearPrFindingDismissals(
  owner: string,
  repo: string,
  prNumber: number,
): void {
  queries.clearPrFindingDismissals.run({ owner, repo, prNumber });
}
