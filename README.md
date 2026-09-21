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

Copy `.env.example` to `.env` before running services. Environment values are validated at startup; invalid configuration prevents a partial startup.

## Architecture

See [DECISIONS.md](./DECISIONS.md) for the decisions that shape the system and `docs/` for operational and architectural notes.

