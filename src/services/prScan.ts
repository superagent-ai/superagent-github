import type { Octokit } from "octokit";
import type { PrFinding, RepoConfig } from "../lib/types.js";
import { formatFindingPriority } from "../lib/findingPriority.js";
import { CHECK_NAMES, MARKERS, LABEL_DEFS } from "../lib/types.js";
import { evaluatePrScan } from "../lib/policy.js";
import { createInProgressCheck, completeCheck } from "./checkRuns.js";
import { deleteMarkerComment } from "./comments.js";
import { getGitHubToken } from "./githubToken.js";
import { scanPrLocally } from "./prScanner.js";
import { clearPrFindingDismissals } from "./prFindingDismissals.js";
import { scheduleDismissalReconcile } from "./findingDismissal.js";
import { clearLabels, ensureLabels, setLabel } from "./labels.js";
import { childLogger } from "../lib/logger.js";

const PR_LABELS = [LABEL_DEFS.PR_VERIFIED, LABEL_DEFS.PR_FLAGGED];
const PR_LABEL_NAMES = PR_LABELS.map((l) => l.name);
const MAX_INLINE_COMMENTS = 50;

export async function runPrScan(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    config: RepoConfig;
  },
): Promise<void> {
  const { owner, repo, prNumber, headSha, config } = params;
  const log = childLogger({ service: "pr-scan", owner, repo, pr: prNumber });

  if (!config.prScan.enabled) {
    log.info("PR scan disabled by repo config");
    return;
  }

  const checkRunId = await createInProgressCheck(
    octokit,
    owner,
    repo,
    headSha,
    CHECK_NAMES.PR_SCAN,
  );

  const githubToken = await getGitHubToken(octokit);
  const result = await scanPrLocally(owner, repo, prNumber, { githubToken });
  const { status, shouldFail } = evaluatePrScan(result, config);

  log.info(
    { findings: result.findings?.length ?? 0, status, shouldFail },
    "PR scan evaluated",
  );

  await ensureLabels(octokit, owner, repo, PR_LABELS);

  switch (status) {
    case "review": {
      await completeCheck(octokit, owner, repo, checkRunId, "action_required", {
        title: "PR requires security review",
        summary: `${result.findings?.length ?? 0} security concern(s) detected.`,
        text: renderFindingsSummary(result.findings ?? []),
      });
      await setLabel(octokit, owner, repo, prNumber, LABEL_DEFS.PR_FLAGGED.name, PR_LABEL_NAMES);
      await deleteMarkerComment(octokit, owner, repo, prNumber, MARKERS.PR_SCAN);
      await replaceInlineFindingComments(
        octokit,
        owner,
        repo,
        prNumber,
        headSha,
        result.findings ?? [],
      );
      scheduleDismissalReconcile(octokit, { owner, repo, prNumber, headSha });
      break;
    }

    case "clean": {
      await completeCheck(octokit, owner, repo, checkRunId, "success", {
        title: "PR scan passed",
        summary: "No suspicious PR changes were detected.",
      });
      await setLabel(octokit, owner, repo, prNumber, LABEL_DEFS.PR_VERIFIED.name, PR_LABEL_NAMES);
      await deleteMarkerComment(octokit, owner, repo, prNumber, MARKERS.PR_SCAN);
      await deleteInlineFindingComments(octokit, owner, repo, prNumber);
      break;
    }

    case "inconclusive": {
      await completeCheck(octokit, owner, repo, checkRunId, "neutral", {
        title: "Scan inconclusive",
        summary: result.error ?? "Unable to determine scan results at this time.",
      });
      await clearLabels(octokit, owner, repo, prNumber, PR_LABEL_NAMES);
      await deleteMarkerComment(octokit, owner, repo, prNumber, MARKERS.PR_SCAN);
      await deleteInlineFindingComments(octokit, owner, repo, prNumber);
      break;
    }
  }
}

function renderFindingsSummary(findings: PrFinding[]): string {
  return findings
    .map((finding, index) => {
      const location = finding.file
        ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
        : "";
      return `${index + 1}. **${formatFindingPriority(finding.severity)}:** ${finding.title}${location}\n${finding.recommendation}`;
    })
    .join("\n\n");
}

async function replaceInlineFindingComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  findings: PrFinding[],
): Promise<void> {
  clearPrFindingDismissals(owner, repo, prNumber);
  await deleteInlineFindingComments(octokit, owner, repo, prNumber);

  const comments = findings
    .filter((finding) => finding.file && finding.line && finding.line > 0)
    .slice(0, MAX_INLINE_COMMENTS)
    .map((finding) => ({
      path: finding.file!,
      line: finding.line!,
      side: "RIGHT" as const,
      body: renderInlineFindingComment(finding),
    }));

  if (!comments.length) return;

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT",
    body: `${MARKERS.PR_FINDING}\nSuperagent found ${findings.length} security concern(s).`,
    comments,
  });
}

async function deleteInlineFindingComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const stale = comments.filter((comment) => comment.body?.includes(MARKERS.PR_FINDING));
  for (const comment of stale) {
    await octokit.rest.pulls.deleteReviewComment({
      owner,
      repo,
      comment_id: comment.id,
    });
  }
}

function renderInlineFindingComment(finding: PrFinding): string {
  const evidence = compactSentence(finding.short_evidence ?? finding.evidence, 180);
  const recommendation = compactSentence(
    finding.short_recommendation ?? finding.recommendation,
    220,
  );

  return `${MARKERS.PR_FINDING}
**${formatFindingPriority(finding.severity)}:** ${finding.title}

${evidence}

${recommendation}`;
}

function compactSentence(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}
