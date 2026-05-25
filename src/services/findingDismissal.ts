import type { Octokit } from "octokit";
import { evaluateFindingDismissal } from "../lib/dismissalEval.js";
import { childLogger } from "../lib/logger.js";
import { CHECK_NAMES, LABEL_DEFS, MARKERS } from "../lib/types.js";
import { completeCheck } from "./checkRuns.js";
import { loadConfig } from "./config.js";
import {
  getReviewThreadIdForComment,
  fingerprintPrFindingCommentBody,
  listAcknowledgedFindingCommentIds,
  listPrFindingComments,
  listResolvedFindingCommentIds,
  resolveFindingForUserReply,
  resolveFindingForReviewThread,
  type PrReviewComment,
} from "./prFindings.js";
import {
  dismissPrFinding,
  isPrFindingDismissed,
} from "./prFindingDismissals.js";
import { ensureLabels, setLabel } from "./labels.js";
import { isTrustedRepoContributor } from "./trustedContributor.js";

const PR_LABELS = [LABEL_DEFS.PR_VERIFIED, LABEL_DEFS.PR_FLAGGED];
const PR_LABEL_NAMES = PR_LABELS.map((l) => l.name);

const NEED_MORE_DETAIL_REPLY =
  "Thanks for the reply. I still need a bit more context on why this finding is acceptable before I can clear it. Could you expand on the intent or risk?";

function isBotUser(user: PrReviewComment["user"]): boolean {
  return user?.type === "Bot" || !!user?.login?.endsWith("[bot]");
}

export async function handleFindingReply(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    comment: PrReviewComment;
  },
): Promise<void> {
  const { owner, repo, prNumber, comment } = params;
  const log = childLogger({
    service: "finding-dismissal",
    owner,
    repo,
    pr: prNumber,
    commentId: comment.id,
  });

  if (isBotUser(comment.user)) return;

  const config = await loadConfig(octokit, owner, repo);
  if (!config.prScan.enabled) return;

  const rootFinding = await resolveFindingForUserReply(
    octokit,
    owner,
    repo,
    prNumber,
    comment,
  );
  if (!rootFinding) {
    log.info("Reply is not on a Superagent finding thread");
    return;
  }
  if (isPrFindingDismissed(owner, repo, prNumber, rootFinding.id)) {
    log.info({ findingCommentId: rootFinding.id }, "Finding already dismissed");
    await reconcilePrScanAfterDismissals(octokit, { owner, repo, prNumber });
    return;
  }

  await addEyesReaction(octokit, owner, repo, comment.id, log);

  const login = comment.user?.login ?? "";
  const trusted = login
    ? await isTrustedRepoContributor(octokit, {
        owner,
        repo,
        prNumber,
        login,
        authorAssociation: comment.author_association,
      })
    : false;

  const evaluation = await evaluateFindingDismissal(
    rootFinding.body ?? "",
    comment.body ?? "",
    { trustedContributor: trusted },
  );

  if (trusted && !evaluation) {
    log.info({ login }, "Trusted contributor reply; dismissing with fallback acknowledgment");
    await dismissFinding(octokit, {
      owner,
      repo,
      prNumber,
      rootFindingId: rootFinding.id,
      rootFindingBody: rootFinding.body,
      replyToCommentId: comment.id,
      dismissedBy: login || "unknown",
      acknowledgment: "Got it, thanks for the context.",
    });
    await reconcilePrScanAfterDismissals(octokit, { owner, repo, prNumber });
    return;
  }

  if (evaluation?.dismiss) {
    await dismissFinding(octokit, {
      owner,
      repo,
      prNumber,
      rootFindingId: rootFinding.id,
      rootFindingBody: rootFinding.body,
      replyToCommentId: comment.id,
      dismissedBy: login || "unknown",
      acknowledgment: evaluation.acknowledgment,
    });
    log.info({ findingCommentId: rootFinding.id }, "Dismissed finding after reply");
    await reconcilePrScanAfterDismissals(octokit, { owner, repo, prNumber });
    return;
  }

  const followUp =
    evaluation?.acknowledgment?.trim() || NEED_MORE_DETAIL_REPLY;
  await postFindingReply(octokit, {
    owner,
    repo,
    prNumber,
    rootFindingId: rootFinding.id,
    replyToCommentId: comment.id,
    body: followUp,
  });
  log.info("Replied on finding thread without dismissing");
}

