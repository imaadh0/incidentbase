> Recovered from the confirmed Codex plan session on 2026-09-21. This is the original plan, not a current status report.

# IncidentBase Implementation Plan — Full Architecture First

## 1. Architecture and Delivery Strategy

Build a TypeScript monorepo with:

- Next.js App Router frontend
- Express REST API and Socket.io server
- Separate BullMQ worker
- PostgreSQL with Prisma
- Redis for queues, rate limiting, and Socket.io
- Shared Zod contracts and RBAC policies
- Nginx as the public entry point
- Docker images for `linux/amd64` and `linux/arm64`

Use custom email/password authentication with Argon2id, short-lived JWT access tokens, rotating refresh tokens, Secure HttpOnly cookies, and CSRF protection.

The selected delivery profile is **full architecture first**. The following complexity is acknowledged and accepted:

- Prisma plus PostgreSQL RLS is the largest early implementation cost because every tenant query must use a correctly scoped transaction.
- Full OpenTelemetry adds infrastructure and debugging work before product features.
- Multi-architecture Docker builds primarily increase CI duration and native-dependency verification.

These components will not be removed or postponed past the vertical slice. They will be introduced in the foundation and tenant-boundary milestones so later features are built on the production architecture rather than retrofitted.

## 2. Engineering Standards

### Module design

- Keep controllers limited to HTTP translation.
- Put business behavior in focused application services.
- Keep Prisma access in repositories that require explicit tenant context.
- Put BullMQ orchestration, job processors, and provider clients in separate modules.
- Separate validation schemas, authorization policies, state transitions, and transport DTOs.
- Split modules when they acquire unrelated responsibilities; avoid generic utility or service god-files.

Expected API flow:

```text
Route → Zod validation → authentication → tenant/RBAC policy
      → application service → repository/unit of work
      → audit + outbox → response
```

### Error handling

- Validate environment variables at process startup with Zod and fail before opening ports or consuming jobs.
- Validate route parameters, query strings, bodies, cookies, webhook configuration, queue payloads, and external API responses.
- Use typed application errors mapped by centralized Express error middleware.
- Explicitly catch and classify PostgreSQL, Redis, BullMQ, Resend, Groq, Slack, and Discord failures.
- Await or intentionally supervise every promise.
- Top-level process handlers log fatal context, stop accepting work, close HTTP/Socket/queue/database connections, and exit through a controlled shutdown instead of continuing in an unknown state.
- Worker jobs throw classified retryable or permanent errors so BullMQ retry behavior is deliberate.
- Never expose internal errors, SQL details, tokens, or provider payloads to clients.

### Commit discipline

Initialize Git before implementation and make small Conventional Commit-style commits. A commit must contain one coherent change and its relevant tests/documentation.

Examples:

```text
chore(repo): initialize pnpm workspace and strict typescript
feat(db): add organization membership schema
feat(auth): rotate refresh token families
test(tenancy): reject cross-organization incident access
feat(incidents): enforce acknowledge transition
feat(worker): make escalation processing idempotent
docs(architecture): record optimistic concurrency decision
fix(socket): resync incident queries after reconnect
```

Do not combine an entire milestone into one commit. Keep the tree buildable and tests passing at each commit unless a clearly marked temporary scaffolding commit is unavoidable.

### Documentation

Maintain `DECISIONS.md` with short Architecture Decision Records covering:

- Monorepo and service boundaries
- Custom JWT authentication
- Explicit tenant context and PostgreSQL RLS
- Composite tenant foreign keys
- Optimistic concurrency for user commands
- Row locking for background jobs
- Transactional outbox
- Immutable escalation policy revisions
- Audit-log immutability
- Socket events as invalidation hints
- Asynchronous AI summaries
- Multi-architecture deployment

Comments in code should explain invariants and non-obvious safety decisions, not restate syntax.

## 3. Repository Structure

