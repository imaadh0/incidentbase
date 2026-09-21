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

Create separate repository and API test databases, apply the migration history to each, and set `DATABASE_TEST_URL` and `API_TEST_DATABASE_URL`. CI performs these steps and will not skip the database isolation suites.

## Web build output

Local Windows builds use `NEXT_OUTPUT_MODE=default` because standalone tracing requires symlink privileges. Container builds set the validated value to `standalone` for a minimal production runtime image.

## Deployment prerequisites

The production GitHub environment requires `VPS_HOST`, `VPS_USER`, `VPS_APP_PATH`, `VPS_SSH_KEY`, and a pinned `VPS_KNOWN_HOSTS` entry. The VPS keeps its own Compose environment file and must already be authenticated to GHCR when images are private.

SSH deployment is disabled until the repository variable `DEPLOY_ENABLED` is explicitly set to `true`. Image builds and publication remain active, allowing CI and GHCR to be verified before VPS credentials are configured.

The current Nginx configuration serves HTTP. Add the production hostname and mounted TLS certificate paths before exposing port 443; certificate issuance remains an operator action because it requires control of DNS and the VPS.
