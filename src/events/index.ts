import type { App } from "octokit";
import { handlePullRequest } from "./pullRequest.js";
import { handleCheckRunRerequested } from "./checkRun.js";
import { handleInstallationCreated, handleInstallationDeleted } from "./installation.js";
import { handlePullRequestReviewComment } from "./pullRequestReviewComment.js";
import { handlePullRequestReviewThread } from "./pullRequestReviewThread.js";
import { logger } from "../lib/logger.js";

type WebhookHandler = (event: any) => Promise<void>;

export function registerEventHandlers(app: App) {
  app.webhooks.on("pull_request", handlePullRequest as WebhookHandler);
  app.webhooks.on(
    "pull_request_review_comment",
    handlePullRequestReviewComment as WebhookHandler,
  );
  app.webhooks.on(
    "pull_request_review_thread",
    handlePullRequestReviewThread as WebhookHandler,
  );
  app.webhooks.on("check_run.rerequested", handleCheckRunRerequested as WebhookHandler);
  app.webhooks.on("installation.created", handleInstallationCreated as WebhookHandler);
  app.webhooks.on("installation.deleted", handleInstallationDeleted as WebhookHandler);

  app.webhooks.onError((error) => {
    logger.error({ err: error }, "Webhook handler error");
  });

  logger.info("Event handlers registered");
}
