import type { PrFinding, PrScanResult } from "../lib/types.js";
import { childLogger } from "../lib/logger.js";

const GITHUB_PR_FILES_PER_PAGE = 100;
const GITHUB_PR_FILES_PAGE_LIMIT = 30;
const MAX_PATCH_CHARS_PER_FILE = 8_000;
const MAX_PAYLOAD_CHARS = 100_000;
const FLUE_PR_SCAN_MAX_ATTEMPTS = 3;
const FLUE_PR_SCAN_RETRY_BASE_MS = 2_000;
const RETRYABLE_FLUE_STATUSES = new Set([429, 500, 502, 503, 504]);

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
  scan?: {
    batch: number;
    batches: number;
  };
  files: Array<{
    path: string;
    previousPath?: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patchPart?: number;
    patchParts?: number;
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
    const result = await runFluePrScans(payload);
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
    files: buildPayloadFiles(files),
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

function buildPayloadFiles(files: GitHubPrFile[]): PrScanPayload["files"] {
  return files.flatMap((file) => {
    const patchChunks = splitPatch(file.patch ?? "", MAX_PATCH_CHARS_PER_FILE);

    return patchChunks.map((patch, index) => ({
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      changes: file.changes ?? 0,
      patchPart: patchChunks.length > 1 ? index + 1 : undefined,
      patchParts: patchChunks.length > 1 ? patchChunks.length : undefined,
      patch,
    }));
  });
}

function splitPatch(patch: string, maxChars: number): string[] {
  if (patch.length <= maxChars) return [patch];

  const chunks: string[] = [];
  for (let offset = 0; offset < patch.length; offset += maxChars) {
    chunks.push(patch.slice(offset, offset + maxChars));
  }
  return chunks;
}

async function runFluePrScans(payload: PrScanPayload): Promise<PrScanResult> {
  const findings: PrFinding[] = [];
  const log = childLogger({
    service: "pr-scanner",
    owner: payload.owner,
    repo: payload.repo,
    pr: payload.prNumber,
  });

  for (const batch of buildPayloadBatches(payload)) {
    const result = await runFluePrScanWithRetry(batch, log);
    if (result.error) return { error: result.error };
    findings.push(...(result.findings ?? []));
  }

  return { findings };
}

function buildPayloadBatches(payload: PrScanPayload): PrScanPayload[] {
  if (!payload.files.length) return [payload];

  const fileBatches: PrScanPayload["files"][] = [];
  let currentBatch: PrScanPayload["files"] = [];
  let currentPatchChars = 0;

  for (const file of payload.files) {
    if (
      currentBatch.length > 0
      && currentPatchChars + file.patch.length > MAX_PAYLOAD_CHARS
    ) {
      fileBatches.push(currentBatch);
      currentBatch = [];
      currentPatchChars = 0;
    }

    currentBatch.push(file);
    currentPatchChars += file.patch.length;
  }

  if (currentBatch.length > 0) fileBatches.push(currentBatch);

  return fileBatches.map((files, index) => ({
    ...payload,
    scan: {
      batch: index + 1,
      batches: fileBatches.length,
    },
    files,
  }));
}

async function runFluePrScanWithRetry(
  payload: PrScanPayload,
  log: ReturnType<typeof childLogger>,
): Promise<PrScanResult> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= FLUE_PR_SCAN_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestFluePrScan(payload, attempt);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("Flue PR scan failed");
      if (!isRetryableFlueError(err) || attempt === FLUE_PR_SCAN_MAX_ATTEMPTS) {
        throw lastError;
      }

      const delayMs = FLUE_PR_SCAN_RETRY_BASE_MS * 2 ** (attempt - 1);
      log.warn(
        { attempt, delayMs, err: lastError.message },
        "Flue PR scan failed with retryable error; retrying",
      );
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Flue PR scan failed");
}

async function requestFluePrScan(
  payload: PrScanPayload,
  attempt = 1,
): Promise<PrScanResult> {
  const baseUrl = process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583";
  const batchSuffix = payload.scan && payload.scan.batches > 1
    ? `-batch-${payload.scan.batch}-of-${payload.scan.batches}`
    : "";
  const retrySuffix = attempt > 1 ? `-retry-${attempt}` : "";
  const agentId = encodeURIComponent(
    `${payload.owner}-${payload.repo}-${payload.prNumber}${batchSuffix}${retrySuffix}`,
  );
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
    throw new FluePrScanHttpError(
      `Flue PR scan returned ${res.status}: ${await res.text()}`,
      res.status,
    );
  }

  const data = await res.json();
  return normalizePrScanResult(unwrapFlueResult(data));
}

class FluePrScanHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FluePrScanHttpError";
  }
}

function isRetryableFlueError(err: unknown): boolean {
  if (err instanceof FluePrScanHttpError) {
    return RETRYABLE_FLUE_STATUSES.has(err.status);
  }

  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;

  const code = (err as NodeJS.ErrnoException).code;
  return code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "EPIPE"
    || code === "ETIMEDOUT";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
