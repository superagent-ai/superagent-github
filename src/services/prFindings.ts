import type { Octokit } from "octokit";
import { createHash } from "node:crypto";
import { MARKERS } from "../lib/types.js";

export interface PrReviewComment {
  id: number;
  body: string | null;
  in_reply_to_id?: number | null;
  path?: string;
  line?: number | null;
  user?: { login?: string; type?: string } | null;
  author_association?: string | null;
}

export function isPrFindingComment(body: string | null | undefined): boolean {
  return !!body?.includes(MARKERS.PR_FINDING) && !body.includes(MARKERS.PR_FINDING_ACK);
}

const FINGERPRINT_MARKER_RE =
  /<!--\s*superagent-finding-fingerprint:([a-f0-9]+)\s*-->/i;

export function fingerprintPrFindingCommentBody(
  body: string | null | undefined,
): string | undefined {
  if (!body) return undefined;

  const existing = body.match(FINGERPRINT_MARKER_RE)?.[1];
  if (existing) return existing;

  const normalized = body
    .replace(FINGERPRINT_MARKER_RE, "")
    .replace(MARKERS.PR_FINDING, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;

  return createHash("sha256").update(normalized).digest("hex");
}

export function appendPrFindingFingerprint(body: string, fingerprint: string): string {
  return `${body}\n\n<!-- superagent-finding-fingerprint:${fingerprint} -->`;
}

export async function listPrFindingComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PrReviewComment[]> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return comments.filter(
    (comment) => isPrFindingComment(comment.body) && comment.path && comment.line,
  );
}

export async function listAcknowledgedFindingCommentIds(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Set<number>> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const ids = new Set<number>();
  for (const comment of comments) {
    if (!comment.body?.includes(MARKERS.PR_FINDING_ACK)) continue;
    if (comment.in_reply_to_id != null) ids.add(comment.in_reply_to_id);
  }

  return ids;
}

export async function getReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
): Promise<PrReviewComment> {
  const { data } = await octokit.rest.pulls.getReviewComment({
    owner,
    repo,
    comment_id: commentId,
  });
  return data;
}

export async function resolveRootFindingComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  comment: PrReviewComment,
): Promise<PrReviewComment | null> {
  let current = comment;

  for (let depth = 0; depth < 20; depth++) {
    if (isPrFindingComment(current.body)) return current;
    if (!current.in_reply_to_id) break;
    current = await getReviewComment(octokit, owner, repo, current.in_reply_to_id);
  }

  return null;
}

export async function resolveFindingForUserReply(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  comment: PrReviewComment,
): Promise<PrReviewComment | null> {
  const fromThread = await resolveRootFindingComment(octokit, owner, repo, comment);
  if (fromThread) return fromThread;

  if (!comment.path) return null;

  const findings = await listPrFindingComments(octokit, owner, repo, prNumber);
  if (!findings.length) return null;

  if (comment.line != null) {
    const onSameLine = findings.find(
      (finding) => finding.path === comment.path && finding.line === comment.line,
    );
    if (onSameLine) return onSameLine;
  }

  return findings.find((finding) => finding.path === comment.path) ?? null;
}

export async function getReviewThreadIdForComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
): Promise<string | null> {
  const result = await octokit.graphql<{
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            comments: {
              nodes: Array<{ databaseId: number | null }>;
            };
          }>;
        };
      } | null;
    } | null;
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              id
              comments(first: 100) {
                nodes {
                  databaseId
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, number: prNumber },
  );

  const threads = result.repository?.pullRequest?.reviewThreads.nodes ?? [];
  const thread = threads.find((candidate) =>
    candidate.comments.nodes.some((comment) => comment.databaseId === commentId),
  );

  return thread?.id ?? null;
}

export async function listResolvedFindingCommentIds(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Set<number>> {
  const result = await octokit.graphql<{
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            isResolved: boolean;
            comments: {
              nodes: Array<{
                databaseId: number | null;
                body: string;
              }>;
            };
          }>;
        };
      } | null;
    } | null;
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            nodes {
              isResolved
              comments(first: 100) {
                nodes {
                  databaseId
                  body
                }
              }
            }
          }
        }
      }
    }`,
    { owner, repo, number: prNumber },
  );

  const ids = new Set<number>();
  const threads = result.repository?.pullRequest?.reviewThreads.nodes ?? [];

  for (const thread of threads) {
    if (!thread.isResolved) continue;
    const finding = thread.comments.nodes.find((comment) =>
      isPrFindingComment(comment.body),
    );
    if (finding?.databaseId != null) ids.add(finding.databaseId);
  }

  return ids;
}

export async function resolveFindingForReviewThread(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  thread: {
    id?: string | number | null;
    node_id?: string | null;
    path?: string | null;
    line?: number | null;
  },
): Promise<PrReviewComment | null> {
  const threadId =
    thread.node_id ??
    (typeof thread.id === "string" && thread.id.startsWith("PRRT_")
      ? thread.id
      : null);

  if (threadId) {
    const result = await octokit.graphql<{
      node: {
        comments?: {
          nodes: Array<{
            databaseId: number | null;
            body: string;
            path?: string | null;
            line?: number | null;
          }>;
        };
      } | null;
    }>(
      `query($threadId: ID!) {
        node(id: $threadId) {
          ... on PullRequestReviewThread {
            comments(first: 100) {
              nodes {
                databaseId
                body
                path
                line
              }
            }
          }
        }
      }`,
      { threadId },
    );

    const finding = result.node?.comments?.nodes.find((comment) =>
      isPrFindingComment(comment.body),
    );
    if (finding?.databaseId != null) {
      return {
        id: finding.databaseId,
        body: finding.body,
        path: finding.path ?? undefined,
        line: finding.line ?? undefined,
      };
    }
  }

  if (!thread.path) return null;

  const findings = await listPrFindingComments(octokit, owner, repo, prNumber);
  return (
    findings.find(
      (finding) => finding.path === thread.path && finding.line === thread.line,
    ) ??
    findings.find((finding) => finding.path === thread.path) ??
    null
  );
}
