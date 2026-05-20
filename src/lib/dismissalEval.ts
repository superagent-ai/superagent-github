import { getAzureKimiProviderConfig } from "./azureKimi.js";
import { childLogger } from "./logger.js";

const log = childLogger({ service: "dismissal-eval" });

export interface DismissalEvaluation {
  dismiss: boolean;
  acknowledgment: string;
}

export interface DismissalEvalOptions {
  trustedContributor?: boolean;
}

function buildSystemPrompt(trustedContributor: boolean): string {
  const base =
    "You review developer replies on pull request security findings. " +
    'Return JSON only: {"dismiss":boolean,"acknowledgment":string}. ' +
    "acknowledgment must be one short, natural sentence addressed to the developer. " +
    "Vary wording; do not repeat the same stock phrase every time.";

  if (trustedContributor) {
    return (
      `${base} ` +
      "The replier is a trusted repository contributor (owner, member, collaborator, or PR author). " +
      "Be permissive: set dismiss true when they give any good-faith explanation, including brief notes like intentional or acceptable risk. " +
      "Only set dismiss false if the reply is empty, off-topic, or clearly not addressing the finding. " +
      "When dismiss is true, write a concise acknowledgment that reflects what they said (e.g. noted it's intentional, test fixture, or accepted risk)."
    );
  }

  return (
    `${base} ` +
    "Be reasonably permissive for good-faith replies, but require enough context to understand why the finding should not block merge. " +
    "Set dismiss true when the reply explains intentional design, acceptable risk, or a false positive. " +
    "When dismiss is false, acknowledgment should briefly ask for the missing context."
  );
}

export async function evaluateFindingDismissal(
  findingBody: string,
  replyBody: string,
  options: DismissalEvalOptions = {},
): Promise<DismissalEvaluation | null> {
  let config;
  try {
    config = getAzureKimiProviderConfig();
  } catch (err) {
    log.warn({ err }, "Azure OpenAI not configured; skipping dismissal evaluation");
    return null;
  }

  const trustedContributor = options.trustedContributor ?? false;

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelId,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(trustedContributor),
        },
        {
          role: "user",
          content: `Security finding:\n${findingBody}\n\nDeveloper reply:\n${replyBody}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    log.warn({ status: response.status }, "Dismissal evaluation request failed");
    return null;
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as { dismiss?: boolean; acknowledgment?: string };
    if (typeof parsed.dismiss !== "boolean") return null;

    let dismiss = parsed.dismiss;
    if (trustedContributor && !dismiss) {
      dismiss = true;
      log.info("Overriding dismiss to true for trusted contributor");
    }

    const acknowledgment =
      typeof parsed.acknowledgment === "string" && parsed.acknowledgment.trim()
        ? parsed.acknowledgment.trim()
        : dismiss
          ? "Got it, thanks for the context."
          : "Thanks for the reply. I still need a bit more context on why this finding is acceptable before I can clear it.";

    return { dismiss, acknowledgment };
  } catch (err) {
    log.warn({ err, content }, "Failed to parse dismissal evaluation");
    return null;
  }
}
