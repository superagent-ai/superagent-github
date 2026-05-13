# Superagent GitHub App

A GitHub App that automatically scans pull requests for security threats and evaluates contributor trust profiles.

## What it does

When installed on a repository, the app reacts to pull request events and runs two parallel checks:

**PR Security Scan** -- Analyzes the PR diff for suspicious CI/CD changes, malicious lifecycle hooks, and general indicators of malicious intent. It reports security concerns only, with no PR score or verdict.

**Contributor Trust Check** -- Evaluates the PR author's GitHub profile across identity, behavior, and content dimensions to flag accounts that warrant additional review.

Results are surfaced as:

- **Check runs** on the PR commit (pass/fail/neutral) that integrate with branch protection rules
- **PR review comments** with inline security concerns
- **Labels** (`pr:verified`, `pr:flagged`, `contributor:verified`, `contributor:flagged`)

### Result flow


| Result                            | Check run | Label                                  | Comment | Blocks merge |
| --------------------------------- | --------- | -------------------------------------- | ------- | ------------ |
| PR has no findings / contributor score >= 30 | success   | `pr:verified` / `contributor:verified` | removed | no           |
| PR has security concerns          | action required | `pr:flagged`                     | inline review comments | yes |
| contributor score < 30            | failure   | `contributor:flagged`                  | posted  | yes          |
| PR scan inconclusive              | neutral   | --                                     | --      | no           |


## Setup

### 1. Register a GitHub App

Create a new GitHub App at `https://github.com/settings/apps/new` with these settings:

**Permissions:**

- Checks: Read & Write
- Pull requests: Read & Write
- Issues: Read & Write (for PR comments)
- Contents: Read (for repository config)
- Metadata: Read

**Webhook events:**

- Pull request
- Check run
- Check suite
- Installation

Set the webhook URL to `https://<your-host>/api/github/webhook`.

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

```
APP_ID=<your GitHub App ID>
PRIVATE_KEY=<contents of your .pem file, with literal \n for newlines>
WEBHOOK_SECRET=<the secret you set when creating the app>
AZURE_OPENAI_API_KEY=<your Azure OpenAI API key>
AZURE_OPENAI_BASE_URL=https://your-resource.cognitiveservices.azure.com/openai/v1
AZURE_OPENAI_DEPLOYMENT=Kimi-K2.6
DAYTONA_API_KEY=<your Daytona API key>
```

PR security scans run through a prebuilt Flue service with Azure-hosted Kimi. The Flue agent creates a Daytona sandbox per scan, seeds the `ci-cd-security` skill into that sandbox, uses the skill for GitHub Actions workflow review, then scans lifecycle hooks and general PR changes for suspicious intent. This app uses the published Flue SDK package, `@flue/sdk`, plus `@flue/cli`.

Contributor trust scoring runs locally in this app and uses the GitHub App installation token to fetch profile and activity signals.

### 3. Install dependencies and run

```bash
npm install
npm run dev      # development with hot reload
npm run build    # compile TypeScript
npm run flue:build
npm start        # run compiled app and internal Flue service
```

The GitHub App starts on port 3000 by default (override with `PORT` env var). The internal Flue service starts on `FLUE_PORT` (default `3583`) and the app calls it via `FLUE_BASE_URL` (default `http://127.0.0.1:3583`). Flue currently requires Node 22.18 or newer.

### 4. Install the app on repositories

Go to your app's installation page and install it on the repositories you want to protect.

## Repo configuration

Repositories can optionally add `.github/superagent.yml` to customize behavior:

```yaml
prScan:
  enabled: true

contributorTrust:
  enabled: true
  blockBelowScore: 30
  trustedAuthors: [dependabot[bot], renovate[bot]]

comments:
  mode: detailed   # or "minimal"
```

All fields are optional. Missing fields fall back to the defaults shown above.

## Architecture

```
src/
├── index.ts                    # Hono server, webhook route, health check
├── app.ts                      # GitHub App instance (octokit)
├── events/
│   ├── index.ts                # Event handler registration
│   ├── pullRequest.ts          # pull_request event handler
│   ├── checkRun.ts             # check_run.rerequested handler
│   └── installation.ts         # installation.created handler
├── services/
│   ├── prScan.ts               # PR scan orchestration
│   ├── prScanner.ts            # Local Flue PR scanner facade
│   ├── contributorTrust.ts     # Contributor trust orchestration
│   ├── contributorScanner.ts   # Local contributor scoring facade
│   ├── githubContributor.ts    # GitHub profile/activity signal collection
│   ├── checkRuns.ts            # GitHub Check Runs API wrapper
│   ├── comments.ts             # Marker-based comment management + rendering
│   ├── labels.ts               # Label ensure/set logic
│   └── config.ts               # Repository config loader
└── lib/
    ├── env.ts                  # Environment variable validation
    ├── azureKimi.ts            # Azure-hosted Kimi configuration for Flue
    ├── logger.ts               # Structured logging (pino)
    ├── types.ts                # Shared types, constants, label/marker defs
    ├── contributorScoring.ts   # Contributor scoring formulas
    └── policy.ts               # Check-result evaluation logic
```

## Re-running checks

Maintainers can re-run any Superagent check from the GitHub UI by clicking "Re-run" on the check run. The app handles `check_run.rerequested` events and re-executes the corresponding scan.

## Development

```bash
npm run dev          # start with tsx watch (hot reload)
npm run typecheck    # type-check without emitting
npm run build        # compile to dist/
```

For local webhook testing, use a tunnel like [smee.io](https://smee.io) or [ngrok](https://ngrok.com) to forward GitHub webhooks to `localhost:3000/api/github/webhook`.