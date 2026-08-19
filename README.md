# Pulse Hypr

Pulse Hypr is a health-data platform for a fitness band. This repository owns
the Cloudflare Worker API and React dashboard; the Flutter application and BLE
SDK are maintained as independent sibling repositories.

## Components

- [`backend/`](backend/) — Hono API, Firestore-backed ingest and reporting,
  Firebase token verification, tests, and operational documentation.
- [`web/`](web/) — React/Vite dashboard using Firebase for identity and the API
  for all health-data access.
- [`docs/`](docs/) — architecture, environment setup, and phased implementation
  briefs.

## Agent-assisted engineering

This repository publishes the safe, reproducible portion of its agent-assisted
development process:

- [`AGENTS.md`](AGENTS.md) is the canonical, tool-neutral working agreement.
- [`CLAUDE.md`](CLAUDE.md) is a lightweight adapter to that shared policy.
- [Agentic Engineering Workflow](docs/AGENTIC-ENGINEERING-WORKFLOW.md) documents
  model roles, human approval gates, security boundaries, commands, hooks, MCP
  examples, and a commit-backed case study.

Credentials, private prompts, local MCP endpoints, customer data, and personal
tool settings are intentionally excluded from version control.

## Verification

From the repository root:

```bash
bash scripts/verify.sh all
```

The same backend type checks/tests and web checks/build run in
[GitHub Actions](.github/workflows/deploy.yml) before deployment.
