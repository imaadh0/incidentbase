# Operations

## Service health

API liveness and readiness endpoints are exposed separately. Liveness reports whether the process event loop is serving requests; readiness additionally checks required dependencies as they are introduced.

## Shutdown

API and worker processes handle `SIGINT` and `SIGTERM`. They stop accepting new work, close owned resources, flush telemetry, and exit. A forced timeout prevents a deployment from waiting indefinitely.

## Secrets

Production secrets live in a VPS-side environment file or GitHub Actions secrets. They must never be committed, embedded in images, or included in logs.

## Database migrations and roles

Run Prisma migrations with `DATABASE_MIGRATION_URL` and a dedicated migration login. The initial tenancy migration creates two group roles:

- `incidentbase_schema_owner` owns database objects and is never used by a running service.
- `incidentbase_runtime` is `NOLOGIN`, `NOBYPASSRLS`, and owns no tables.

Create a deployment-specific application login through the database operator, set its password through the operator's secret channel, and grant only the runtime group:

```sql
CREATE ROLE incidentbase_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT incidentbase_runtime TO incidentbase_app;
```

Do not grant `incidentbase_schema_owner` to an application login. Set `DATABASE_URL` to the application login and reserve `DATABASE_MIGRATION_URL` for deployment migrations. Future hand-authored migrations must create application objects as `incidentbase_schema_owner` so runtime roles never become owners.

For local isolation tests, start PostgreSQL with the test-only override:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres
```

The one-shot `migrate` service applies migrations with `DATABASE_MIGRATION_URL`, then creates or
updates the login role encoded in `DATABASE_URL`. That login is forced to remain non-superuser,
`NOBYPASSRLS`, and a member of `incidentbase_runtime`; API containers receive only `DATABASE_URL`.

Create separate repository and API test databases and apply the migration history to each. Set
`DATABASE_TEST_URL` and `API_TEST_DATABASE_URL` to the migration/fixture login, provision the runtime
role in the API test database, and set `API_TEST_RUNTIME_DATABASE_URL` to that restricted login. CI
performs these steps and will not skip the database isolation suites.

## External notification configuration

Set the same 64-character hexadecimal `NOTIFICATION_ENCRYPTION_KEY` on API and worker. The Compose fallback is for local development only; production deployments must override it with a randomly generated secret. Set `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` on the worker to enable email delivery, then enable email in an organization's notification settings. Slack and Discord webhook URLs are entered through the Owner/Admin API, encrypted at rest, and never returned. The worker needs outbound HTTPS access to Resend and approved webhook hosts. Changing the encryption key without re-encrypting existing webhook secrets will disable those channels.

The settings, test, and delivery-status endpoints are under `/api/v1/organizations/:organizationId/notification-settings`, `/notification-settings/test`, and `/notification-deliveries`. Test requests are limited to five per organization per hour. Delivery rows record bounded retries and sanitized provider errors. A webhook may be delivered twice if a worker crashes after provider acceptance but before the database acknowledges success; Resend email uses a stable idempotency key.

## Incident AI summaries

Set `GROQ_API_KEY` on the worker to generate summaries after incident resolution. `GROQ_MODEL` defaults to `llama-3.3-70b-versatile`; `GROQ_TIMEOUT_MS` and `SUMMARY_INTERVAL_MS` control request timeout and worker polling. The API returns summary history at `GET /api/v1/organizations/:organizationId/incidents/:incidentId/summaries` for active members. Summary generation never delays resolution. A missing key or two failed attempts leaves a visible `UNAVAILABLE` result, and reopening keeps the previous generation's summary. Provider response bodies and prompt contents are not logged.

## Administration and request limits

Owners and Admins can manage members, policy revisions/defaults, and notification settings in the browser's Administration section. The organization audit explorer at `GET /api/v1/organizations/:organizationId/audit-logs?after=<cursor>&limit=50` is also restricted to active Owners/Admins and returns only public audit fields. Invitation links are one-time credentials: share them privately, and sign in with the invited email address before accepting them.

The API uses Redis sliding windows for sign-in (10/IP/15 minutes), incident creation (10/member/minute), and incident commands (30/member/minute). Responses exceeding a limit are `429` with `Retry-After`. A Redis outage makes sign-in temporarily unavailable (`503`) but does not prevent already-authenticated incident operations. Set `TRUST_PROXY_HOPS` to the number of trusted reverse proxies between the client and API (one for the supplied Nginx Compose layout). Do not expose the API container directly to untrusted networks with this setting.

The API `/health/ready` checks both PostgreSQL and Redis. The worker serves internal liveness, readiness, and token-protected metrics on port 4001; Compose checks its readiness without exposing that port publicly. API metrics include HTTP latency, active sockets, and rate-limit outcomes. Worker metrics include queue depth, failed jobs, successful escalation delay, and aggregate provider outcomes. Set the same `METRICS_TOKEN` on API and worker. Both services export OpenTelemetry traces when `OTEL_ENABLED=true`; provider credentials and incident prompts remain outside logs.

## Web build output

Local Windows builds use `NEXT_OUTPUT_MODE=default` because standalone tracing requires symlink privileges. Container builds set the validated value to `standalone` for a minimal production runtime image.

## Deployment prerequisites

The production GitHub environment requires `VPS_HOST`, `VPS_USER`, `VPS_APP_PATH`, `VPS_SSH_KEY`, and a pinned `VPS_KNOWN_HOSTS` entry. The VPS keeps its own Compose environment file and must already be authenticated to GHCR when images are private.

SSH deployment is disabled until the repository variable `DEPLOY_ENABLED` is explicitly set to `true`. Image builds and publication remain active, allowing CI and GHCR to be verified before VPS credentials are configured.

The deploy workflow runs database/Redis integration tests and a production build before publishing images. It then fast-forwards the VPS checkout, selects images by the exact commit SHA, applies the one-shot migration before starting API/worker, waits for Compose health, and checks the Nginx-routed API readiness and web page. The fast-forward step deliberately fails if the VPS checkout has diverged; reconcile it manually instead of overwriting local deployment changes.

The default Nginx configuration serves HTTP for local development. For production, place a valid certificate chain and private key at `infra/nginx/certs/fullchain.pem` and `infra/nginx/certs/privkey.pem` on the VPS, set `COMPOSE_FILE=docker-compose.yml:docker-compose.tls.yml` in the VPS `.env`, set `WEB_ORIGIN` to the HTTPS origin, and set `COOKIE_SECURE=true`. The TLS override exposes port 443, redirects port 80 to HTTPS, and enables HSTS. Certificate issuance and renewal remain operator actions requiring DNS/VPS control; do not commit those files. Verify the public hostname and certificate after deployment.
