# Superagent GitHub App

A GitHub App that automatically scans pull requests for security threats and evaluates contributor trust profiles.

## What it does

When installed on a repository, the app reacts to pull request events and runs two parallel checks:

**PR Security Scan** -- Analyzes the PR diff for security threats (credential leaks, obfuscated payloads, dependency attacks, etc.) and reports a score from 0-100 with a verdict.

**Contributor Trust Check** -- Evaluates the PR author's GitHub profile across identity, behavior, and content dimensions to flag accounts that warrant additional review.

Results are surfaced as:

- **Check runs** on the PR commit (pass/fail/neutral) that integrate with branch protection rules
- **PR comments** with detailed findings and dimension breakdowns
- **Labels** (`pr:verified`, `pr:flagged`, `contributor:verified`, `contributor:flagged`)

### Verdict flow


| Result                            | Check run | Label                                  | Comment | Blocks merge |
| --------------------------------- | --------- | -------------------------------------- | ------- | ------------ |
| PR clean / contributor score >= 30 | success   | `pr:verified` / `contributor:verified` | removed | no           |
| PR suspicious                     | neutral   | `pr:flagged`                           | posted  | no           |
| PR dangerous or score < 30        | failure   | `pr:flagged`                           | posted  | yes          |
| contributor score < 30            | failure   | `contributor:flagged`                  | posted  | yes          |
| pending deep scan                 | neutral   | --                                     | --      | no           |


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
```

Contributor trust scoring runs locally in this app and uses the GitHub App installation token to fetch profile and activity signals.

### 3. Install dependencies and run

```bash
npm install
npm run dev      # development with hot reload
npm run build    # compile TypeScript
npm start        # run compiled output
```

The server starts on port 3000 by default (override with `PORT` env var).

### 4. Install the app on repositories

Go to your app's installation page and install it on the repositories you want to protect.

## Repo configuration

Repositories can optionally add a configuration file to customize behavior:

```yaml
prScan:
  enabled: true
  blockBelowScore: 30
  suspiciousVerdicts: [suspicious]
  tolerance: conservative

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
│   ├── contributorTrust.ts     # Contributor trust orchestration
│   ├── contributorScanner.ts   # Local contributor scoring facade
│   ├── githubContributor.ts    # GitHub profile/activity signal collection
│   ├── checkRuns.ts            # GitHub Check Runs API wrapper
│   ├── comments.ts             # Marker-based comment management + rendering
│   ├── labels.ts               # Label ensure/set logic
│   └── config.ts               # Repository config loader
└── lib/
    ├── env.ts                  # Environment variable validation
    ├── logger.ts               # Structured logging (pino)
    ├── types.ts                # Shared types, constants, label/marker defs
    ├── contributorScoring.ts   # Contributor scoring formulas
    └── policy.ts               # Verdict evaluation and threshold logic
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