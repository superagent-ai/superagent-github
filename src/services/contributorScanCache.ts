import type { ContributorResult } from "../lib/types.js";
import { queries } from "../lib/db.js";
import { childLogger } from "../lib/logger.js";

export const CONTRIBUTOR_SCAN_CACHE_TTL_MS = 10 * 60 * 1000;

const log = childLogger({ service: "contributor-scan-cache" });

interface CachedContributorScanRow {
  resultJson: string;
  scannedAt: string;
}

export function getCachedContributorScan(
  login: string,
  maxAgeMs: number = CONTRIBUTOR_SCAN_CACHE_TTL_MS,
): ContributorResult | undefined {
  try {
    const row = queries.getContributorScan.get({ login }) as CachedContributorScanRow | undefined;
    if (!row) return undefined;

    const scannedAt = Date.parse(row.scannedAt);
    if (!Number.isFinite(scannedAt) || Date.now() - scannedAt > maxAgeMs) {
      return undefined;
    }

    return JSON.parse(row.resultJson) as ContributorResult;
  } catch (err) {
    log.warn({ err, login }, "Contributor scan cache read failed");
    return undefined;
  }
}

export function saveCachedContributorScan(login: string, result: ContributorResult): void {
  try {
    queries.upsertContributorScan.run({
      login,
      resultJson: JSON.stringify(result),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    log.warn({ err, login }, "Contributor scan cache write failed");
  }
}
