import type { Octokit } from "octokit";
import {
  handleFindingReply,
  reconcilePrScanAfterDismissals,
} from "../services/findingDismissal.js";
import { childLogger } from "../lib/logger.js";

export async function handlePullRequestReviewComment({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: Record<string, unknown>;
}) {
  if (payload.action !== "created") return;

  const comment = payload.comment as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (!comment || !pullRequest || !repository) return;

  const owner = (repository.owner as { login?: string })?.login;
  const repo = repository.name as string | undefined;
  const prNumber = pullRequest.number as number | undefined;
  if (!owner || !repo || prNumber == null) return;

  const log = childLogger({
    event: "pull_request_review_comment",
    owner,
    repo,
    pr: prNumber,
    commentId: comment.id,
  });

  try {
    await handleFindingReply(octokit, {
      owner,
      repo,
      prNumber,
      comment: {
        id: comment.id as number,
        body: (comment.body as string | null) ?? null,
        in_reply_to_id: (comment.in_reply_to_id as number | null) ?? null,
        path: comment.path as string | undefined,
        line: (comment.line as number | null) ?? null,
        user: comment.user as { login?: string; type?: string } | null,
        author_association: (comment.author_association as string | null) ?? null,
      },
    });
  } catch (err) {
    log.error({ err }, "Failed to handle finding reply");
    throw err;
  }

  try {
    await reconcilePrScanAfterDismissals(octokit, { owner, repo, prNumber });
  } catch (err) {
    log.warn({ err }, "Failed to reconcile PR scan after review comment");
  }
}
