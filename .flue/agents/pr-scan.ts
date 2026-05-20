import type { FlueContext, FlueSession } from "@flue/sdk/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Daytona } from "@daytona/sdk";
import * as v from "valibot";
import { getAzureKimiModel } from "../../src/lib/azureKimi.js";
import { daytona } from "../connectors/daytona.js";

export const triggers = { webhook: true };

const SKILL_FILES = [
  "SKILL.md",
  "references/checklist.md",
  "references/triggers.md",
  "references/patterns.md",
] as const;

const findingCategorySchema = v.picklist(["ci_cd", "lifecycle", "malicious_intent"]);
const findingSeveritySchema = v.picklist(["critical", "high", "medium", "low"]);

const findingSchema = v.object({
  category: findingCategorySchema,
  severity: findingSeveritySchema,
  title: v.string(),
  file: v.optional(v.string()),
  line: v.optional(v.number()),
  evidence: v.string(),
  recommendation: v.string(),
  short_evidence: v.optional(v.string()),
  short_recommendation: v.optional(v.string()),
});

const prScanResultSchema = v.object({
  findings: v.array(findingSchema),
});

type PrScanPayload = {
  owner?: string;
  repo?: string;
  prNumber?: number;
  pullRequest?: {
    title?: string;
    body?: string;
    author?: string;
    baseRef?: string;
    headRef?: string;
    headRepo?: string;
  };
  scan?: {
    batch?: number;
    batches?: number;
  };
  files?: Array<{
    path: string;
    previousPath?: string;
    status: string;
    additions?: number;
    deletions?: number;
    patchPart?: number;
    patchParts?: number;
    patch?: string;
  }>;
};

export default async function ({ init, payload, env }: FlueContext) {
  try {
    const envSource = toEnvSource(env);
    const sandbox = await createDaytonaSandbox(env);
    const workspacePath = await getWorkspacePath(sandbox);
    await seedCiCdSkill(sandbox, workspacePath);

    const harness = await init({
      sandbox: daytona(sandbox),
      cwd: workspacePath,
      model: getAzureKimiModel(envSource),
    });
    const session = await harness.session();
    const pr = normalizePayload(payload);
    const workflowFiles = pr.files.filter((file) => file.path.startsWith(".github/workflows/"));

    const ciCdFindings = workflowFiles.length
      ? await scanCiCdWorkflows(session, workflowFiles)
      : [];

    const { data } = await session.prompt(buildPrScanPrompt(pr, ciCdFindings), {
      schema: prScanResultSchema,
    });

    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : "PR scan agent failed";
    throw new Error(`PR scan agent failed: ${message}`, { cause: err });
  }
}

async function createDaytonaSandbox(env: unknown) {
  const source = toEnvSource(env);
  const apiKey = requiredFrom(source, "DAYTONA_API_KEY");
  const client = new Daytona({
    apiKey,
    apiUrl: source.DAYTONA_API_URL,
    target: source.DAYTONA_TARGET,
  });

  return client.create({
    ephemeral: true,
    autoStopInterval: 1,
    envVars: {
      NODE_ENV: "production",
    },
  });
}

async function getWorkspacePath(sandbox: Awaited<ReturnType<Daytona["create"]>>) {
  const workDir = (await sandbox.getWorkDir()) ?? "/home/daytona";
  return `${workDir.replace(/\/$/, "")}/superagent-pr-scan`;
}

async function seedCiCdSkill(
  sandbox: Awaited<ReturnType<Daytona["create"]>>,
  workspacePath: string,
) {
  await sandbox.process.executeCommand(
    `mkdir -p ${shellQuote(`${workspacePath}/.agents/skills/ci-cd-security/references`)}`,
  );

  const skillRoot = path.resolve(
    process.cwd(),
    ".agents/skills/ci-cd-security",
  );

  for (const relativePath of SKILL_FILES) {
    const sourcePath = path.join(skillRoot, relativePath);
    const targetPath = `${workspacePath}/.agents/skills/ci-cd-security/${relativePath}`;
    const content = await readFile(sourcePath);
    await sandbox.fs.uploadFile(Buffer.from(content), targetPath);
  }
}

