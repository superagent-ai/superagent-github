import type { Octokit } from "octokit";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONFIG, type RepoConfig } from "../lib/types.js";
import { logger } from "../lib/logger.js";

export async function loadConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<RepoConfig> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: ".github/superagent.yml",
    });

    if ("content" in data && data.content) {
      const raw = Buffer.from(data.content, "base64").toString("utf-8");
      const parsed = parseYaml(raw) as Partial<RepoConfig> | null;
      return mergeConfig(parsed ?? {});
    }
  } catch (err: unknown) {
    const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
    if (status !== 404) {
      logger.warn({ err, owner, repo }, "Failed to load .github/superagent.yml");
    }
  }
  return DEFAULT_CONFIG;
}

function mergeConfig(partial: Partial<RepoConfig>): RepoConfig {
  return {
    prScan: { ...DEFAULT_CONFIG.prScan, ...partial.prScan },
    contributorTrust: { ...DEFAULT_CONFIG.contributorTrust, ...partial.contributorTrust },
    comments: { ...DEFAULT_CONFIG.comments, ...partial.comments },
  };
}
