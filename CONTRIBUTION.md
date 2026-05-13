# Contributing

Thanks for your interest in improving Superagent Security Bot for GitHub.

## Development Setup

1. Install Node.js 22.18 or newer.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the required values for local
   development.

4. Start the development server:

   ```bash
   npm run dev
   ```

## Before Opening a Pull Request

Run the core checks locally:

```bash
npm run typecheck
npm test
```

When changing PR scanning, contributor scoring, GitHub webhook handling, or
security policy behavior, include focused tests that cover the new behavior and
any relevant abuse case.

## Pull Request Guidelines

- Keep changes focused and easy to review.
- Explain the security impact of behavior changes.
- Avoid committing secrets, installation tokens, private keys, or local `.env`
  files.
- Update documentation when behavior, configuration, or setup steps change.

## Security Reports

If you believe you have found a security issue, do not open a public issue with
exploit details. Contact the maintainers privately with a description of the
impact, affected code paths, and reproduction steps.

