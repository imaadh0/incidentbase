# IncidentBase

IncidentBase is a multi-tenant incident-management platform built as a production-architecture portfolio project. The repository is organized as a TypeScript monorepo with independent web, API, and worker services.

## Prerequisites

- Node.js 22+
- pnpm 10.15.1 (Corepack can provide the pinned version)
- Docker with Compose for PostgreSQL, Redis, and full-stack verification

## Local commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## End-to-end acceptance

The Playwright suite exercises the full web, API, worker, PostgreSQL, and Redis stack. Start it with Docker Compose, then run the browser test:

```bash
docker compose -p incidentbase-e2e -f docker-compose.yml -f docker-compose.e2e.yml up --build -d --wait
pnpm exec playwright install chromium
pnpm test:e2e
docker compose -p incidentbase-e2e -f docker-compose.yml -f docker-compose.e2e.yml down --volumes
```

The suite uses a separate Compose project and port, creates unique test workspaces, and uses a 15-second escalation policy. With no Groq key configured, it verifies that resolution still completes and the summary becomes `UNAVAILABLE`. CI runs this suite against a fresh Compose stack on every pull request and push to `main`.

Copy `.env.example` to `.env` before running services. Environment values are validated at startup; invalid configuration prevents a partial startup.

With the Compose stack running, open `http://localhost/` for the public landing page. The read-only sample is at `/demo`, authentication is at `/sign-in`, and the live incident workspace is at `/app`. The appearance toggle is available across these pages and remembers the choice in the browser.

## Architecture

See [DECISIONS.md](./DECISIONS.md) for the decisions that shape the system and `docs/` for operational and architectural notes.
