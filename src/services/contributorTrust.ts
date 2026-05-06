import type { Octokit } from "octokit";
import type { RepoConfig } from "../lib/types.js";
import { CHECK_NAMES, MARKERS, LABEL_DEFS } from "../lib/types.js";
import { scanContributor } from "../lib/brinApi.js";
import { evaluateContributor } from "../lib/policy.js";
import { createInProgressCheck, completeCheck } from "./checkRuns.js";
import {
  upsertComment,
  deleteMarkerComment,
  renderContributorTrustComment,
} from "./comments.js";
import { getGitHubToken } from "./githubToken.js";
import { ensureLabels, setLabel } from "./labels.js";
import { childLogger } from "../lib/logger.js";

const TRUST_LABELS = [LABEL_DEFS.CONTRIBUTOR_VERIFIED, LABEL_DEFS.CONTRIBUTOR_FLAGGED];
const TRUST_LABEL_NAMES = TRUST_LABELS.map((l) => l.name);

export async function runContributorTrust(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    authorLogin: string;
    config: RepoConfig;
  },
): Promise<void> {
  const { owner, repo, prNumber, headSha, authorLogin, config } = params;
  const log = childLogger({
    service: "contributor-trust",
    owner,
    repo,
    pr: prNumber,
    author: authorLogin,
  });

  if (!config.contributorTrust.enabled) {
    log.info("Contributor trust check disabled by repo config");
    return;
  }

  if (config.contributorTrust.trustedAuthors.includes(authorLogin)) {
    log.info("Author is in trusted list, skipping scan");
    return;
  }

  const checkRunId = await createInProgressCheck(
    octokit,
    owner,
    repo,
    headSha,
    CHECK_NAMES.CONTRIBUTOR_TRUST,
  );

  const githubToken = await getGitHubToken(octokit);
  const result = await scanContributor(authorLogin, { githubToken });
  const { isSafe } = evaluateContributor(result, config);

  log.info(
    { score: result.score, verdict: result.verdict, isSafe },
    "Contributor trust evaluated",
  );

  await ensureLabels(octokit, owner, repo, TRUST_LABELS);

  if (isSafe) {
    await completeCheck(octokit, owner, repo, checkRunId, "success", {
      title: "Contributor verified",
      summary:
        result.score != null
          ? `Score: ${result.score}/100 \u00b7 Verdict: ${result.verdict}`
          : "Contributor passed trust analysis.",
    });
    await setLabel(
      octokit,
      owner,
      repo,
      prNumber,
      LABEL_DEFS.CONTRIBUTOR_VERIFIED.name,
      TRUST_LABEL_NAMES,
    );
    await deleteMarkerComment(octokit, owner, repo, prNumber, MARKERS.CONTRIBUTOR_TRUST);
  } else {
    const conclusion = "failure" as const;
    await completeCheck(octokit, owner, repo, checkRunId, conclusion, {
      title: "Contributor flagged for review",
      summary: `Score: ${result.score}/100 \u00b7 Verdict: ${result.verdict}`,
    });
    await setLabel(
      octokit,
      owner,
      repo,
      prNumber,
      LABEL_DEFS.CONTRIBUTOR_FLAGGED.name,
      TRUST_LABEL_NAMES,
    );
    const body = renderContributorTrustComment(result);
    await upsertComment(octokit, owner, repo, prNumber, MARKERS.CONTRIBUTOR_TRUST, body);
  }
}
