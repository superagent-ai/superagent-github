import type { Octokit } from "octokit";
import { childLogger } from "../lib/logger.js";
import { handleFindingThreadResolved } from "../services/findingDismissal.js";

export async function handlePullRequestReviewThread({
  octokit,
  payload,
}: {
  octokit: Octokit;
  payload: Record<string, unknown>;
}) {
  if (payload.action !== "resolved") return;

  const thread = payload.thread as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const sender = payload.sender as { login?: string; type?: string } | null;
  if (!thread || !pullRequest || !repository) return;

  const owner = (repository.owner as { login?: string })?.login;
  const repo = repository.name as string | undefined;
  const prNumber = pullRequest.number as number | undefined;
  if (!owner || !repo || prNumber == null) return;

  const log = childLogger({
    event: "pull_request_review_thread",
    action: payload.action,
    owner,
    repo,
    pr: prNumber,
    threadId: thread.node_id ?? thread.id,
  });

  try {
    await handleFindingThreadResolved(octokit, {
      owner,
      repo,
      prNumber,
      thread: {
        id: thread.id as string | number | null,
        node_id: (thread.node_id as string | null) ?? null,
        path: (thread.path as string | null) ?? null,
        line: (thread.line as number | null) ?? null,
      },
      sender,
    });
  } catch (err) {
    log.error({ err }, "Failed to handle resolved review thread");
    throw err;
  }
}
