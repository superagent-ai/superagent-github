import type { Octokit } from "octokit";

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: CheckAnnotation[];
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
  raw_details?: string;
}

export async function createInProgressCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  name: string,
): Promise<number> {
  const { data } = await octokit.rest.checks.create({
    owner,
    repo,
    name,
    head_sha: headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
  });
  return data.id;
}

export async function completeCheck(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number,
  conclusion: "success" | "failure" | "neutral" | "action_required",
  output: CheckOutput,
): Promise<void> {
  await octokit.rest.checks.update({
    owner,
    repo,
    check_run_id: checkRunId,
    status: "completed",
    conclusion,
    completed_at: new Date().toISOString(),
    output,
  });
}