export async function handleFindingThreadResolved(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    thread: {
      id?: string | number | null;
      node_id?: string | null;
      path?: string | null;
      line?: number | null;
    };
    sender: { login?: string; type?: string } | null;
  },
): Promise<void> {
  const { owner, repo, prNumber, thread, sender } = params;
  const log = childLogger({
    service: "finding-dismissal",
    owner,
    repo,
    pr: prNumber,
    threadId: thread.node_id ?? thread.id,
  });

  if (isBotUser(sender)) return;

  const config = await loadConfig(octokit, owner, repo);
  if (!config.prScan.enabled) return;

  const login = sender?.login ?? "";
  const trusted = login
    ? await isTrustedRepoContributor(octokit, {
        owner,
        repo,
        prNumber,
        login,
      })
    : false;
  if (!trusted) {
    log.info({ login }, "Ignoring resolved thread from untrusted user");
    return;
  }

  const rootFinding = await resolveFindingForReviewThread(
    octokit,
    owner,
    repo,
    prNumber,
    thread,
  );
  if (!rootFinding) {
    log.info("Resolved thread is not a Superagent finding");
    return;
  }

  if (isPrFindingDismissed(owner, repo, prNumber, rootFinding.id)) {
    await reconcilePrScanAfterDismissals(octokit, { owner, repo, prNumber });
    return;
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  dismissPrFinding({
    owner,
    repo,
    prNumber,
    reviewCommentId: rootFinding.id,
    findingFingerprint: fingerprintPrFindingCommentBody(rootFinding.body),
    dismissedBy: login || "unknown",
    headSha: pr.head.sha,
  });

  log.info(
    { login, findingCommentId: rootFinding.id },
    "Dismissed finding from resolved thread",
  );
  await reconcilePrScanAfterDismissals(octokit, {
    owner,
    repo,
    prNumber,
    headSha: pr.head.sha,
  });
}

async function dismissFinding(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    rootFindingId: number;
    rootFindingBody: string | null;
    replyToCommentId: number;
    dismissedBy: string;
    acknowledgment: string;
  },
): Promise<void> {
  const {
    owner,
    repo,
    prNumber,
    rootFindingId,
    rootFindingBody,
    replyToCommentId,
    dismissedBy,
    acknowledgment,
  } = params;

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  dismissPrFinding({
    owner,
    repo,
    prNumber,
    reviewCommentId: rootFindingId,
    findingFingerprint: fingerprintPrFindingCommentBody(rootFindingBody),
    dismissedBy,
    headSha: pr.head.sha,
  });

  await postFindingReply(octokit, {
    owner,
    repo,
    prNumber,
    rootFindingId,
    replyToCommentId,
    body: acknowledgment,
  });
}

async function postFindingReply(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    rootFindingId: number;
    replyToCommentId: number;
    body: string;
  },
): Promise<void> {
  const body = `${params.body}\n\n${MARKERS.PR_FINDING_ACK}`;

  try {
    await octokit.rest.pulls.createReviewComment({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      body,
      in_reply_to: params.rootFindingId,
    } as Parameters<typeof octokit.rest.pulls.createReviewComment>[0]);
    return;
  } catch {
    // Fall back to the dedicated REST reply endpoint below.
  }

  try {
    await octokit.rest.pulls.createReplyForReviewComment({
      owner: params.owner,
      repo: params.repo,
      pull_number: params.prNumber,
      comment_id: params.rootFindingId,
      body,
    });
    return;
  } catch {
    // Fall back to GraphQL review-thread replies below.
  }

  const threadId = await getReviewThreadIdForComment(
    octokit,
    params.owner,
    params.repo,
    params.prNumber,
    params.rootFindingId,
  );

  if (!threadId) throw new Error("Unable to resolve review thread for finding reply");

  await octokit.graphql(
    `mutation($threadId: ID!, $body: String!) {
      addPullRequestReviewThreadReply(input: {
        pullRequestReviewThreadId: $threadId,
        body: $body
      }) {
        comment {
          id
        }
      }
    }`,
    {
      threadId,
      body,
    },
  );
}

