export const CHECK_NAMES = {
  PR_SCAN: "Brin PR Scan",
  CONTRIBUTOR_TRUST: "Brin Contributor Trust",
} as const;

export const MARKERS = {
  PR_SCAN: "<!-- brin-pr-scan -->",
  CONTRIBUTOR_TRUST: "<!-- brin-check -->",
} as const;

export const LABEL_DEFS = {
  PR_VERIFIED: {
    name: "pr:verified",
    color: "0969da",
    description: "PR passed security analysis.",
  },
  PR_FLAGGED: {
    name: "pr:flagged",
    color: "e16f24",
    description: "PR flagged for review by security analysis.",
  },
  CONTRIBUTOR_VERIFIED: {
    name: "contributor:verified",
    color: "0969da",
    description: "Contributor passed trust analysis.",
  },
  CONTRIBUTOR_FLAGGED: {
    name: "contributor:flagged",
    color: "e16f24",
    description: "Contributor flagged for review by trust analysis.",
  },
} as const;

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

export interface PrScanResult {
  score?: number;
  verdict?: string;
  pending_deep_scan?: boolean;
  threats?: Array<{ type: string; detail: string; severity?: string }>;
}

export interface ContributorResult {
  score?: number;
  verdict?: string;
  confidence?: string;
  name?: string;
  url?: string;
  threats?: Array<{ type: string; detail: string; severity: string }>;
  sub_scores?: {
    identity?: number;
    behavior?: number;
    content?: number;
  };
}

export type PrStatus = "blocking" | "review" | "clean" | "inconclusive";

export interface RepoConfig {
  prScan: {
    enabled: boolean;
    blockBelowScore: number;
    suspiciousVerdicts: string[];
    tolerance: string;
  };
  contributorTrust: {
    enabled: boolean;
    blockBelowScore: number;
    trustedAuthors: string[];
  };
  comments: {
    mode: "detailed" | "minimal";
  };
}

export const DEFAULT_CONFIG: RepoConfig = {
  prScan: {
    enabled: true,
    blockBelowScore: 30,
    suspiciousVerdicts: ["suspicious"],
    tolerance: "conservative",
  },
  contributorTrust: {
    enabled: true,
    blockBelowScore: 30,
    trustedAuthors: ["dependabot[bot]", "renovate[bot]"],
  },
  comments: {
    mode: "detailed",
  },
};
