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

## ADR-004: Tenant context is transaction-local and mandatory

**Status:** Accepted

Every tenant repository operation runs inside `TenantUnitOfWork.withTenant`. The helper starts an interactive transaction, assumes the unprivileged `incidentbase_runtime` role, and applies the authenticated user and selected organization with transaction-local PostgreSQL settings. It verifies an active membership before application repository code runs. `SET LOCAL` semantics prevent pooled connections from retaining tenant identity after commit, rollback, or error.

Tenant-owned repositories do not accept an unrestricted Prisma client. This keeps raw access outside the tenant boundary explicit and limited to migration, provisioning, and test-fixture code.

## ADR-005: Forced PostgreSQL RLS is the authoritative tenancy boundary

**Status:** Accepted

All tenant-owned tables carry `organization_id`, use composite tenant keys for relationships, and have both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`. Policies require the transaction's organization to match and the transaction's user to have an active membership. Suspended and invited memberships therefore receive no tenant rows. The global `users` table is also restricted to the current user for runtime access.

`incidentbase_runtime` is a non-login group role with `NOBYPASSRLS` and owns no tables. Application login roles receive only membership in that group. A separate non-login schema owner owns tables and may bypass RLS solely so security-definer policy and invariant functions can evaluate membership state. Migration credentials are operational credentials and must never be used by an application process.

## ADR-006: Active organization ownership is a deferred database invariant

**Status:** Accepted

Deferred constraint triggers reject any committed organization state without at least one membership whose role is `OWNER` and status is `ACTIVE`. Deferral permits ownership transfer inside one atomic transaction while preventing ownerless organizations, suspension of the sole owner, or deletion of the sole owner. This invariant lives in PostgreSQL so no API, worker, script, or future service can bypass it.

## Pending decisions

Optimistic concurrency, transactional outbox, immutable audit records, and escalation locking will be documented in the milestones that introduce them.