async function scanCiCdWorkflows(
  session: FlueSession,
  workflowFiles: PrScanPayload["files"],
) {
  const { data } = await session.skill("ci-cd-security", {
    args: {
      workflows: workflowFiles.map((file) => ({
        path: file.path,
        status: file.status,
        patchPart: file.patchPart,
        patchParts: file.patchParts,
        patch: file.patch ?? "",
      })),
    },
    schema: prScanResultSchema,
  });

  return data.findings;
}

function buildPrScanPrompt(
  pr: PrScanPayload & { files: NonNullable<PrScanPayload["files"]> },
  ciCdFindings: unknown[],
) {
  return `You are Superagent's PR security scanner. Scan this pull request for suspicious or malicious changes.

Return structured findings only. Do not score the PR. Do not return a verdict. If nothing suspicious is present, return {"findings":[]}.

Scan exactly these areas:
1. CI/CD changes. Use the ci-cd-security skill findings below as the source of truth for GitHub Actions workflow review. Include those findings when they are actionable.
2. Lifecycle events that could execute unexpectedly or maliciously. Look for package-manager lifecycle hooks such as preinstall, install, postinstall, prepare, prepublish, publish, npm/yarn/pnpm scripts, setup.py/pyproject build hooks, Cargo build.rs, Docker entrypoints, git hooks, or other code paths that run during install, build, test, release, or app startup.
3. General PR changes that indicate malicious intent. Look for secret exfiltration, obfuscation, encoded payloads, unexpected network calls, dependency confusion, typosquatting, privilege escalation, credential handling changes, telemetry that leaks sensitive data, suspicious binary/blob additions, dangerous eval/exec patterns, and changes that hide behavior from reviewers.

Every finding must be actionable:
- title: one clear sentence describing the issue (shown after the priority label, e.g. "**P2:** ...")
- category: "ci_cd", "lifecycle", or "malicious_intent"
- severity: "critical" (P0), "high" (P1), "medium" (P2), or "low" (P3)
- file and line when available
- evidence: quote or describe the concrete changed code/pattern
- recommendation: exact remediation or review action
- short_evidence: one short sentence for inline review comments, max 140 characters
- short_recommendation: one short fix for inline review comments, max 180 characters

Keep inline fields terse. Do not include long exploit chains in short_evidence or short_recommendation. Put detail in evidence and recommendation instead.

Do not flag ordinary refactors, formatting, harmless dependency updates, or expected app behavior without concrete suspicious evidence.

Repository: ${pr.owner ?? ""}/${pr.repo ?? ""}
PR: #${pr.prNumber ?? ""}
Scan batch: ${pr.scan?.batch ?? 1} of ${pr.scan?.batches ?? 1}
Title: ${pr.pullRequest?.title ?? ""}
Author: ${pr.pullRequest?.author ?? ""}
Base: ${pr.pullRequest?.baseRef ?? ""}
Head: ${pr.pullRequest?.headRef ?? ""} (${pr.pullRequest?.headRepo ?? ""})
Body:
${pr.pullRequest?.body ?? ""}

CI/CD skill findings:
${JSON.stringify(ciCdFindings, null, 2)}

Changed files and patches:
Large patches may appear as multiple records with the same path and patchPart/patchParts metadata. These parts are contiguous. Scan every part; no patch content has been omitted.
${JSON.stringify(pr.files, null, 2)}
`;
}

function normalizePayload(payload: unknown): PrScanPayload & { files: NonNullable<PrScanPayload["files"]> } {
  if (!payload || typeof payload !== "object") {
    return { files: [] };
  }

  const candidate = payload as PrScanPayload;
  return {
    ...candidate,
    files: Array.isArray(candidate.files) ? candidate.files : [],
  };
}

function toEnvSource(env: unknown): Record<string, string | undefined> {
  const source: Record<string, string | undefined> = { ...process.env };

  if (env && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") source[key] = value;
    }
  }

  return source;
}

function requiredFrom(source: Record<string, string | undefined>, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
