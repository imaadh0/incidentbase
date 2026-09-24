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

## ADR-007: Short-lived JWT access with rotating opaque refresh sessions

**Status:** Accepted

Passwords are hashed with Argon2id. Successful authentication issues a short-lived signed JWT access token and a high-entropy opaque refresh token in `HttpOnly`, `SameSite=Strict` cookies; production cookies are also `Secure`. Cookie-authenticated mutations require a matching double-submit CSRF token.

Only a SHA-256 digest of each refresh token is stored. Refresh tokens are single-use and rotate within a session family. Reuse of a replaced token revokes the entire family, limiting damage from token theft while preserving server-side logout and logout-all controls. Access tokens identify only the global user: tenant authorization is re-evaluated from active database membership on every tenant-scoped transaction and remains subject to forced RLS.

Invitation tokens follow the same opaque-token rule: the database stores only a digest, and acceptance atomically verifies the invited email, expiry, and single-use status. Authentication operations that must run before a tenant context exists are exposed through narrowly scoped security-definer functions; application connections still use the restricted runtime role.

## ADR-008: Escalation policy revisions are immutable snapshots

**Status:** Accepted

Activating a policy change inserts a new version and ordered step rows instead of editing an existing chain. PostgreSQL triggers reject updates and deletes of versions and steps. Each incident references the exact policy version selected at creation, so later administrative changes cannot silently change an active incident's routing contract. Policy metadata and the active-version pointer may change; archived policies remain readable and cannot be selected as defaults.

## ADR-009: User incident commands use optimistic concurrency

**Status:** Accepted

Every incident mutation requires a quoted version in `If-Match`. The database update predicate includes the organization, incident, expected version, expected lifecycle state, and expected assignee when the command is assignee-only. A successful command increments the version; a stale or concurrently invalidated command returns `409` with the current incident state. This makes simultaneous acknowledgements deterministic without holding a database lock across an HTTP request.

## ADR-010: Business mutations and outbox events commit atomically

**Status:** Accepted

Incident and policy mutations write their audit record and outbox event inside the same tenant-scoped database transaction. External work must be initiated from committed outbox rows rather than directly from request handlers. Incident event deduplication keys derive from the aggregate, action, and resulting version; other events use their monotonic audit cursor. A rollback therefore publishes nothing, while a committed state always has a durable event for later workers.

## ADR-011: Audit records are append-only database facts

**Status:** Accepted

Audit records use a monotonic bigint cursor and capture organization, optional incident, actor, action, metadata, and timestamp. Runtime roles have only insert/select privileges, and a database trigger rejects updates and deletes even if broader privileges are accidentally granted later. Corrections must be represented by a new compensating audit record, preserving the original history.

## ADR-012: Escalation jobs serialize on the incident row and reject stale expectations

**Status:** Accepted

Each delayed escalation job carries the organization, incident, escalation generation, expected step, and expected deadline. Its deterministic queue identifier derives from the same tuple. The worker opens a short transaction, assumes the unprivileged `incidentbase_worker` role, installs transaction-local organization context, and locks the incident row with `FOR UPDATE`. It proceeds only when the locked row still exactly matches the job expectation and is due; duplicates and jobs invalidated by acknowledgement, resolution, reassignment, or a newer generation become harmless stale results.

User commands continue to use optimistic concurrency. The row lock is reserved for background escalation processing, where overlapping workers must make one routing decision at a time. Updating the incident, recording skipped inactive responders, appending the audit fact, and inserting the outbox event happen in the same transaction. Queue publication occurs only after commit, and periodic database reconciliation recreates missing delayed work if publication fails or Redis loses a job.

The worker login owns no tables and has no `BYPASSRLS`. A narrowly scoped security-definer reconciliation function may discover due work across organizations, while every mutation still runs under forced RLS with an explicit organization context. Chain exhaustion leaves the final responder assigned and emits one durable Owner/Admin alert event.

## ADR-013: Socket events are tenant-checked invalidation hints

**Status:** Accepted

The transactional outbox is the only source of realtime incident events. A restricted worker claims committed outbox rows with `FOR UPDATE SKIP LOCKED`, publishes a versioned minimal event through Redis, and marks the row published only after Redis accepts it. Failed publication returns the row to a bounded retry schedule. Publication is at least once, so event IDs are stable and clients suppress duplicates.

Socket.io authenticates the access cookie during the handshake. Organization room joins run through the same tenant unit of work as REST requests, and active membership is revalidated before every broadcast so a suspended member cannot continue receiving events through an existing connection. Organization rooms receive incident invalidations; only the selected recipient's user room receives an in-app toast.

Realtime payloads contain identifiers, the committed resulting version, audit cursor, event type, and minimal display text. They are never authoritative incident state. The browser refetches active REST resources after an event and after every connection or reconnection, while timeline synchronization resumes after its last audit cursor. This makes missed Redis Pub/Sub messages and reconnect gaps converge to PostgreSQL state without polling.

## Pending decisions

Asynchronous summaries and multi-architecture deployment details will be documented in the milestones that introduce them.