```text
IncidentBase/
├── apps/
│   ├── web/                    # Next.js dashboard
│   ├── api/                    # Express REST API and Socket.io
│   └── worker/                 # BullMQ processors and schedulers
├── packages/
│   ├── database/               # Prisma, migrations, tenant unit of work
│   ├── contracts/              # Zod API/job/event schemas and OpenAPI
│   ├── authorization/          # RBAC policies and permission matrix
│   ├── auth/                   # Password, JWT, refresh, cookie, CSRF logic
│   ├── observability/          # Pino, OpenTelemetry, Prometheus helpers
│   ├── config/                 # Zod-validated environment configuration
│   └── test-utils/             # Factories, fixtures, infrastructure helpers
├── tests/
│   └── e2e/                    # Playwright critical flows
├── infra/
│   ├── nginx/
│   ├── prometheus/
│   └── grafana/
├── docker/
│   └── Dockerfile              # Multi-stage service targets
├── docs/
│   ├── architecture.md
│   └── operations.md
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
├── DECISIONS.md
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

Use pnpm workspaces and Turborepo. Applications may depend on shared packages, but shared packages must never import application code.

## 4. Data Model and Tenant Isolation

### Identity and tenancy

- `users`: global ID, normalized unique email, password hash, name, verification and timestamps.
- `organizations`: ID, name, unique slug, default policy ID and timestamps.
- `organization_memberships`: organization, user, role, status and joined timestamp; unique per organization/user.
- `organization_invitations`: organization, email, role, hashed single-use token, inviter, expiry and acceptance.
- `refresh_sessions`: user, hashed refresh token, token family, expiry, rotation and revocation metadata.

Roles are `OWNER`, `ADMIN`, `RESPONDER`, and `REPORTER`. Membership status is `INVITED`, `ACTIVE`, or `SUSPENDED`. Database/application rules ensure an organization always retains an active Owner.

### Escalation policies

- `escalation_policies`: organization, name, description, active revision and archived timestamp.
- `escalation_policy_versions`: organization, policy, revision and activation timestamp.
- `escalation_policy_steps`: organization, version, ordered position, responder membership and wait duration.

Activating an edit creates an immutable policy revision. Active incidents retain the revision with which they were created.

### Incidents

- `incidents`
  - Organization and public reference number.
  - Title, description and `SEV1`–`SEV4` severity.
  - Status: `OPEN`, `ACKNOWLEDGED`, `INVESTIGATING`, `RESOLVED`.
  - Reporter and assigned membership.
  - Policy revision and current escalation step.
  - Escalation generation, next deadline, first escalation and exhaustion timestamps.
  - Acknowledged, investigating and resolved timestamps.
  - Optimistic concurrency `version`.
  - Creation/update timestamps.

- `incident_summaries`
  - Organization, incident, lifecycle generation, status, text, model, attempts, error category and timestamps.
  - Status: `PENDING`, `COMPLETED`, `UNAVAILABLE`.
  - Unique per incident/generation so reopening does not destroy an earlier summary.

### Reliability and audit

- `audit_logs`
  - Organization, optional incident, optional actor membership, system/user actor type, action, metadata and timestamp.
  - Monotonic bigint ID used as a cursor.
  - Runtime roles receive insert/select only.
  - Database trigger rejects updates and deletes.

- `outbox_events`
  - Organization, aggregate, event type, payload, deterministic deduplication key, processing state and attempts.
  - Inserted in the same transaction as business state and audit records.

- `notification_settings`
  - Organization, channel preferences and encrypted Slack/Discord webhook configuration.

- `notification_deliveries`
  - Event, recipient, channel, provider ID, status, attempts and last error.
  - Unique deterministic delivery key.

- `idempotency_keys`
  - Organization, membership, key, request hash, stored result and expiry.

### Defense-in-depth tenancy

- Every tenant-owned row includes `organization_id`.
- Composite foreign keys include `organization_id`, preventing cross-tenant relationships.
- PostgreSQL RLS is enabled and forced on all tenant tables.
- API operations use a tenant-scoped Prisma interactive transaction that applies user and organization context with `SET LOCAL`.
- Worker operations use a separate restricted service role and explicit organization context.
- Runtime roles have neither table ownership nor `BYPASSRLS`.
- Prisma migrations contain reviewed raw SQL for RLS policies, append-only triggers and database constraints.
- Repository interfaces require tenant context, making an unscoped tenant query difficult to express.
- Tenant identifiers come from validated route/job context, never from an arbitrary body field.

## 5. Lifecycle, Escalation, and Concurrency

Valid transitions:

```text
OPEN → ACKNOWLEDGED → INVESTIGATING → RESOLVED
RESOLVED → OPEN only through reopen
```

- Escalation is a parallel condition, not a lifecycle status.
- The assigned active responder may perform normal transitions.
- Owners/Admins may act on any incident as an explicitly recorded override.
- Reporters cannot acknowledge, investigate, resolve, reassign, or reopen.
- Reopen is Owner/Admin-only, increments the generation, resets lifecycle state, and restarts the original policy revision.
- Manual reassignment increments the generation, gives the selected responder a fresh acknowledgement window, then resumes the snapshotted policy from step zero.
- Inactive responders in a snapshot are skipped with an audit event.
- Chain exhaustion leaves the final responder assigned and notifies Owners/Admins once.

Incident commands require `If-Match: "<version>"`. Conditional updates include organization, incident, expected version, expected status and expected assignee where appropriate. Conflicts return `409` with current state.

The incident mutation, version increment, audit entry and outbox event commit atomically.

Escalation jobs carry organization, incident, generation, expected step and expected deadline. The worker locks/checks the incident in a transaction and exits harmlessly if any value is stale. Deterministic audit/outbox/job keys prevent double escalation.

A recurring reconciliation job re-enqueues missing overdue escalation work.

## 6. API and Permissions

Every organization route requires an active membership in its explicit organization path.

### Authentication

- `POST /api/v1/auth/register` — public; creates user, organization and Owner membership.
- `POST /api/v1/auth/login` — public and IP-rate-limited.
- `POST /api/v1/auth/refresh` — rotate refresh token.
- `POST /api/v1/auth/logout` — revoke current session.
- `POST /api/v1/auth/logout-all` — revoke all sessions.
- `GET /api/v1/auth/me` — current user and memberships.

### Organizations and members

- `GET /api/v1/organizations` — authenticated user’s organizations.
- `POST /api/v1/organizations` — authenticated.
- `GET /api/v1/organizations/:orgId` — any member.
- `PATCH /api/v1/organizations/:orgId` — Owner/Admin.
- `GET /api/v1/organizations/:orgId/members` — any member; limited profile fields.
- `POST /api/v1/organizations/:orgId/invitations` — Owner/Admin.
- `POST /api/v1/invitations/:token/accept` — authenticated matching email.
- `PATCH/DELETE /api/v1/organizations/:orgId/members/:membershipId` — Owner/Admin.
- Admins cannot manage Owners; the last Owner cannot be removed or demoted.

### Incidents

- `GET/POST /api/v1/organizations/:orgId/incidents` — any member.
- `GET /api/v1/organizations/:orgId/incidents/:incidentId` — any member.
- `PATCH .../:incidentId` — Owner/Admin for descriptive fields.
- `POST .../:incidentId/acknowledge` — assignee or Owner/Admin override.
- `POST .../:incidentId/start-investigation` — assignee or Owner/Admin override.
- `POST .../:incidentId/resolve` — assignee or Owner/Admin override.
- `POST .../:incidentId/reopen` — Owner/Admin.
- `POST .../:incidentId/reassign` — Owner/Admin.
- `GET .../:incidentId/timeline` — any member; audit-cursor pagination.
- `GET .../:incidentId/summaries` — any member.

### Policies, settings, and audit

- Policy reads — any member.
- Policy create, revision, archive and default selection — Owner/Admin.
- Notification settings read/write/test — Owner/Admin.
- Organization-wide audit and delivery explorer — Owner/Admin.

Shared Zod schemas validate every parameter, query, body, response boundary, queue payload and Socket.io event. The same schemas generate OpenAPI documentation and frontend types.

## 7. Notifications, AI, and Real-Time Updates

### Notifications

Assignments and escalations create:

- A user-room Socket.io toast
- A Resend email
- Optional organization Slack/Discord webhook deliveries

All external delivery happens in the worker. Deterministic delivery keys, persisted attempts and classified retry policies prevent duplicates. Webhook secrets use AES-GCM encryption and approved Slack/Discord host allowlists.

### AI summaries

Resolution commits immediately and emits a summary outbox event. The worker submits the bounded audit timeline to Groq using configurable `GROQ_MODEL`, initially `llama-3.3-70b-versatile`.

The job runs at most twice. Final failure marks the summary `UNAVAILABLE` and never changes incident resolution.

### Socket.io

- Authenticate handshake cookies and revalidate membership before room joins.
- Use `organization:{id}` and `user:{id}` rooms with the Redis adapter.
- Publish only committed outbox events.
- Include resource ID, resulting version, audit cursor, event type and minimal display data.
- Treat events as invalidation hints rather than authoritative state.
- On connect/reconnect, refetch active REST queries and retrieve timeline records after the last audit cursor.

## 8. Security, Configuration, and Observability

### Rate limits

- Login: 10/IP/15 minutes.
- Incident creation: 10/membership/minute.
- Incident commands: 30/membership/minute.
- Test notifications: 5/organization/hour.

Use Redis-backed sliding windows and standard `429` responses.

### Configuration

Each deployable service owns a Zod environment schema and validates it before initialization. No environment-specific URL, credential, timeout, model, port, or feature flag is hard-coded.

Provide committed `.env.example` files containing names and safe documentation only.

### Security controls

- Helmet, request-size limits, secure cookies, CSRF checks and production same-origin CORS.
- Argon2id password hashing and constant-time token comparisons.
- Refresh-token reuse detection.
- Sensitive-field redaction in logs.
- No passwords, JWTs, invitations, provider keys, full webhook URLs, or incident prompt bodies in logs.

### Observability

- Pino JSON logs with request, trace, organization, membership, incident and job IDs.
- OpenTelemetry for HTTP, PostgreSQL, Redis, BullMQ and external provider calls.
- Prometheus metrics for HTTP latency/status, sockets, queue depth, job failures, escalation delay and provider outcomes.
- `/health/live`, `/health/ready` and protected `/metrics`.
- Optional local Prometheus/Grafana Compose profile.
- API and worker graceful shutdown paths are covered by tests where practical.

## 9. Docker, CI, and Deployment

Compose services:

- `nginx`
- `web`
- `api`
- `worker`
- `migrate`
- `postgres`
- `redis`
- Optional `prometheus` and `grafana`

Use multi-stage non-root Debian slim Node images. PostgreSQL and Redis are not publicly exposed in production. Redis uses AOF persistence.

CI on every PR:

- Frozen dependency install
- Formatting check, lint and typecheck
- Prisma validation and migration checks
- Unit and integration tests with PostgreSQL/Redis
- Production application builds
- Multi-stage Docker builds
- Playwright critical-flow tests

Main-branch deployment:

- Build with Docker Buildx for `linux/amd64,linux/arm64`.
- Push web, API, worker and migration targets to GHCR using SHA and `main` tags.
- SSH to the Oracle VPS.
- Run `docker compose pull && docker compose up -d`.
- Compose runs migrations before API/worker startup.
- Run readiness checks and report failed container health.
- Keep SHA tags for rollback and require migrations compatible with the immediately preceding application image.

## 10. Build Order, Tests, and Commit Boundaries

Tests are written in the same change as behavior, never deferred to a final testing milestone.

1. **Repository and service foundation**
   - Initialize Git, workspace, strict TypeScript, config validation, base services, graceful shutdown and centralized API errors.
   - Add Pino/OpenTelemetry foundations and multi-architecture Docker/CI early.
   - Commit separately by workspace setup, configuration, service bootstrap, observability and containers.

2. **Database tenancy boundary**
   - Add identity/organization schema, composite keys, RLS migrations, tenant unit of work and restricted roles.
   - Add cross-tenant repository/API tests with direct ID guessing and membership suspension.
   - Do not begin incidents until tenant-isolation tests pass.

3. **Authentication and membership**
   - Implement passwords, JWT cookies, CSRF, refresh rotation, invitations and RBAC.
   - Add tests for token reuse, invitation expiry, last-owner invariants and the complete role matrix.

4. **Policies and incident lifecycle**
   - Implement immutable policies, default routing, state machine, optimistic concurrency, audit triggers and outbox.
   - Add transition, stale-version, simultaneous acknowledgement, override and append-only tests alongside each command.

5. **Escalation worker**
   - Implement deterministic delayed jobs, transactional locking, stale-job rejection, inactive responder skipping, exhaustion and reconciliation.
   - Test duplicate jobs, overlapping workers, acknowledgement races and queue recovery.

6. **Frontend and real-time vertical slice**
   - Build authentication, organization selection, incident list/create/detail, lifecycle controls and timeline.
   - Add Socket.io invalidation, toast notifications and reconnect resynchronization.
   - Verify create → assign → escalate → acknowledge → investigate → resolve.

7. **External notifications**
   - Add encrypted settings, Resend, Slack, Discord, delivery persistence and retries.
   - Test each provider through mock servers, including timeouts, malformed responses, retries and duplicate suppression.

8. **AI summaries**
   - Add Groq adapter, bounded prompt construction, summary persistence and unavailable fallback.
   - Test success, timeout, malformed output and final failure without blocking resolution.

9. **Administrative UI and production hardening**
   - Add members, policies, notification settings and audit explorer.
   - Complete rate-limit, observability, Nginx, migration and deployment verification.

10. **End-to-end acceptance**
    - Playwright covers onboarding, invitation, policy setup, incident creation, timed escalation, resolution, summary, authorization denial and reconnect.
    - Use test-only short escalation durations through validated configuration, never production conditionals.

## 11. Mandatory Acceptance Scenarios

- No HTTP, database, Socket.io, audit, job, error, timing, or identifier path leaks cross-tenant information.
- Every role is tested against every incident command.
- Two acknowledgements of one version yield one success and one conflict.
- Acknowledgement racing escalation produces one serialized outcome.
- Repeated/overlapping jobs create one escalation, audit event and notification set.
- Policy edits do not alter active incidents.
- Inactive responders are skipped safely.
- Chain exhaustion alerts administrators once.
- Audit rows cannot be updated or deleted using the runtime database role.
- Socket reconnect converges to current database state.
- Redis/provider failures are explicitly handled and do not corrupt incident state.
- Reopening preserves earlier audit history and summaries.
- Missing or invalid configuration prevents startup with a clear, redacted error.
- Both ARM64 and AMD64 images build and pass smoke tests.

## 12. Locked Product Decisions

- Multi-organization membership is included in v1.
- All active members may view organization incidents and their timelines.
- Only Owners/Admins access the organization-wide audit explorer.
- Reporters use the organization’s default escalation policy.
- Owners/Admins may perform audited operational overrides.
- Policy revisions remain immutable for active incidents.
- The chain stops at its final responder and alerts Owners/Admins.
- Only Owners/Admins may reopen incidents.
- Membership onboarding uses email invitations.
- Prisma is used with PostgreSQL RLS, constraints, locks and triggers.
- Authentication is custom email/password JWT, not Auth.js.
- Full RLS, OpenTelemetry and multi-architecture builds are implemented from the beginning despite their delivery cost.
- Billing, phone paging, mobile push and a marketing site remain out of scope.