export async function reconcilePrScanAfterDismissals(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha?: string;
  },
): Promise<void> {
  const { owner, repo, prNumber } = params;
  const log = childLogger({ service: "finding-dismissal", owner, repo, pr: prNumber });
  const currentHeadSha =
    params.headSha ??
    (
      await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      })
    ).data.head.sha;

  const findings = await persistReviewedFindingDismissals(octokit, {
    owner,
    repo,
    prNumber,
    headSha: currentHeadSha,
  });
  if (findings.length === 0) return;

  const openFindings = findings.filter(
    (finding) => !isPrFindingDismissed(owner, repo, prNumber, finding.id),
  );

  if (openFindings.length > 0) {
    log.info(
      {
        open: openFindings.length,
        total: findings.length,
      },
      "Findings still open",
    );
    return;
  }

  const { data: checkRuns } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: currentHeadSha,
    check_name: CHECK_NAMES.PR_SCAN,
  });
  const checkRun = checkRuns.check_runs.find((run) => run.name === CHECK_NAMES.PR_SCAN);
  if (!checkRun) {
    log.warn({ headSha: currentHeadSha }, "No PR scan check run found to update");
    return;
  }

  await completeCheck(octokit, owner, repo, checkRun.id, "success", {
    title: "PR scan passed",
    summary: "All reported findings were reviewed and dismissed.",
  });

  await ensureLabels(octokit, owner, repo, PR_LABELS);
  await setLabel(octokit, owner, repo, prNumber, LABEL_DEFS.PR_VERIFIED.name, PR_LABEL_NAMES);
  log.info({ dismissed: findings.length }, "PR scan check cleared after dismissals");
  cancelDismissalReconcile(owner, repo, prNumber);
}

export async function persistReviewedFindingDismissals(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
  },
): Promise<PrReviewComment[]> {
  const { owner, repo, prNumber, headSha } = params;
  const log = childLogger({ service: "finding-dismissal", owner, repo, pr: prNumber });
  const findings = await listPrFindingComments(octokit, owner, repo, prNumber);
  if (findings.length === 0) return findings;

  const dismissedFindingIds = new Set<number>();
  try {
    for (const id of await listAcknowledgedFindingCommentIds(octokit, owner, repo, prNumber)) {
      dismissedFindingIds.add(id);
    }
  } catch (err) {
    log.warn({ err }, "Failed to load acknowledged finding replies");
  }

  let resolvedFindingIds = new Set<number>();
  try {
    resolvedFindingIds = await listResolvedFindingCommentIds(
      octokit,
      owner,
      repo,
      prNumber,
    );
  } catch (err) {
    log.warn({ err }, "Failed to load resolved review threads");
  }

  for (const finding of findings) {
    if (!dismissedFindingIds.has(finding.id) && !resolvedFindingIds.has(finding.id)) {
      continue;
    }
    dismissPrFinding({
      owner,
      repo,
      prNumber,
      reviewCommentId: finding.id,
      findingFingerprint: fingerprintPrFindingCommentBody(finding.body),
      dismissedBy: "reviewed-thread",
      headSha: finding.commit_id ?? headSha,
    });
  }

  return findings;
}

const scheduledReconcileTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

/** Poll GitHub for resolved threads when the review-thread webhook is not subscribed. */
const RECONCILE_POLL_DELAYS_MS = [8_000, 25_000, 75_000, 180_000];

export function scheduleDismissalReconcile(
  octokit: Octokit,
  params: { owner: string; repo: string; prNumber: number; headSha: string },
): void {
  const key = `${params.owner}/${params.repo}#${params.prNumber}`;
  const existing = scheduledReconcileTimers.get(key);
  if (existing) {
    for (const timer of existing) clearTimeout(timer);
  }

  const timers = RECONCILE_POLL_DELAYS_MS.map((delayMs) =>
    setTimeout(() => {
      void reconcilePrScanAfterDismissals(octokit, params).catch((err) => {
        childLogger({
          service: "finding-dismissal",
          owner: params.owner,
          repo: params.repo,
          pr: params.prNumber,
        }).warn({ err, delayMs }, "Scheduled dismissal reconcile failed");
      });
    }, delayMs),
  );

  scheduledReconcileTimers.set(key, timers);
}

export function cancelDismissalReconcile(
  owner: string,
  repo: string,
  prNumber: number,
): void {
  const key = `${owner}/${repo}#${prNumber}`;
  const timers = scheduledReconcileTimers.get(key);
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  scheduledReconcileTimers.delete(key);
}

async function addEyesReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  log: ReturnType<typeof childLogger>,
): Promise<void> {
  try {
    await octokit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (err) {
    log.warn({ err, commentId }, "Failed to add eyes reaction to dismiss reply");
  }
}
