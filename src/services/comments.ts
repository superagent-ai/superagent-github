import type { Octokit } from "octokit";
import type { PrScanResult, ContributorResult, PrStatus } from "../lib/types.js";
import { MARKERS } from "../lib/types.js";

export async function upsertComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(marker));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }
}

export async function deleteMarkerComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body?.includes(marker));
  if (existing) {
    await octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: existing.id,
    });
  }
}

export function renderPrScanComment(
  status: PrStatus,
  result: PrScanResult,
): string {
  const headline =
    status === "blocking"
      ? "This PR has findings that should block merge."
      : "This PR has findings that should be reviewed.";

  let body = `${MARKERS.PR_SCAN}\n### Brin PR Security Scan\n\n`;
  body += `${headline}\n\n`;
  body += `- **Score:** ${result.score}/100\n`;
  body += `- **Verdict:** ${result.verdict}\n\n`;

  if (result.threats?.length) {
    body += `**Findings:**\n`;
    for (const t of result.threats) {
      body += `- ${t.type}: ${t.detail}\n`;
    }
    body += `\n`;
  }

  body += `<sub>Analyzed by [Brin](https://brin.sh)</sub>`;
  return body;
}

export function renderContributorTrustComment(
  result: ContributorResult,
): string {
  const verdictEmoji: Record<string, string> = {
    caution: "\u26A0\uFE0F",
    suspicious: "\u26D4",
    dangerous: "\uD83D\uDEA8",
  };
  const emoji = verdictEmoji[result.verdict ?? ""] ?? "\u2753";
  const sub = result.sub_scores ?? {};
  const fmt = (v?: number) => (v != null ? String(Math.round(v)) : "\u2014");

  let body = `${MARKERS.CONTRIBUTOR_TRUST}\n`;
  body += `### ${emoji} Contributor Trust Check \u2014 Review Recommended\n\n`;
  body += `This contributor's profile shows patterns that may warrant additional review. `;
  body += `This is based on their GitHub activity, not the contents of this PR.\n\n`;
  body += `**[${result.name}](https://github.com/${result.name})** \u00b7 Score: **${result.score}**/100\n\n`;

  if (result.threats?.length) {
    body += `#### Why was this flagged?\n\n`;
    body += `| Signal | Severity | Detail |\n|--------|----------|--------|\n`;
    for (const t of result.threats) {
      body += `| ${t.type} | ${t.severity} | ${t.detail} |\n`;
    }
    body += `\n`;
  }

  body += `<details>\n<summary>Dimension breakdown</summary>\n\n`;
  body += `| Dimension | Score | What it measures |\n|-----------|-------|------------------|\n`;
  body += `| Identity | ${fmt(sub.identity)} | Account age, contribution history, GPG keys, org memberships |\n`;
  body += `| Behavior | ${fmt(sub.behavior)} | PR patterns, unsolicited contribution ratio, activity cadence |\n`;
  body += `| Content | ${fmt(sub.content)} | PR body substance, issue linkage, contribution quality |\n`;
  body += `\n`;
  body += `</details>\n\n`;

  body += `<sub>Analyzed by [Brin](https://brin.sh)`;
  if (result.url) {
    body += ` \u00b7 [Full profile](${result.url}?details=true)`;
  }
  body += `</sub>`;

  return body;
}
