import type { PrFinding, PrScanResult } from "../lib/types.js";
import { childLogger } from "../lib/logger.js";

const GITHUB_PR_FILES_PER_PAGE = 100;
const GITHUB_PR_FILES_PAGE_LIMIT = 30;
const MAX_PATCH_CHARS_PER_FILE = 8_000;
const MAX_PAYLOAD_CHARS = 100_000;

interface GitHubPrFile {
  filename: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  previous_filename?: string;
}

interface GitHubPullRequest {
  title?: string;
  body?: string | null;
  user?: { login?: string };
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } };
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
}

interface PrScanPayload {
  owner: string;
  repo: string;
  prNumber: number;
  pullRequest: {
    title: string;
    body: string;
    author: string;
    baseRef: string;
    baseSha: string;
    headRef: string;
    headSha: string;
    headRepo: string;
  };
  files: Array<{
    path: string;
    previousPath?: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch: string;
  }>;
}

export async function scanPrLocally(
  owner: string,
  repo: string,
  prNumber: number,
  options: { githubToken?: string } = {},
): Promise<PrScanResult> {
  const log = childLogger({
    service: "pr-scanner",
    owner,
    repo,
    pr: prNumber,
  });

  try {
    const payload = await collectPrScanPayload(owner, repo, prNumber, options.githubToken);
    const result = await runFluePrScan(payload);
    log.info({ findings: result.findings?.length ?? 0 }, "Local Flue PR scan completed");
    return result;
  } catch (err) {
    log.error({ err }, "Local Flue PR scan failed");
    return {
      error: err instanceof Error ? err.message : "Local Flue PR scan failed",
    };
  }
}

async function collectPrScanPayload(
  owner: string,
  repo: string,
  prNumber: number,
  githubToken?: string,
): Promise<PrScanPayload> {
  const [pullRequest, files] = await Promise.all([
    fetchGitHub<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls/${prNumber}`, githubToken),
    fetchPrFiles(owner, repo, prNumber, githubToken),
  ]);

  return {
    owner,
    repo,
    prNumber,
    pullRequest: {
      title: pullRequest.title ?? "",
      body: pullRequest.body ?? "",
      author: pullRequest.user?.login ?? "",
      baseRef: pullRequest.base?.ref ?? "",
      baseSha: pullRequest.base?.sha ?? "",
      headRef: pullRequest.head?.ref ?? "",
      headSha: pullRequest.head?.sha ?? "",
      headRepo: pullRequest.head?.repo?.full_name ?? "",
    },
    files: trimPayloadFiles(files),
  };
}

async function fetchPrFiles(
  owner: string,
  repo: string,
  prNumber: number,
  githubToken?: string,
): Promise<GitHubPrFile[]> {
  const files: GitHubPrFile[] = [];
  for (let page = 1; page <= GITHUB_PR_FILES_PAGE_LIMIT; page++) {
    const pageFiles = await fetchGitHub<GitHubPrFile[]>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${GITHUB_PR_FILES_PER_PAGE}&page=${page}`,
      githubToken,
    );
    files.push(...pageFiles);
    if (pageFiles.length < GITHUB_PR_FILES_PER_PAGE) break;

    if (page === GITHUB_PR_FILES_PAGE_LIMIT) {
      const fileLimit = GITHUB_PR_FILES_PER_PAGE * GITHUB_PR_FILES_PAGE_LIMIT;
      throw new Error(
        `PR file list reached GitHub's ${fileLimit} file scan limit`,
      );
    }
  }
  return files;
}

async function fetchGitHub<T>(pathAndQuery: string, githubToken?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "superagent-github-app",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const res = await fetch(`https://api.github.com${pathAndQuery}`, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${pathAndQuery}`);
  }

  return (await res.json()) as T;
}

function trimPayloadFiles(files: GitHubPrFile[]): PrScanPayload["files"] {
  let remaining = MAX_PAYLOAD_CHARS;
  return files.map((file) => {
    const rawPatch = file.patch ?? "";
    const patch = rawPatch.slice(0, Math.min(MAX_PATCH_CHARS_PER_FILE, remaining));
    remaining = Math.max(0, remaining - patch.length);

    return {
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      patch,
    };
  });
}

async function runFluePrScan(payload: PrScanPayload): Promise<PrScanResult> {
  const baseUrl = process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583";
  const agentId = encodeURIComponent(`${payload.owner}-${payload.repo}-${payload.prNumber}`);
  const res = await fetch(`${baseUrl}/agents/pr-scan/${agentId}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60_000),
  });

  if (!res.ok) {
    throw new Error(`Flue PR scan returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  return normalizePrScanResult(unwrapFlueResult(data));
}

function normalizePrScanResult(result: PrScanResult): PrScanResult {
  return {
    findings: (result.findings ?? []).map(normalizeFinding),
    error: result.error,
  };
}

function unwrapFlueResult(data: unknown): PrScanResult {
  if (data && typeof data === "object") {
    if ("result" in data) return unwrapFlueResult(data.result);
    if ("data" in data) return unwrapFlueResult(data.data);
  }
  return data as PrScanResult;
}

function normalizeFinding(finding: PrFinding): PrFinding {
  return {
    category: finding.category,
    severity: finding.severity,
    title: finding.title,
    file: finding.file,
    line: finding.line,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    short_evidence: finding.short_evidence,
    short_recommendation: finding.short_recommendation,
  };
}
