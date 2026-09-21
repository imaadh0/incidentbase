# Architecture Decisions

This file records decisions that materially affect IncidentBase's safety, operability, or ability to evolve. Each entry states the reason, not only the selected technology.

## ADR-001: TypeScript monorepo with independently deployed services

**Status:** Accepted

The web application, API, and queue worker deploy independently but share validation, authorization, configuration, and observability packages. A pnpm workspace keeps those contracts version-aligned without coupling service processes or Docker images.

## ADR-002: Validate configuration before service startup

**Status:** Accepted

Each process parses its environment through a service-specific Zod schema before opening sockets or consuming work. A missing or malformed required value therefore produces one actionable startup failure instead of a partially initialized process.

## ADR-003: Controlled shutdown at process boundaries

**Status:** Accepted

All application promises are awaited or supervised. Unexpected top-level failures start an idempotent shutdown that stops new work, drains resources, and then exits. Continuing after an unhandled failure could preserve corrupt or unknown process state.

## Pending decisions

Tenant RLS, optimistic concurrency, transactional outbox, immutable audit records, and escalation locking will be documented in the milestones that introduce them.
