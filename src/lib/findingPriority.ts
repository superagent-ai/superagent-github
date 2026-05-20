import type { PrFindingSeverity } from "./types.js";

const SEVERITY_TO_PRIORITY: Record<PrFindingSeverity, string> = {
  critical: "P0",
  high: "P1",
  medium: "P2",
  low: "P3",
};

export function formatFindingPriority(severity: PrFindingSeverity): string {
  return SEVERITY_TO_PRIORITY[severity];
}
